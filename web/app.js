const $ = (id) => document.getElementById(id);
const API_BASE = (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === "string")
  ? window.APP_CONFIG.API_BASE
  : "";

let pieChart = null;

let failOffset = 0;
const failLimit = 5;
let lastFailRunId = null;

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

async function fetchJSON(path) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
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
    row.className = "stage-item";
    row.innerHTML = `<b>${k}</b><span class="mono bad">${fmt(v)}</span>`;
    el.appendChild(row);
  }
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

  const ctx = $("pie").getContext("2d");

  if (pieChart) pieChart.destroy();

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
              const value = Number(context.raw || 0);
              const pct = total > 0 ? (value / total * 100) : 0;
              return `${context.label}: ${value} (${pct.toFixed(2)}%)`;
            }
          }
        }
      }
    }
  });
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

  const data = await fetchJSON(`/api/runs/${encodeURIComponent(runId)}/fails?${params.toString()}`);
  renderFailTable(data);
}

function renderFailTable(page) {
  const tbody = $("failTbody");
  const detail = $("failDetail");
  tbody.innerHTML = "";

  const total = Number(page.total || 0);
  const offset = Number(page.offset || 0);
  const limit = Number(page.limit || failLimit);
  const items = Array.isArray(page.items) ? page.items : [];

  const from = total === 0 ? 0 : (offset + 1);
  const to = Math.min(offset + items.length, total);
  $("failPageMeta").textContent = `표시: ${fmt(from)} ~ ${fmt(to)} / 전체 ${fmt(total)}`;

  // 버튼 활성/비활성
  $("failPrevBtn").disabled = offset <= 0;
  $("failNextBtn").disabled = (offset + limit) >= total;

  if (items.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="muted" colspan="4">조건에 맞는 fail 레코드가 없습니다.</td>`;
    tbody.appendChild(tr);
    detail.textContent = "행을 클릭하면 여기에서 상세 JSON을 봅니다.";
    return;
  }

  for (const rec of items) {
    const recordId = (rec && rec.recordId) ? String(rec.recordId) : "-";
    const stage = (rec && rec.stage) ? String(rec.stage) : "-";
    const code = _firstErrorCode(rec);

    const tr = document.createElement("tr");
    const fullMsg = _firstErrorMessage(rec);
    const msg = _short(fullMsg, 140);
    
    tr.innerHTML = `
      <td class="mono">${recordId}</td>
      <td class="mono">${stage}</td>
      <td class="mono bad">${code}</td>
      <td title="${String(fullMsg || "").replaceAll('"','&quot;')}">${msg}</td>
    `;
    

    tr.addEventListener("click", () => {
      const pretty = JSON.stringify(rec, null, 2);
      detail.textContent = pretty;
    });

    tbody.appendChild(tr);
  }
}


async function loadRuns() {
  const runs = await fetchJSON("/api/runs");
  const sel = $("runSelect");
  sel.innerHTML = "";

  for (const r of runs) {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = r;
    sel.appendChild(opt);
  }
  return runs;
}

async function loadSummary(runId) {
  const s = await fetchJSON(`/api/runs/${encodeURIComponent(runId)}/summary`);
  const n = normalizeSummary(s);

  $("kpiTotal").textContent = fmt(n.total);
  $("kpiPass").textContent  = fmt(n.pass);
  $("kpiFail").textContent  = fmt(n.fail);

  if (n.failRate !== null && Number.isFinite(n.failRate)) {
    $("kpiRate").textContent = `${(n.failRate * 100).toFixed(2)}%`;
  } else {
    const rate = (n.total > 0) ? (n.fail / n.total * 100) : null;
    $("kpiRate").textContent = (rate === null) ? "-" : `${rate.toFixed(2)}%`;
  }

  $("runMeta").textContent = `run_id: ${runId}`;

  renderDonutChart(n.pass, n.failBreakdown);
  renderFailList(n.failBreakdown);
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
    await loadSummary($("runSelect").value);
    await loadFails($("runSelect").value, { resetOffset: true });
    

    sel.addEventListener("change", async () => {
      clearError();
      try {
        await loadSummary($("runSelect").value);
        await loadFails($("runSelect").value, { resetOffset: true });
      } catch (e) {
        showError(e.message);
      }
    });
    

    $("refreshBtn").addEventListener("click", async () => {
      clearError();
      try {
        const current = $("runSelect").value;
        const newRuns = await loadRuns();
        if (newRuns.includes(current)) $("runSelect").value = current;
        await loadSummary($("runSelect").value);
      } catch (e) {
        showError(e.message);
      }
    });

  } catch (e) {
    showError(e.message);
  }
}

// Fail Explorer controls
$("failReloadBtn").addEventListener("click", async () => {
  clearError();
  try { await loadFails($("runSelect").value, { resetOffset: true }); }
  catch (e) { showError(e.message); }
});

$("failPrevBtn").addEventListener("click", async () => {
  clearError();
  try {
    failOffset = Math.max(0, failOffset - failLimit);
    await loadFails($("runSelect").value);
  } catch (e) { showError(e.message); }
});

$("failNextBtn").addEventListener("click", async () => {
  clearError();
  try {
    failOffset = failOffset + failLimit;
    await loadFails($("runSelect").value);
  } catch (e) { showError(e.message); }
});

// Enter 키로 검색 실행
$("failCode").addEventListener("keydown", async (ev) => {
  if (ev.key === "Enter") {
    clearError();
    try { await loadFails($("runSelect").value, { resetOffset: true }); }
    catch (e) { showError(e.message); }
  }
});
$("failQuery").addEventListener("keydown", async (ev) => {
  if (ev.key === "Enter") {
    clearError();
    try { await loadFails($("runSelect").value, { resetOffset: true }); }
    catch (e) { showError(e.message); }
  }
});

// stage 변경 시 즉시 반영
$("failStage").addEventListener("change", async () => {
  clearError();
  try { await loadFails($("runSelect").value, { resetOffset: true }); }
  catch (e) { showError(e.message); }
});


init();
