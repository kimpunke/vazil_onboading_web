from fastapi import FastAPI, HTTPException, Query
import os
import asyncio
from datetime import datetime
from pathlib import Path
import json
import websockets
from typing import Any, Dict, List, Optional

app = FastAPI()

REMOTE_WS_URL = os.getenv("REMOTE_WS_URL", "").strip()
REMOTE_WS_TOKEN = os.getenv("REMOTE_WS_TOKEN", "").strip()

_remote_lock = asyncio.Lock()

async def _remote_run_pipeline(input_sel: str = "dummy") -> dict:
    if not REMOTE_WS_URL:
        raise HTTPException(status_code=500, detail="REMOTE_WS_URL is not set")

    async with websockets.connect(REMOTE_WS_URL) as ws:
        # (옵션) 토큰 인증: server.py가 WS_TOKEN 요구하는 경우
        if REMOTE_WS_TOKEN:
            await ws.send(json.dumps({"type": "AUTH", "token": REMOTE_WS_TOKEN}))

        await ws.send(json.dumps({"type": "RUN_PIPELINE", "input" : input_sel}))

        # OUTPUT_SNAPSHOT 올 때까지 대기
        while True:
            msg = await ws.recv()
            if isinstance(msg, (bytes, bytearray)):
                msg = msg.decode("utf-8", errors="replace")
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue


            if data.get("type") == "OUTPUT_SNAPSHOT":
                return data

            # 에러를 명시적으로 던지는 타입이 있다면 처리(서버 구현에 따라)
            if data.get("type") == "ERROR":
                raise HTTPException(status_code=502, detail=data.get("message", "remote error"))


async def _remote_get_ingest_status() -> dict:
    if not REMOTE_WS_URL:
        raise HTTPException(status_code=500, detail="REMOTE_WS_URL is not set")

    async with websockets.connect(REMOTE_WS_URL) as ws:
        if REMOTE_WS_TOKEN:
            await ws.send(json.dumps({"type": "AUTH", "token": REMOTE_WS_TOKEN}))

        await ws.send(json.dumps({"type": "GET_INGEST_STATUS"}))

        # INGEST_STATUS 올 때까지 대기
        while True:
            msg = await ws.recv()
            if isinstance(msg, (bytes, bytearray)):
                msg = msg.decode("utf-8", errors="replace")
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue


            if data.get("type") == "INGEST_STATUS":
                return data

            if data.get("type") == "ERROR":
                raise HTTPException(status_code=502, detail=data.get("message", "remote error"))


RUNS_DIR = Path("/data/runs")


async def _remote_get_output_snapshot() -> dict:
    if not REMOTE_WS_URL:
        raise HTTPException(status_code=500, detail="REMOTE_WS_URL is not set")

    async with websockets.connect(REMOTE_WS_URL) as ws:
        if REMOTE_WS_TOKEN:
            await ws.send(json.dumps({"type": "AUTH", "token": REMOTE_WS_TOKEN}))

        await ws.send(json.dumps({"type": "GET_OUTPUT"}))

        while True:
            msg = await ws.recv()
            if isinstance(msg, (bytes, bytearray)):
                msg = msg.decode("utf-8", errors="replace")
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue

            if data.get("type") == "OUTPUT_SNAPSHOT":
                return data

            if data.get("type") == "ERROR":
                raise HTTPException(status_code=502, detail=data.get("message", "remote error"))


async def _remote_plc_control(cmd: str) -> dict:
    if not REMOTE_WS_URL:
        raise HTTPException(status_code=500, detail="REMOTE_WS_URL is not set")

    async with websockets.connect(REMOTE_WS_URL) as ws:
        if REMOTE_WS_TOKEN:
            await ws.send(json.dumps({"type": "AUTH", "token": REMOTE_WS_TOKEN}))

        await ws.send(json.dumps({"type": cmd}))

        while True:
            msg = await ws.recv()
            if isinstance(msg, (bytes, bytearray)):
                msg = msg.decode("utf-8", errors="replace")
            try:
                data = json.loads(msg)
            except json.JSONDecodeError:
                continue

            if data.get("type") == "PLC_STATUS":
                return data

            if data.get("type") == "ERROR":
                raise HTTPException(status_code=502, detail=data.get("message", "remote error"))



def _save_snapshot(run_id: str, summary: dict, final_jsonl: str, fail_jsonl: str) -> None:
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    (run_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    (run_dir / "final_results.jsonl").write_text(final_jsonl or "", encoding="utf-8")
    (run_dir / "fail_data.jsonl").write_text(fail_jsonl or "", encoding="utf-8")


@app.post("/api/remote/run")
async def remote_run_and_sync(input: str = Query("dummy")):
    # 동시 실행 방지
    if _remote_lock.locked():
        raise HTTPException(status_code=409, detail="remote run already in progress")

    async with _remote_lock:
        input_sel = "live" if input == "live" else "dummy"
        snap = await _remote_run_pipeline(input_sel)

        run_id = snap.get("runId")
        if not isinstance(run_id, str) or not run_id.strip():
            # runId가 비정상이면 서버측 snapshot 포맷 문제
            raise HTTPException(status_code=502, detail="invalid OUTPUT_SNAPSHOT: missing runId")

        summary = snap.get("summary")
        if not isinstance(summary, dict):
            summary = {}

        final_jsonl = snap.get("final_results_jsonl")
        fail_jsonl = snap.get("fail_data_jsonl")
        meta = snap.get("meta") if isinstance(snap.get("meta"), dict) else {}

        if not isinstance(final_jsonl, str):
            final_jsonl = ""
        if not isinstance(fail_jsonl, str):
            fail_jsonl = ""

        _save_snapshot(run_id.strip(), summary, final_jsonl, fail_jsonl)
        # ✅ meta도 같이 저장 (디버깅 핵심)
        (run_dir := (RUNS_DIR / run_id.strip())).mkdir(parents=True, exist_ok=True)
        (run_dir / "remote_meta.json").write_text(
            json.dumps(meta, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

        # ✅ 응답에도 meta 일부 포함 (UI에서 바로 확인 가능)
        return {
            "run_id": run_id.strip(),
            "client_exit_code": meta.get("client_exit_code"),
            "meta" : meta,
        }


@app.get("/api/realtime/status")
async def realtime_status():
    # 단순 상태 조회는 락 없이 허용(폴링)
    # (REMOTE_WS_URL 미설정이면 _remote_get_ingest_status()에서 500 처리)
    return await _remote_get_ingest_status()

@app.get("/api/realtime/summary")
async def realtime_summary():
    snap = await _remote_get_output_snapshot()
    summary = snap.get("summary") or {}
    return summary

@app.post("/api/realtime/start")
async def realtime_start():
    return await _remote_plc_control("PLC_START")


@app.post("/api/realtime/stop")
async def realtime_stop():
    return await _remote_plc_control("PLC_STOP")






@app.get("/api/runs")
def list_runs():
    if not RUNS_DIR.exists():
        return []
    runs = [p for p in RUNS_DIR.iterdir() if p.is_dir()]
    runs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return [p.name for p in runs]


@app.get("/api/runs/{run_id}/summary")
def get_summary(run_id: str):
    summary_path = RUNS_DIR / run_id / "summary.json"
    if not summary_path.exists():
        raise HTTPException(status_code=404, detail="summary.json not found")

    try:
        return json.loads(summary_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="summary.json is not valid JSON")


# ✅ Fail Explorer: fail_data.jsonl 조회 API 추가
@app.get("/api/runs/{run_id}/fails")
def get_fails(
    run_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=5000),
    stage: Optional[str] = None,
    code: Optional[str] = None,
    q: Optional[str] = None,
):
    fail_path = RUNS_DIR / run_id / "fail_data.jsonl"
    if not fail_path.exists():
        raise HTTPException(status_code=404, detail="fail_data.jsonl not found")

    q_norm = (q or "").strip().lower()
    stage_norm = (stage or "").strip()
    code_norm = (code or "").strip()

    items: List[Dict[str, Any]] = []
    total = 0

    try:
        with fail_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    # jsonl 한 줄이 깨졌으면 그 줄은 스킵(대시보드가 죽지 않게)
                    continue

                # 1) stage 필터
                if stage_norm and rec.get("stage") != stage_norm:
                    continue

                # 2) code 필터 (errors[].code 중 하나라도 "부분/대소문자 무시" 매칭되면 통과)
                if code_norm:
                    want = code_norm.lower()
                    errs = rec.get("errors", [])
                    ok = False
                    if isinstance(errs, list):
                        for e in errs:
                            if not isinstance(e, dict):
                                continue
                            c = e.get("code")
                            if isinstance(c, str) and want in c.lower():
                                ok = True
                                break
                    if not ok:
                        continue


                # 3) q 검색 (recordId/rawRecordId/stage/errors.message 중심)
                if q_norm:
                    blob_parts: List[str] = []
                    for k in ("recordId", "rawRecordId", "stage"):
                        v = rec.get(k)
                        if isinstance(v, str):
                            blob_parts.append(v)

                    errs = rec.get("errors", [])
                    if isinstance(errs, list):
                        for e in errs:
                            if isinstance(e, dict):
                                m = e.get("message")
                                if isinstance(m, str):
                                    blob_parts.append(m)

                    blob = " | ".join(blob_parts).lower()
                    if q_norm not in blob:
                        continue

                # 여기까지 왔으면 필터 통과
                if total >= offset and len(items) < limit:
                    items.append(rec)
                total += 1

    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to read fail_data.jsonl: {e}")

    return {
        "run_id": run_id,
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": items,
    }


# ✅ Pass Explorer: final_results.jsonl 조회 API 추가
@app.get("/api/runs/{run_id}/passes")
def get_passes(
    run_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=5000),
    q: Optional[str] = None,
):
    pass_path = RUNS_DIR / run_id / "final_results.jsonl"
    if not pass_path.exists():
        raise HTTPException(status_code=404, detail="final_results.jsonl not found")

    q_norm = (q or "").strip().lower()

    items: List[Dict[str, Any]] = []
    total = 0

    def _event_types(rec: Dict[str, Any]) -> List[str]:
        ev = rec.get("events")
        if not isinstance(ev, list):
            return []
        out: List[str] = []
        for e in ev:
            if isinstance(e, dict):
                t = e.get("eventType")
                if isinstance(t, str):
                    out.append(t)
        return out

    try:
        with pass_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # q 검색 (샘플 기준): rawRecordId/seq/equipmentId/productType/ts/eventType
                if q_norm:
                    ctx = rec.get("context") if isinstance(rec.get("context"), dict) else {}
                    blob_parts: List[str] = []

                    raw_record_id = ctx.get("rawRecordId")
                    if isinstance(raw_record_id, str):
                        blob_parts.append(raw_record_id)

                    seq = ctx.get("seq")
                    if seq is not None:
                        blob_parts.append(str(seq))

                    eq = ctx.get("equipmentId")
                    if isinstance(eq, str):
                        blob_parts.append(eq)

                    pt = ctx.get("productType")
                    if isinstance(pt, str):
                        blob_parts.append(pt)

                    ts = ctx.get("ts")
                    if isinstance(ts, str):
                        blob_parts.append(ts)

                    blob_parts.extend(_event_types(rec))

                    blob = " | ".join(blob_parts).lower()
                    if q_norm not in blob:
                        continue

                if total >= offset and len(items) < limit:
                    items.append(rec)
                total += 1

    except OSError as e:
        raise HTTPException(status_code=500, detail=f"failed to read final_results.jsonl: {e}")

    return {
        "run_id": run_id,
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": items,
    }
