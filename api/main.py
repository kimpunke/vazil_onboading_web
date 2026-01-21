from fastapi import FastAPI, HTTPException, Query
from pathlib import Path
import json
from typing import Any, Dict, List, Optional

app = FastAPI()

RUNS_DIR = Path("/data/runs")

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
