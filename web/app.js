const $ = (id) => document.getElementById(id);
const API_BASE = (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === "string")
  ? window.APP_CONFIG.API_BASE
  : "";

let pieChart = null;
let explorerMode = "FAIL"; // FAIL OR PASS
let failOffset = 0;
  
const REALTIME_RUN_ID = "__REALTIME__";
let realtimeTimer = null;
let lastIngestTotalWritten = null;
let lastIngestTotalDropped = null;
let lastIngestTickMs = null;

let lastRealtimeSummaryFetchMs = 0;
const REALTIME_SUMMARY_POLL_MS = 2000;

const INGEST_WINDOW = 10; // 최근 N번 폴링(막대그래프)
let ingestBarChart = null;
let ingestLabels = [];
let ingestDeltaWritten = [];
let ingestDeltaDropped = [];
  
  
let plcRunning = false; // UI 기준 PLC 동작 상태(실제 프로세스 제어는 다음 단계)

const failLimit = 5;
let passOffset = 0;
let lastFailRunId = null;
let selectedFailRow = null;
let activeDetailTab = "errors";


// ✅ Refresh Loop(단일 진입점)용
let activeRunId = null;               // 이번 렌더 사이클 기준 runId(스냅샷 고정)
let explorerPendingRefresh = false;   // 새 데이터 감지 시, 즉시 렌더 대신 배너로 알림
let lastExplorerHeadKey = null;       // 리스트 최상단 레코드 키(변경 감지)
let refreshInFlight = false;


function fmt(n) {
  if (n === null || n === undefined) return "-";
  return new Intl.NumberFormat("ko-KR").format(Number(n));
}

function showError(msg) {
  const box = $("errorBox");
  box.style.display = "block";
  box.textContent = msg;
}
function clearError() {
  const box = $("errorBox");
  box.style.display = "none";
  box.textContent = "";
}
function showLiveBanner() {
  const b = $("liveNewBtn");
  if (!b) return;
  b.style.display = "";
}

function hideLiveBanner() {
  const b = $("liveNewBtn");
  if (!b) return;
  b.style.display = "none";
}




async function fetchJSON(path, options = null) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, { cache: "no-store", ...(options || {}) });

  if (!res.ok) {
    let detail = "";
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j = await res.json();
        detail = (j && (j.detail || j.message)) ? String(j.detail || j.message) : JSON.stringify(j);
      } else {
        detail = await res.text();
      }
    } catch (_) {
      detail = "";
    }
    const extra = detail ? ` - ${detail}` : "";
    throw new Error(`${res.status} ${res.statusText} (${url})${extra}`);
  }

  return await res.json();
}


function normalizeSummary(s) {
  // summary.json 구조(프로젝트 기준)
  // - DATA-STATUS: total/pass/fail/fail_rate
  // - errors: fail 유형별 카운트 (합이 fail과 일치한다고 가정)
  const ds = s["DATA-STATUS"] || {};
  const total = Number(ds.total ?? 0);
  const pass  = Number(ds.pass ?? 0);
  const fail  = Number(ds.fail ?? 0);
  const failRate = (ds.fail_rate !== undefined && ds.fail_rate !== null) ? Number(ds.fail_rate) : null;

  const failBreakdown = s.errors || {}; // { duplicate_error: 11, parse_error: 1, ... }

  return { total, pass, fail, failRate, failBreakdown };
}

function renderFailList(failBreakdown) {
  const el = $("failList");
  el.innerHTML = "";

  const entries = Object.entries(failBreakdown || {})
    .map(([k, v]) => [k, Number(v) || 0])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    el.innerHTML = `<div class="stage-item"><span class="label">fail 통계 없음</span><span class="mono">-</span></div>`;
    return;
  }

  for (const [k, v] of entries) {
    const row = document.createElement("div");
    row.className = "stage-item clickable";
    row.innerHTML = `<b>${k}</b><span class="mono bad">${fmt(v)}</span>`;
  
    row.addEventListener("click", async () => {
      await drillDownFromOverview(k);
    });
  
    el.appendChild(row);
  }  
}

function updateFailCodeDatalist(summary){
  const dl = document.getElementById("failCodeList");
  if (!dl) return;

  // summary.errors는 { duplicate_error: 11, parse_error: 1 ... } 형태임
  // 여기서 "Error Code"와 1:1 매칭이 안 될 수도 있어서,
  // 우선 "자주 쓰는 코드" + "현재 run에서 실제로 존재한 코드"를 합치는 방식이 안정적이다.

  const base = ["DUPLICATE", "REQUIRED", "TYPE", "MIN_ITEMS", "TIME_INVERSION"];
  const uniq = new Set(base);

  // (가능하면) failList keys도 후보로 넣기
  if (summary && summary.errors && typeof summary.errors === "object") {
    Object.keys(summary.errors).forEach(k => uniq.add(String(k).toUpperCase()));
  }

  dl.innerHTML = "";
  [...uniq].sort().forEach(code => {
    const opt = document.createElement("option");
    opt.value = code;
    dl.appendChild(opt);
  });
}



function renderDonutChart(pass, failBreakdown) {
  const failEntries = Object.entries(failBreakdown || {})
    .map(([k, v]) => [k, Number(v) || 0])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  const labels = ["Pass", ...failEntries.map(([k]) => k)];
  const values = [Number(pass) || 0, ...failEntries.map(([, v]) => v)];
  const total = values.reduce((a, b) => a + b, 0);

  // 색상은 원하는대로 늘리면 됨
  const colors = [
    "#22c55e", // Pass
    "#ef4444",
    "#f97316",
    "#eab308",
    "#a855f7",
    "#06b6d4",
    "#f43f5e",
    "#84cc16",
  ].slice(0, values.length);

  const canvas = $("pie");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  // ✅ 최초 1회만 생성
  if (!pieChart) {
    pieChart = new Chart(ctx, {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderColor: "#0e1626",
          borderWidth: 2,
          hoverOffset: 8  // hover 시 살짝 커지게
        }]
      },
      options: {
        onClick: async (evt, elements) => {
          if (!elements || elements.length === 0) return;
          const idx = elements[0].index;
          const label = pieChart?.data?.labels?.[idx];
          if (!label) return;
          await drillDownFromOverview(String(label));
        },
        responsive: false,          // canvas size 고정(정적 페이지에서 안정적)
        cutout: "62%",              // 도넛 구멍 크기
        animation: { duration: 250 },
        plugins: {
          legend: {
            position: "right",
            labels: {
              color: "#e2e8f0",
              boxWidth: 10,
              boxHeight: 10,
              padding: 12
            }
          },
          tooltip: {
            callbacks: {
              label: (context) => {
                // ⚠️ total은 함수 스코프 값이라 업데이트 시점 total로 다시 계산해야 함
                const value = Number(context.raw || 0);
                const t = pieChart?.data?.datasets?.[0]?.data?.reduce((a, b) => Number(a) + Number(b), 0) || 0;
                const pct = t > 0 ? (value / t * 100) : 0;
                return `${context.label}: ${value} (${pct.toFixed(2)}%)`;
              }
            }
          }
        }
      }
    });
    return;
  }

  // ✅ 이후엔 destroy 없이 데이터만 갱신
  pieChart.data.labels = labels;
  pieChart.data.datasets[0].data = values;
  pieChart.data.datasets[0].backgroundColor = colors;

  // 색/데이터만 바뀌므로 애니메이션 없이 깔끔하게
  pieChart.update("none");
}



function presetFailFiltersByType(typeKey) {
  // summary.errors 키 기준: parse_error / duplicate_error / checking_error ...
  const key = String(typeKey || "").toLowerCase();

  // 기본: 전부 비우고 시작
  $("failStage").value = "";
  $("failCode").value = "";
  $("failQuery").value = "";

  if (key === "parse_error") {
    $("failStage").value = "convert";
    $("failCode").value = "TYPE";
    return;
  }
  if (key === "duplicate_error") {
    $("failStage").value = "dedupe";
    $("failCode").value = "DUPLICATE";
    return;
  }
  if (key === "checking_error") {
    $("failStage").value = "checking";
    // checking은 코드가 다양(MIN_ITEMS/REQUIRED/TYPE 등)이라 code는 비워두는 게 보통 더 낫다
    return;
  }

  // 모르는 타입이면 검색(q)로라도 걸리게
  $("failQuery").value = key;
}

async function drillDownFromOverview(label) {
  const runId = $("runSelect").value;

  clearError();
  try {
    // 1) Pass 클릭 → PASS Explorer로
    if (label === "Pass") {
      // PASS 필터 초기화(원하면 유지하게 바꿔도 됨)
      $("passQuery").value = "";
      passOffset = 0;

      setExplorerMode("PASS", { autoLoad: false });
      await loadPasses(runId, { resetOffset: true });
      return;
    }

    // 2) 특정 Fail 타입 클릭 → FAIL Explorer + preset 필터
    setExplorerMode("FAIL", { autoLoad: false });
    presetFailFiltersByType(label);
    await loadFails(runId, { resetOffset: true });
  } catch (e) {
    showError(e.message);
  }
}




function _firstErrorCode(rec) {
  const errs = rec && rec.errors;
  if (Array.isArray(errs) && errs.length > 0 && errs[0] && typeof errs[0] === "object") {
    return errs[0].code || "-";
  }
  return "-";
}
function _firstErrorMessage(rec) {
  const errs = rec && rec.errors;
  if (Array.isArray(errs) && errs.length > 0 && errs[0] && typeof errs[0] === "object") {
    return errs[0].message || "-";
  }
  return "-";
}
function _short(s, n = 120) {
  if (typeof s !== "string") return "-";
  return s.length > n ? (s.slice(0, n) + "…") : s;
}
function codeClass(code){
  const c = String(code || "").toUpperCase();
  if (c.includes("DUPLICATE")) return "code-dup";
  if (c.includes("REQUIRED")) return "code-req";
  if (c.includes("TYPE")) return "code-type";
  if (c.includes("TIME_INVERSION")) return "code-time";
  return "code-other";
}

function pretty(obj){
  try { return JSON.stringify(obj, null, 2); }
  catch { return String(obj); }
}

function setActiveTab(tab){
  activeDetailTab = tab;

  $("tabErrors").classList.toggle("active", tab === "errors");
  $("tabContext").classList.toggle("active", tab === "context");
  $("tabRaw").classList.toggle("active", tab === "raw");

  $("failDetailErrors").style.display = tab === "errors" ? "block" : "none";
  $("failDetailContext").style.display = tab === "context" ? "block" : "none";
  $("failDetailRaw").style.display = tab === "raw" ? "block" : "none";
}

function setExplorerMode(mode, { autoLoad = true } = {}) {
  explorerMode = mode;

  // 헤더 텍스트/뱃지
  $("explorerTitle").textContent = (mode === "FAIL") ? "Fail Explorer" : "Pass Explorer";
  $("explorerModePill").textContent = mode;

  // 필터 토글
  $("failFilters").style.display = (mode === "FAIL") ? "flex" : "none";
  $("passFilters").style.display = (mode === "PASS") ? "flex" : "none";

  // Explorer 안내 문구(모드별)
  if (mode === "FAIL") {
    $("explorerHelp").textContent = "fail_data.jsonl을 필터/검색해서 개별 실패 레코드를 확인합니다.";
  } else {
    $("explorerHelp").textContent = "final_results.jsonl을 필터/검색해서 개별 PASS 레코드를 확인합니다.";
  }

  // 테이블/디테일 초기화
  $("failTbody").innerHTML = "";
  $("failDetailErrors").textContent = "";
  $("failDetailContext").textContent = "";
  $("failDetailRaw").textContent = "";
  selectedFailRow = null;

  // 컬럼/탭 라벨 (모드별)
  if (mode === "FAIL") {
    $("col1").textContent = "recordId";
    $("col2").textContent = "stage";
    $("col3").textContent = "code";
    $("col4").textContent = "message";

    $("tabErrors").textContent = "errors";
    $("tabContext").textContent = "context";
    $("tabRaw").textContent = "raw";

    // 기본 안내문구
    $("failDetailErrors").textContent = "행을 클릭하면 errors / context / raw 가 분리되어 표시됩니다.";
    setActiveTab("errors");
  } else {
    $("col1").textContent = "rawRecordId";
    $("col2").textContent = "seq";
    $("col3").textContent = "equipmentId";
    $("col4").textContent = "summary";

    $("tabErrors").textContent = "result";
    $("tabContext").textContent = "context";
    $("tabRaw").textContent = "events/metrics";

    // 기본 안내문구
    $("failDetailErrors").textContent = "행을 클릭하면 result / context / events&metrics 가 분리되어 표시됩니다.";
    setActiveTab("errors"); // PASS에서도 'tabErrors' 버튼을 result로 쓰는 구조
  }

  // ✅ Drill-down에서 필터 먼저 세팅하려고 autoLoad 끌 수 있음
  if (autoLoad) {
    if (mode === "FAIL") {
      loadFails($("runSelect").value, { resetOffset: true });
    } else {
      loadPasses($("runSelect").value, { resetOffset: true });
    }
  }
}


async function loadPasses(runId, { resetOffset = false } = {}) {
  if (resetOffset) passOffset = 0;

  const limit = Math.min(5000, Math.max(1, Number($("passLimit").value || 5)));
  const q = ($("passQuery").value || "").trim();

  const params = new URLSearchParams();
  params.set("offset", String(passOffset));
  params.set("limit", String(limit));
  if (q) params.set("q", q);

  const data = await fetchPassesPage(runId);
  renderPassTable(data);
  
  
}

function renderPassTable(page) {
  const tbody = $("failTbody");
  tbody.innerHTML = "";

  const total = Number(page.total || 0);
  const offset = Number(page.offset || 0);
  const limit = Number(page.limit || 0);
  const items = Array.isArray(page.items) ? page.items : [];

  const from = total === 0 ? 0 : (offset + 1);
  const to = Math.min(offset + items.length, total);
  $("failPageMeta").textContent = `표시: ${fmt(from)} ~ ${fmt(to)} / 전체 ${fmt(total)}`;

  $("failPrevBtn").disabled = offset <= 0;
  $("failNextBtn").disabled = (offset + limit) >= total;

  if (items.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="muted" colspan="4">조건에 맞는 pass 레코드가 없습니다.</td>`;
    tbody.appendChild(tr);

    $("failDetailErrors").textContent = "행을 클릭하면 result / context / events&metrics 가 분리되어 표시됩니다.";
    $("failDetailContext").textContent = "";
    $("failDetailRaw").textContent = "";
    setActiveTab(activeDetailTab);
    return;
  }

  for (const rec of items) {
    const ctx = (rec && typeof rec === "object" && rec.context && typeof rec.context === "object") ? rec.context : {};
    const rawRecordId = (typeof ctx.rawRecordId === "string") ? ctx.rawRecordId : "-";
    const seq = (ctx.seq !== undefined && ctx.seq !== null) ? String(ctx.seq) : "-";
    const equipmentId = (typeof ctx.equipmentId === "string") ? ctx.equipmentId : "-";

    const events = Array.isArray(rec.events) ? rec.events : [];
    const firstEvent = (events[0] && typeof events[0] === "object" && typeof events[0].eventType === "string") ? events[0].eventType : "-";
    const productType = (typeof ctx.productType === "string") ? ctx.productType : "-";
    const summary = `event=${firstEvent}, product=${productType}, events=${events.length}`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${rawRecordId}</td>
      <td class="mono">${seq}</td>
      <td class="mono">${equipmentId}</td>
      <td title="${String(summary).replaceAll('"','&quot;')}">${_short(summary, 140)}</td>
    `;

    tr.addEventListener("click", () => {
      if (selectedFailRow && selectedFailRow !== tr) selectedFailRow.classList.remove("selected");
      selectedFailRow = tr;
      tr.classList.add("selected");

      $("failDetailErrors").textContent = pretty(rec || "(없음)");
      $("failDetailContext").textContent = pretty(ctx || "(없음)");
      $("failDetailRaw").textContent = pretty({ events: rec.events || [], metrics: rec.metrics || {} });
      setActiveTab(activeDetailTab);
    });

    tbody.appendChild(tr);
  }
}


async function loadFails(runId, { resetOffset = false } = {}) {
  if (resetOffset) failOffset = 0;
  lastFailRunId = runId;

  const stage = $("failStage") ? $("failStage").value.trim() : "";
  const code = $("failCode") ? $("failCode").value.trim() : "";
  const q = $("failQuery") ? $("failQuery").value.trim() : "";

  const params = new URLSearchParams();
  params.set("offset", String(failOffset));
  params.set("limit", String(failLimit));
  if (stage) params.set("stage", stage);
  if (code) params.set("code", code);
  if (q) params.set("q", q);


  const data = await fetchFailsPage(runId);
  renderFailTable(data);
  
}


async function fetchFailsPage(runId) {
  const stage = $("failStage") ? $("failStage").value.trim() : "";
  const code = $("failCode") ? $("failCode").value.trim() : "";
  const q = $("failQuery") ? $("failQuery").value.trim() : "";

  const params = new URLSearchParams();
  params.set("offset", String(failOffset));
  params.set("limit", String(failLimit));
  if (stage) params.set("stage", stage);
  if (code) params.set("code", code);
  if (q) params.set("q", q);

  // ✅ realtime이면 realtime fails API 사용
  if (runId === REALTIME_RUN_ID) {
    return await fetchJSON(`/api/realtime/fails?${params.toString()}`);
  }
  return await fetchJSON(`/api/runs/${encodeURIComponent(runId)}/fails?${params.toString()}`);
}

async function fetchPassesPage(runId) {
  const limit = Math.min(5000, Math.max(1, Number($("passLimit").value || 5)));
  const q = ($("passQuery").value || "").trim();

  const params = new URLSearchParams();
  params.set("offset", String(passOffset));
  params.set("limit", String(limit));
  if (q) params.set("q", q);

  // ✅ realtime이면 realtime passes API 사용
  if (runId === REALTIME_RUN_ID) {
    return await fetchJSON(`/api/realtime/passes?${params.toString()}`);
  }
  return await fetchJSON(`/api/runs/${encodeURIComponent(runId)}/passes?${params.toString()}`);
}


function renderFailTable(page) {
  const tbody = $("failTbody");
  tbody.innerHTML = "";

  const total = Number(page.total || 0);
  const offset = Number(page.offset || 0);
  const limit = Number(page.limit || failLimit);
  const items = Array.isArray(page.items) ? page.items : [];

  const from = total === 0 ? 0 : (offset + 1);
  const to = Math.min(offset + items.length, total);
  $("failPageMeta").textContent = `표시: ${fmt(from)} ~ ${fmt(to)} / 전체 ${fmt(total)}`;

  $("failPrevBtn").disabled = offset <= 0;
  $("failNextBtn").disabled = (offset + limit) >= total;

  if (items.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="muted" colspan="4">조건에 맞는 fail 레코드가 없습니다.</td>`;
    tbody.appendChild(tr);

    $("failDetailErrors").textContent = "행을 클릭하면 errors / context / raw 가 분리되어 표시됩니다.";
    $("failDetailContext").textContent = "";
    $("failDetailRaw").textContent = "";
    setActiveTab(activeDetailTab);
    return;
  }

  for (const rec of items) {
    const recordId = (rec && rec.recordId) ? String(rec.recordId) : "-";
    const stage = (rec && rec.stage) ? String(rec.stage) : "-";
    const code = _firstErrorCode(rec);

    const fullMsg = _firstErrorMessage(rec);
    const msg = _short(fullMsg, 140);

    const tr = document.createElement("tr");
    const badgeCls = codeClass(code);

    tr.innerHTML = `
      <td class="mono">${recordId}</td>
      <td class="mono">${stage}</td>
      <td><span class="code-badge ${badgeCls}">${code}</span></td>
      <td title="${String(fullMsg || "").replaceAll('"','&quot;')}">${msg}</td>
    `;

    tr.addEventListener("click", () => {
      if (selectedFailRow && selectedFailRow !== tr) {
        selectedFailRow.classList.remove("selected");
      }
      selectedFailRow = tr;
      tr.classList.add("selected");

      $("failDetailErrors").textContent = pretty(rec.errors || "(없음)");
      $("failDetailContext").textContent = pretty(rec.context || rec.analyzed?.context || "(없음)");
      $("failDetailRaw").textContent = pretty(rec.raw || "(없음)");

      setActiveTab(activeDetailTab);
    });

    tbody.appendChild(tr);
  }
}



async function loadRuns({ preferRunId = null } = {}) {
  const runs = await fetchJSON("/api/runs");

  const sel = $("runSelect");
  sel.innerHTML = "";

  // 실시간 옵션(항상 상단)
  const rt = document.createElement("option");
  rt.value = REALTIME_RUN_ID;
  rt.textContent = "실시간";
  sel.appendChild(rt);

  for (const r of runs) {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r;
    sel.appendChild(opt);
  }


  if (preferRunId && runs.includes(preferRunId)) {
    sel.value = preferRunId;
  } else if (runs.length > 0) {
  }

  return runs;
}

async function fetchTotalsFallback(runId) {
  const p = await fetchJSON(`/api/runs/${encodeURIComponent(runId)}/passes?offset=0&limit=1`);
  const f = await fetchJSON(`/api/runs/${encodeURIComponent(runId)}/fails?offset=0&limit=1`);
  const pass = Number(p.total || 0);
  const fail = Number(f.total || 0);
  return { total: pass + fail, pass, fail };
}


async function loadSummary(runId) {
  // ✅ realtime은 run 저장소(/api/runs/...)가 아니라 /api/realtime/summary 를 사용
  const isRealtime = (runId === REALTIME_RUN_ID);

  const s = isRealtime
    ? await fetchJSON(`/api/realtime/summary`)
    : await fetchJSON(`/api/runs/${encodeURIComponent(runId)}/summary`);
  const summaryObj = (isRealtime && s && typeof s === "object" && s.summary)
    ? s.summary
    : s;
  
  
  let n = normalizeSummary(summaryObj);


  // ✅ runs 모드에서만 fallback(실시간은 /api/runs/.../passes,fails가 없음)
  if (!isRealtime) {
    const looksEmpty =
      (!s || typeof s !== "object" || Object.keys(s).length === 0) ||
      (!s["DATA-STATUS"] && !s["data_status"] && !s["DATA_STATUS"]);

    if (looksEmpty || (n.total === 0 && n.pass === 0 && n.fail === 0)) {
      const t = await fetchTotalsFallback(runId);
      n.total = t.total;
      n.pass = t.pass;
      n.fail = t.fail;
    }
  }

  $("kpiTotal").textContent = fmt(n.total);
  $("kpiPass").textContent  = fmt(n.pass);
  $("kpiFail").textContent  = fmt(n.fail);

  const rate = (n.total > 0) ? (n.fail / n.total * 100) : null;
  $("kpiRate").textContent = (rate === null) ? "-" : `${rate.toFixed(2)}%`;

  const runMetaEl = $("runMeta");

  runMetaEl.textContent = isRealtime ? `mode: realtime` : `mode: run`;
  runMetaEl.title = isRealtime ? `mode: realtime` : `mode: run`;



  renderDonutChart(n.pass, n.failBreakdown);
  renderFailList(n.failBreakdown);
  updateFailCodeDatalist(summaryObj);
}

function currentRunSelection() {
  return $("runSelect") ? $("runSelect").value : "";
}

function isUserAtTopOfExplorer() {
  const wrap = document.querySelector(".tbl-wrap");
  if (!wrap) return true;
  return wrap.scrollTop <= 2;
}

function getExplorerHeadKey(page, mode) {
  const items = Array.isArray(page?.items) ? page.items : [];
  if (items.length === 0) return null;

  if (mode === "FAIL") {
    const r = items[0];
    const rid = (r && r.recordId) ? String(r.recordId) : "";
    const stg = (r && r.stage) ? String(r.stage) : "";
    return `FAIL|${stg}|${rid}`;
  } else {
    const r = items[0];
    const ctx = (r && r.context && typeof r.context === "object") ? r.context : {};
    const raw = (ctx.rawRecordId && typeof ctx.rawRecordId === "string") ? ctx.rawRecordId : "";
    const seq = (ctx.seq !== undefined && ctx.seq !== null) ? String(ctx.seq) : "";
    return `PASS|${raw}|${seq}`;
  }
}

async function refreshAll({ forceExplorer = false } = {}) {
  if (refreshInFlight) return;
  refreshInFlight = true;

  try {
    const sel = currentRunSelection();

    // 1) 이번 사이클 run 확정(스냅샷 기준 고정)
    activeRunId = sel;

    // 2) summary(=pie chart/KPI) 항상 갱신
    await loadSummary(sel);

    // 3) Explorer는 "현재 탭만" 갱신
    // - 실시간 모드에서 즉시 렌더 점프 방지(5번 UX) 위해:
    //   최상단이 아니면 배너만 띄우고 렌더는 유저 클릭 시점으로 미룸
    const shouldDefer = (!forceExplorer && !isUserAtTopOfExplorer());

    if (explorerMode === "FAIL") {
      const page = await fetchFailsPage(sel); // 아래에서 추가할 래퍼
      const headKey = getExplorerHeadKey(page, "FAIL");

      if (lastExplorerHeadKey && headKey && headKey !== lastExplorerHeadKey && shouldDefer) {
        explorerPendingRefresh = true;
        showLiveBanner();
        return;
      }

      explorerPendingRefresh = false;
      hideLiveBanner();
      lastExplorerHeadKey = headKey;
      renderFailTable(page);
    } else {
      const page = await fetchPassesPage(sel); // 아래에서 추가할 래퍼
      const headKey = getExplorerHeadKey(page, "PASS");

      if (lastExplorerHeadKey && headKey && headKey !== lastExplorerHeadKey && shouldDefer) {
        explorerPendingRefresh = true;
        showLiveBanner();
        return;
      }

      explorerPendingRefresh = false;
      hideLiveBanner();
      lastExplorerHeadKey = headKey;
      renderPassTable(page);
    }
  } finally {
    refreshInFlight = false;
  }
}





function setRealtimeUI(on) {
  $("remoteRunBtn").style.display = on ? "none" : "";
  $("realtimePlayBtn").style.display = on ? "" : "none";
  $("realtimeStopBtn").style.display = (on && plcRunning) ? "" : "none";
  $("ingestPill").style.display = on ? "" : "none";

  // 차트 영역 토글
  const pieBox = $("pieBox");
  const ingestBox = $("ingestChartBox");
  if (pieBox) pieBox.style.display = "";
  if (ingestBox) ingestBox.style.display = on ? "" : "none";
  
  
  if (on) {
    $("runMeta").textContent = `mode: realtime`;

    plcRunning = false;
    $("kpiTotal").textContent = "-";
    $("kpiPass").textContent  = "-";
    $("kpiFail").textContent  = "-";
    $("kpiRate").textContent  = "-";

    $("failList").innerHTML = `<div class="stage-item"><span class="label">실시간 모드: 최근 ${INGEST_WINDOW}번 폴링 기준 Δ 막대그래프를 표시합니다.</span><span class="mono">-</span></div>`;



    // ingest 그래프 초기화
    resetIngestSeries();
    if (ingestBarChart) { ingestBarChart.destroy(); ingestBarChart = null; }
    ensureIngestBarChart();
    updateIngestBarChart();
  } else {
    $("ingestPill").textContent = "";
    lastIngestTotalWritten = null;
    lastIngestTotalDropped = null;
    lastIngestTickMs = null;

    plcRunning = false;
    $("realtimeStopBtn").style.display = "none";

    // ingest 그래프 정리
    if (ingestBarChart) { ingestBarChart.destroy(); ingestBarChart = null; }
    resetIngestSeries();
  }  
}


function startRealtimePolling() {
  stopRealtimePolling();

  const tick = async () => {
    if (refreshInFlight) return;

    try {
      const s = await fetchJSON("/api/realtime/status");

      const totalWritten = Number(s.totalWritten ?? 0);
      const totalDropped = Number(s.totalDropped ?? 0);
      const lastSeenUtc = String(s.lastSeenUtc ?? "");
      const lastError = String(s.lastError ?? "");

      // Δ(증분) + 수신 속도(records/sec) 계산 + B 방식 시계열 업데이트
      const nowMs = Date.now();
      let rps = null;

      let dw = 0;
      let dd = 0;

      if (lastIngestTotalWritten !== null && lastIngestTotalDropped !== null && lastIngestTickMs !== null) {
        const dt = (nowMs - lastIngestTickMs) / 1000.0;

        // 서버 재시작/리셋 대비: 음수면 0 처리
        dw = Math.max(0, totalWritten - lastIngestTotalWritten);
        dd = Math.max(0, totalDropped - lastIngestTotalDropped);

        if (dt > 0) rps = dw / dt;

        // B 방식: 최근 N폴링 Δ 막대그래프
        pushIngestPoint(_hhmmss(new Date(nowMs)), dw, dd);
        ensureIngestBarChart();
        updateIngestBarChart();
      }

      lastIngestTotalWritten = totalWritten;
      lastIngestTotalDropped = totalDropped;
      lastIngestTickMs = nowMs;


      const rateTxt = (rps === null) ? "" : ` | ${rps.toFixed(1)} rec/s`;
      const errTxt = lastError ? ` | err=${lastError}` : "";

      const agoSec = lastSeenUtc
      ? Math.max(0, Math.floor((Date.now() - Date.parse(lastSeenUtc)) / 1000))
      : null;
    
    $("ingestPill").textContent =
      `W ${totalWritten.toLocaleString()} · D ${totalDropped} · ${agoSec !== null ? agoSec + "s ago" : "-"} · ${rps ? rps.toFixed(1) + "/s" : "-"}`;
    
    } catch (e) {
      // 실시간 폴링은 에러를 치명으로 보지 않고 pill에만 표시
      $("ingestPill").textContent = `ingest: error (${e.message})`;
    }

     // ✅ realtime summary 폴링(원형그래프/KPI 갱신)
    const nowMs2 = Date.now();
    if (nowMs2 - lastRealtimeSummaryFetchMs >= REALTIME_SUMMARY_POLL_MS) {
      lastRealtimeSummaryFetchMs = nowMs2;

      try {
        await refreshAll(); // ✅ summary + (현재 탭 Explorer) 동기 갱신
      } catch (e) {
        showError(e.message); // 상단 에러바에 찍고
        // KPI/차트는 마지막 정상값 유지(0으로 덮어쓰지 않음)
      }
      

}



  };

  tick();
  realtimeTimer = setInterval(tick, 1000);
}

function stopRealtimePolling() {
  if (realtimeTimer) {
    clearInterval(realtimeTimer);
    realtimeTimer = null;
  }
}

function _hhmmss(d = new Date()) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function resetIngestSeries() {
  // 처음부터 고정 슬롯(INGEST_WINDOW개) 채워서 막대 폭이 절대 변하지 않게 함
  ingestLabels = Array(INGEST_WINDOW).fill("");
  ingestDeltaWritten = Array(INGEST_WINDOW).fill(0);
  ingestDeltaDropped = Array(INGEST_WINDOW).fill(0);
}


function ensureIngestBarChart() {
  const canvas = $("ingestBar");
  if (!canvas) return;
  if (ingestBarChart) return;

  const ctx = canvas.getContext("2d");
  ingestBarChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ingestLabels,
      datasets: [
        {
          label: "Δ written (per poll)",
          data: ingestDeltaWritten,
          borderWidth: 1,
          barThickness: 18,
          maxBarThickness: 22,
        },
        {
          label: "Δ dropped (per poll)",
          data: ingestDeltaDropped,
          borderWidth: 1,
          barThickness: 18,
          maxBarThickness: 22,
        },
      ],      
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
      },
      plugins: {
        legend: { display: true, position: "top" },
        tooltip: { enabled: true },
      },
    },
  });
}

function pushIngestPoint(label, dw, dd) {
  // 혹시라도 길이가 깨진 상태로 들어오면 복구
  if (ingestLabels.length !== INGEST_WINDOW) {
    const pad = Math.max(0, INGEST_WINDOW - ingestLabels.length);
    if (pad > 0) {
      ingestLabels = Array(pad).fill("").concat(ingestLabels);
      ingestDeltaWritten = Array(pad).fill(0).concat(ingestDeltaWritten);
      ingestDeltaDropped = Array(pad).fill(0).concat(ingestDeltaDropped);
    }
    if (ingestLabels.length > INGEST_WINDOW) {
      ingestLabels = ingestLabels.slice(-INGEST_WINDOW);
      ingestDeltaWritten = ingestDeltaWritten.slice(-INGEST_WINDOW);
      ingestDeltaDropped = ingestDeltaDropped.slice(-INGEST_WINDOW);
    }
  }

  // 고정 길이 유지: 왼쪽 1칸 제거 후 오른쪽에 최신값 추가
  ingestLabels.shift();
  ingestDeltaWritten.shift();
  ingestDeltaDropped.shift();

  ingestLabels.push(label);
  ingestDeltaWritten.push(dw);
  ingestDeltaDropped.push(dd);
}

function updateIngestBarChart() {
  if (!ingestBarChart) return;
  ingestBarChart.data.labels = ingestLabels;
  ingestBarChart.data.datasets[0].data = ingestDeltaWritten;
  ingestBarChart.data.datasets[1].data = ingestDeltaDropped;
  ingestBarChart.update("none");
}




async function init() {


  
  clearError();
  try {
    const runs = await loadRuns();
    if (runs.length === 0) {
      showError("run이 없습니다. data/runs 아래에 dev-run-001 같은 run 폴더가 있는지 확인하세요.");
      return;
    }

    const sel = $("runSelect");
    sel.value = runs[runs.length - 1]; // 또는 runs[0]
    await loadSummary($("runSelect").value);
    $("tabErrors").addEventListener("click", () => setActiveTab("errors"));
    $("tabContext").addEventListener("click", () => setActiveTab("context"));
    $("tabRaw").addEventListener("click", () => setActiveTab("raw"));
    $("kpiPassCard").addEventListener("click", () => setExplorerMode("PASS"));
    $("kpiFailCard").addEventListener("click", () => setExplorerMode("FAIL"));
    setActiveTab("errors");
    setExplorerMode("FAIL");


    $("liveNewBtn").addEventListener("click", async () => {
      clearError();
      try {
        await refreshAll({ forceExplorer: true }); // ✅ 강제 렌더(점프 허용을 유저가 선택)
      } catch (e) {
        showError(e.message);
      }
    });
    

    $("realtimePlayBtn").addEventListener("click", async () => {
      clearError();
    
      const btn = $("realtimePlayBtn");
      btn.disabled = true;
      btn.classList.add("loading");
    
      const txtEl = btn.querySelector(".txt");
      const prevTxt = txtEl ? txtEl.textContent : null;
      if (txtEl) txtEl.textContent = "PLC 시작됨";
    
      try {

        const resp = await fetchJSON("/api/realtime/start", { method: "POST" });
        const st = resp && resp.status ? String(resp.status) : "";

        if (st !== "started" && st !== "already_running") {
          throw new Error(`PLC start failed: ${st || "unknown"}`);
        }

        plcRunning = true;

        const sel = $("runSelect");
        if (sel) sel.value = REALTIME_RUN_ID;

        lastRealtimeSummaryFetchMs = Date.now();

        await refreshAll({ forceExplorer: true});
        startRealtimePolling();

        const stopBtn = document.getElementById("realtimeStopBtn");
        if (stopBtn) stopBtn.style.display = "";

    
      } catch (e) {
        showError(e.message);
        if (txtEl && prevTxt !== null) txtEl.textContent = prevTxt;
      } finally {
        btn.disabled = false;
        btn.classList.remove("loading");
        // 텍스트는 "PLC 시작됨" 유지(원하면 prevTxt로 복구 가능)
      }
    });
    

    $("realtimeStopBtn").addEventListener("click", async () => {
      clearError();
    
      const btn = $("realtimeStopBtn");
      btn.disabled = true;
      btn.classList.add("loading");
    
      const txtEl = btn.querySelector(".txt");
      const prevTxt = txtEl ? txtEl.textContent : null;
      if (txtEl) txtEl.textContent = "정지됨";
    
      try {
        const resp = await fetchJSON("/api/realtime/stop", { method: "POST" });
        const st = resp && resp.status ? String(resp.status) : "";

        if (st !== "stopped" && st !== "already_stopped") {
          throw new Error(`PLC stop failed: ${st || "unknown"}`);
        }

        plcRunning = false;
        btn.style.display = "none";
        stopRealtimePolling();
        $("ingestPill").textContent = "ingest: stopped";
    
        // 다음 단계에서 /api/realtime/stop 만들면 여기서 호출:
        // await fetchJSON("/api/realtime/stop", { method: "POST" });
    
      } catch (e) {
        showError(e.message);
        if (txtEl && prevTxt !== null) txtEl.textContent = prevTxt;
      } finally {
        btn.disabled = false;
        btn.classList.remove("loading");
      }
    });
    


    //서버 통신 버트 관련 코드
    $("remoteRunBtn").addEventListener("click", async () => {
      clearError();
    
      const btn = $("remoteRunBtn");
      btn.disabled = true;
      btn.classList.add("loading");

      const txtEl = btn.querySelector(".txt");
      const prevTxt = txtEl ? txtEl.textContent : null;
      if (txtEl) txtEl.textContent = "실행 중...";

      try {
        const resp = await fetchJSON("/api/remote/run?input=dummy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });

        const runId = resp && resp.run_id ? String(resp.run_id) : "";
        if (!runId) throw new Error("remote run succeeded but run_id is missing");

        await loadRuns({ preferRunId: runId });
        $("runSelect").value = runId;

        await loadSummary(runId);
        setExplorerMode(explorerMode);
      } catch (e) {
        showError(e.message);
      } finally {
        btn.disabled = false;
        btn.classList.remove("loading");
        if (txtEl && prevTxt !== null) txtEl.textContent = prevTxt;
      }
    });
    


    $("passQuery").addEventListener("keydown", async (ev) => {
      if (ev.key === "Enter") {
        if (explorerMode !== "PASS") return;
        clearError();
        try { await loadPasses($("runSelect").value, { resetOffset: true }); }
        catch (e) { showError(e.message); }
      }
    });
    
    $("passLimit").addEventListener("change", async () => {
      if (explorerMode !== "PASS") return;
      clearError();
      try { await loadPasses($("runSelect").value, { resetOffset: true }); }
      catch (e) { showError(e.message); }
    });
    
    // Fail Explorer controls
    $("failReloadBtn").addEventListener("click", async () => {
      clearError();
      try {
        if (explorerMode === "FAIL") {
          await loadFails($("runSelect").value, { resetOffset: true });
        } else {
          await loadPasses($("runSelect").value, { resetOffset: true });
        }
      } catch (e) { showError(e.message); }
    });
    

    $("failPrevBtn").addEventListener("click", async () => {
      clearError();
      try {
        if (explorerMode === "FAIL") {
          failOffset = Math.max(0, failOffset - failLimit);
          await loadFails($("runSelect").value);
        } else {
          const step = Math.min(5000, Math.max(1, Number($("passLimit").value || 5)));
          passOffset = Math.max(0, passOffset - step);
          await loadPasses($("runSelect").value);
        }
      } catch (e) { showError(e.message); }
    });
    
    $("failNextBtn").addEventListener("click", async () => {
      clearError();
      try {
        if (explorerMode === "FAIL") {
          failOffset = failOffset + failLimit;
          await loadFails($("runSelect").value);
        } else {
          const step = Math.min(5000, Math.max(1, Number($("passLimit").value || 5)));
          passOffset = passOffset + step;
          await loadPasses($("runSelect").value);
        }
      } catch (e) { showError(e.message); }
    });
    
    

    // Enter 키로 검색 실행
    $("failCode").addEventListener("keydown", async (ev) => {
      if (ev.key === "Enter") {
        if (explorerMode !== "FAIL") return;
        clearError();
        try { await loadFails($("runSelect").value, { resetOffset: true }); }
        catch (e) { showError(e.message); }
      }
    });
    $("failQuery").addEventListener("keydown", async (ev) => {
      if (ev.key === "Enter") {
        if (explorerMode !== "FAIL") return;
        clearError();
        try { await loadFails($("runSelect").value, { resetOffset: true }); }
        catch (e) { showError(e.message); }
      }
    });

    // stage 변경 시 즉시 반영
    $("failStage").addEventListener("change", async () => {
      if (explorerMode !== "FAIL") return;
      clearError();
      try { await loadFails($("runSelect").value, { resetOffset: true }); }
      catch (e) { showError(e.message); }
    });


    sel.addEventListener("change", async () => {
      clearError();
      try {
        const v = $("runSelect").value;

        // ✅ 실시간에서 다른 run으로 바꾸면: 폴링 + PLC(ingest)까지 완전 종료
        if (plcRunning && v !== REALTIME_RUN_ID) {
          await stopRealtimeCompletely();
        }

        if (v === REALTIME_RUN_ID) {
          setRealtimeUI(true);
          stopRealtimePolling();
          return;
        }

        // realtime -> run으로 돌아올 때
        stopRealtimePolling();
        setRealtimeUI(false);

        await loadSummary(v);
        setExplorerMode(explorerMode);
      } catch (e) { showError(e.message); }
    });


    
    $("refreshBtn").addEventListener("click", async () => {
      clearError();
      try {
        const current = $("runSelect").value;
    
        // ✅ realtime이면 runs sync 말고 realtime summary만 갱신
        if (current === REALTIME_RUN_ID) {
          await loadSummary(REALTIME_RUN_ID);
          return;
        }
    
        const newRuns = await loadRuns();
        if (newRuns.includes(current)) $("runSelect").value = current;
    
        await loadSummary($("runSelect").value);
        setExplorerMode(explorerMode);
      } catch (e) {
        showError(e.message);
      }
    });

  } catch (e) {
    showError(e.message);
  }
}
    



init();
