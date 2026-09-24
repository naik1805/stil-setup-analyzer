const state = {
  folderFiles: [],
  selected: new Set(),
  uploads: new Map(),
  lastResult: null,
  lastOptimize: null,
  lastExplore: null,
  hwTimer: null,
  hwLivePeak: { ram_pct: 0, gpu_pct: 0, ram_mb: 0 },
  lastAnalyzePeak: null,
  lastOptimizePeak: null,
};

const $ = (id) => document.getElementById(id);

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function shortName(name) {
  return name.replace(/\.stil$/i, "");
}

async function loadFiles() {
  const res = await fetch("/api/files");
  const data = await res.json();
  state.folderFiles = data.files || [];
  $("folderHint").textContent = data.folder || "";
  renderFileList();
}

function renderFileList() {
  const box = $("fileList");
  box.innerHTML = "";
  for (const f of state.folderFiles) {
    box.appendChild(fileRow(f.name, f.size_bytes, false));
  }
  for (const [name, rec] of state.uploads) {
    box.appendChild(fileRow(name, rec.size, true));
  }
}

function fileRow(name, size, uploaded) {
  const wrap = document.createElement("div");
  wrap.className = "file" + (uploaded ? " upload-item" : "");
  const id = "f_" + name.replace(/[^a-z0-9]/gi, "_");
  wrap.innerHTML = `
    <input type="checkbox" id="${id}" ${state.selected.has(name) ? "checked" : ""} />
    <label for="${id}">
      <span class="name">${name}</span>
      <span class="meta">${fmtBytes(size)}${uploaded ? " · uploaded" : ""}</span>
    </label>`;
  wrap.querySelector("input").addEventListener("change", (e) => {
    if (e.target.checked) state.selected.add(name);
    else state.selected.delete(name);
  });
  return wrap;
}

function setStatus(msg) {
  $("status").textContent = msg || "";
}

$("btnAll").onclick = () => {
  state.folderFiles.forEach((f) => state.selected.add(f.name));
  state.uploads.forEach((_, n) => state.selected.add(n));
  renderFileList();
};

$("btnNone").onclick = () => {
  state.selected.clear();
  renderFileList();
};

$("fileInput").addEventListener("change", async (e) => {
  for (const file of e.target.files || []) {
    const text = await file.text();
    state.uploads.set(file.name, { text, size: file.size });
    state.selected.add(file.name);
  }
  renderFileList();
  e.target.value = "";
});

$("btnAnalyze").onclick = analyze;
$("btnDownload").onclick = downloadReport;
$("btnDownloadTop").onclick = downloadReport;
$("btnExplore").onclick = openExplore;
$("btnExploreClose").onclick = closeExplore;
$("btnDlExplore").onclick = downloadExploreReport;
$("exploreModal").addEventListener("click", (e) => {
  if (e.target.id === "exploreModal") closeExplore();
});
$("btnOptimize").onclick = openOptimize;
$("btnOptClose").onclick = closeOptimize;
$("btnDlOptStil").onclick = downloadOptimizedStils;
$("btnDlOptReport").onclick = downloadOptimizeReport;
$("optModal").addEventListener("click", (e) => {
  if (e.target.id === "optModal") closeOptimize();
});

function mergePeak(a, b) {
  const x = a || {};
  const y = b || {};
  return {
    ram_pct: Math.max(Number(x.ram_pct) || 0, Number(y.ram_pct) || 0),
    gpu_pct: Math.max(Number(x.gpu_pct) || 0, Number(y.gpu_pct) || 0),
    ram_mb: Math.max(Number(x.ram_mb) || 0, Number(y.ram_mb) || 0),
  };
}

function peakView(p) {
  const ram = p.ram_pct || 0;
  const gpu = p.gpu_pct || 0;
  const mb = p.ram_mb ? ` (${p.ram_mb.toFixed(0)} MB)` : "";
  return {
    ram_pct: ram,
    gpu_pct: gpu,
    ram_label: `${ram.toFixed(1)}%`,
    gpu_label: `${gpu.toFixed(1)}%`,
    detail: `Recorded peak for this job: RAM ${ram.toFixed(1)}%${mb}, GPU ${gpu.toFixed(1)}%. Idle now is fine.`,
  };
}

function bumpLivePeak(data) {
  state.hwLivePeak = mergePeak(state.hwLivePeak, {
    ram_pct: data.ram_pct,
    gpu_pct: data.gpu_pct,
    ram_mb: data.ram_mb,
  });
}

function hwHtml(d) {
  const ram = d.ram_pct == null ? 0 : d.ram_pct;
  const gpu = d.gpu_pct == null ? 0 : d.gpu_pct;
  return `
    <div class="hw-row">
      <span class="name">RAM</span>
      <span class="pct">${esc(d.ram_label || "n/a")}</span>
      <div class="hw-bar ram"><i style="width:${ram}%"></i></div>
    </div>
    <div class="hw-row">
      <span class="name">GPU</span>
      <span class="pct">${esc(d.gpu_label || "n/a")}</span>
      <div class="hw-bar gpu"><i style="width:${gpu}%"></i></div>
    </div>
    ${d.detail ? `<p class="caption">${esc(d.detail)}</p>` : ""}`;
}

function paintHw(ids, data) {
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    el.classList.remove("hidden");
    el.innerHTML = hwHtml(data);
  }
}

function startHwWatch(ids) {
  stopHwWatch();
  state.hwLivePeak = { ram_pct: 0, gpu_pct: 0, ram_mb: 0 };
  const tick = async () => {
    try {
      const res = await fetch("/api/hw");
      const data = await res.json();
      bumpLivePeak(data);
      paintHw(ids, data);
    } catch (_) {
      /* keep last reading */
    }
  };
  tick();
  state.hwTimer = setInterval(tick, 400);
}

function freezeHw(ids, serverPeak) {
  stopHwWatch();
  const peak = mergePeak(state.hwLivePeak, serverPeak);
  if (ids.includes("hwAnalyze") || ids.includes("hwResults")) {
    state.lastAnalyzePeak = peak;
  }
  if (ids.includes("hwOptimize")) {
    state.lastOptimizePeak = peak;
  }
  paintHw(ids, peakView(peak));
}

function stopHwWatch() {
  if (state.hwTimer) {
    clearInterval(state.hwTimer);
    state.hwTimer = null;
  }
}

function hideHw(ids) {
  stopHwWatch();
  for (const id of ids) {
    const el = $(id);
    if (el) el.classList.add("hidden");
  }
}

async function analyze() {
  const names = [...state.selected].filter((n) => !state.uploads.has(n));
  const uploads = [...state.selected]
    .filter((n) => state.uploads.has(n))
    .map((n) => ({ name: n, text: state.uploads.get(n).text }));
  if (names.length + uploads.length === 0) {
    setStatus("Select at least one STIL file.");
    return;
  }
  $("btnAnalyze").disabled = true;
  $("empty").classList.add("hidden");
  $("results").classList.add("hidden");
  $("analyzeBusy").classList.remove("hidden");
  setStatus("Analyzing test setup…");
  startHwWatch(["hwAnalyze", "hwAnalyzeMain"]);
  try {
    const res = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names, uploads }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "compare failed");
    state.lastResult = data;
    $("btnDownload").disabled = false;
    renderResults(data);
    const gpu = (data.cuda && data.cuda.device) || (data.compare && data.compare.cuda && data.compare.cuda.device);
    setStatus(gpu ? `Analyzed ${data.reports.length} file(s) on CUDA (${gpu}).` : `Analyzed ${data.reports.length} file(s).`);
  } catch (err) {
    setStatus(String(err.message || err));
    $("empty").classList.remove("hidden");
  } finally {
    $("btnAnalyze").disabled = false;
    $("analyzeBusy").classList.add("hidden");
    if (state.lastResult) {
      freezeHw(["hwAnalyze", "hwResults"], state.lastResult.hw_peak);
    } else {
      hideHw(["hwAnalyze", "hwAnalyzeMain", "hwResults"]);
    }
  }
}

function fieldTable(tableId, rows, reports, emptyText, kind) {
  const el = $(tableId);
  if (!rows.length) {
    el.innerHTML = `<tr><td>${emptyText}</td></tr>`;
    return;
  }
  const cls = kind === "diff" ? "table-diff" : "table-same";
  let html = `<tr><th>What</th>`;
  reports.forEach((r) => {
    html += `<th>${shortName(r.file)}</th>`;
  });
  html += "</tr>";
  for (const row of rows) {
    html += `<tr class="${cls}"><td>${row.item}</td>`;
    for (const val of row.values) {
      html += `<td>${val}</td>`;
    }
    html += "</tr>";
  }
  el.innerHTML = html;
}

function renderResults({ reports, compare }) {
  $("empty").classList.add("hidden");
  $("results").classList.remove("hidden");

  const nCommon = (compare.common_rows || []).length;
  const nDiff = (compare.diff_rows || []).length;
  $("stats").innerHTML = `
    <div class="stat"><b>${reports.length}</b><span>files compared</span></div>
    <div class="stat"><b>${nCommon}</b><span>items the same</span></div>
    <div class="stat"><b>${nDiff}</b><span>items that differ</span></div>
  `;
  $("hint").textContent = compare.tester_hint;

  fieldTable("commonTable", compare.common_rows || [], reports, "Nothing is the same across these files.", "same");
  fieldTable("diffTable", compare.diff_rows || [], reports, "Nothing differs — all compared fields match.", "diff");

  const shared = $("shared");
  shared.innerHTML = (compare.shared_events || []).length
    ? compare.shared_events.map((e) => `<li>${e.label}</li>`).join("")
    : "<li>No shared setup-step types.</li>";

  $("cards").innerHTML = reports
    .map((r) => {
      const h = r.header || {};
      return `<article class="card">
        <h3>${r.file}</h3>
        <div class="kv">Partition: <strong>${h.dft_partition || "—"}</strong></div>
        <div class="kv">Open SIB: ${r.open_sib || "—"} (bits ${h.ijtag_sib_select || "—"})</div>
        <div class="kv">TDR: ${h.ijtag_tdr || "—"}</div>
        <div class="kv">Scan chains: ${(r.scan_chains || []).join(", ") || "—"}</div>
        <div class="kv">Fault: ${h.fault_model || "—"} · setup cycles: ${r.setup_cycles}</div>
      </article>`;
    })
    .join("");
}

function esc(v) {
  return String(v == null ? "—" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function htmlTable(rows, reports, emptyText, kind) {
  if (!rows.length) return `<p class="empty-note">${esc(emptyText)}</p>`;
  const cls = kind === "diff" ? "diff" : "same";
  let html = "<table><thead><tr><th>What</th>";
  reports.forEach((r) => {
    html += `<th>${esc(shortName(r.file))}</th>`;
  });
  html += "</tr></thead><tbody>";
  for (const row of rows) {
    html += `<tr class="${cls}"><td>${esc(row.item)}</td>`;
    for (const val of row.values) html += `<td>${esc(val)}</td>`;
    html += "</tr>";
  }
  return html + "</tbody></table>";
}

function buildHtmlReport({ reports, compare }) {
  const when = new Date().toISOString();
  const common = compare.common_rows || [];
  const diff = compare.diff_rows || [];
  const steps = compare.shared_events || [];
  const cards = reports
    .map((r) => {
      const h = r.header || {};
      return `<article class="card">
        <h3>${esc(r.file)}</h3>
        <p><b>Partition:</b> ${esc(h.dft_partition)}</p>
        <p><b>Open SIB:</b> ${esc(r.open_sib)} (bits ${esc(h.ijtag_sib_select)})</p>
        <p><b>TDR:</b> ${esc(h.ijtag_tdr)}</p>
        <p><b>Scan chains:</b> ${esc((r.scan_chains || []).join(", "))}</p>
        <p><b>Fault:</b> ${esc(h.fault_model)} &nbsp; <b>Test type:</b> ${esc(h.test_set_type)}</p>
        <p><b>Setup cycles:</b> ${esc(r.setup_cycles)} &nbsp; <b>Reset pins:</b> ${esc((r.reset_pins || []).join(", "))}</p>
      </article>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>STIL test-setup commonality report</title>
  <style>
    body { font: 14px/1.45 system-ui, Segoe UI, sans-serif; color: #1a1d23; background: #f4f5f7; margin: 0; padding: 28px; }
    h1 { margin: 0 0 6px; font-size: 22px; }
    h2 { margin: 28px 0 8px; font-size: 16px; }
    .meta, .caption { color: #5b6472; }
    .summary { background: #e8f0ff; border-left: 4px solid #3b7ddd; padding: 12px 14px; margin: 16px 0; }
    table { border-collapse: collapse; width: 100%; background: #fff; margin: 8px 0 16px; }
    th, td { border: 1px solid #d5dbe3; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #eef1f5; }
    tr.same td { background: #e6f6ec; }
    tr.diff td { background: #fdeee6; }
    ul { margin: 0; padding-left: 20px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    .card { background: #fff; border: 1px solid #d5dbe3; padding: 12px; }
    .card h3 { margin: 0 0 8px; font-size: 13px; word-break: break-all; }
    .card p { margin: 4px 0; color: #3d4450; }
    .empty-note { color: #5b6472; }
    .stats { margin: 8px 0 0; color: #5b6472; }
  </style>
</head>
<body>
  <h1>STIL test-setup commonality report</h1>
  <p class="meta">Generated ${esc(when)} &nbsp;·&nbsp; ${reports.length} file(s)</p>
  <div class="summary">${esc(compare.tester_hint)}</div>
  <p class="stats">${common.length} items the same &nbsp;·&nbsp; ${diff.length} items that differ</p>

  <h2>Files compared</h2>
  <ol>${reports.map((r) => `<li>${esc(r.file)}</li>`).join("")}</ol>

  <h2>What is the same in every selected file</h2>
  <p class="caption">Shared reset / protocol settings.</p>
  ${htmlTable(common, reports, "Nothing is the same across these files.", "same")}

  <h2>What is different</h2>
  <p class="caption">Partition-specific values (SIB, TDR, scan chains).</p>
  ${htmlTable(diff, reports, "Nothing differs — all compared fields match.", "diff")}

  <h2>Shared setup steps</h2>
  <p class="caption">Same protocol in every file. The values above (which SIB opens) can still differ.</p>
  <ul>${steps.length ? steps.map((e) => `<li>${esc(e.label)}</li>`).join("") : "<li>No shared setup-step types.</li>"}</ul>

  <h2>Per-file details</h2>
  <div class="cards">${cards}</div>
</body>
</html>`;
}

function downloadReport() {
  if (!state.lastResult) {
    setStatus("Analyze setup first, then download the report.");
    return;
  }
  const html = buildHtmlReport(state.lastResult);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `stil-setup-report-${stamp}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
  setStatus("Downloaded HTML setup report.");
}

function selectedPayload() {
  const names = [...state.selected].filter((n) => !state.uploads.has(n));
  const uploads = [...state.selected]
    .filter((n) => state.uploads.has(n))
    .map((n) => ({ name: n, text: state.uploads.get(n).text }));
  return { names, uploads };
}

function openExplore() {
  $("exploreModal").classList.remove("hidden");
  $("exploreStatus").textContent = "Loading the 31 setup clocks…";
  $("exploreBody").innerHTML = "";
  $("btnDlExplore").disabled = true;
  runExplore();
}

function closeExplore() {
  $("exploreModal").classList.add("hidden");
}

async function runExplore() {
  const { names, uploads } = selectedPayload();
  if (names.length + uploads.length === 0) {
    $("exploreStatus").textContent = "Select STIL files first.";
    return;
  }
  try {
    const res = await fetch("/api/explain-setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names, uploads }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "explain failed");
    state.lastExplore = data;
    $("btnDlExplore").disabled = false;
    renderExplore(data);
  } catch (err) {
    $("exploreStatus").textContent = String(err.message || err);
  }
}

function renderExplore(data) {
  const g = data.guide || {};
  const cycles = g.cycles || [];
  $("exploreStatus").textContent = data.note || "";
  let rows = cycles
    .map((c) => {
      const kind = c.decision === "waste" ? "waste" : "keep";
      return `<tr class="row-${kind}">
        <td class="num">${c.index}</td>
        <td><span class="tag tag-${kind}">${kind}</span></td>
        <td>${esc(c.label)}</td>
        <td>${esc(c.meaning)}</td>
        <td>${esc(c.pins)}</td>
      </tr>`;
    })
    .join("");
  $("exploreBody").innerHTML = `
    <div class="opt-summary">
      <div class="stat"><b>${g.clock_count ?? cycles.length}</b><span>tester clocks in TEST_SETUP</span></div>
      <div class="stat"><b>${esc(shortName(g.file || ""))}</b><span>file used for this list</span></div>
    </div>
    <p class="caption">Clock 0 is the first setup clock. After clock ${Math.max((g.clock_count || 1) - 1, 0)} the 1000 stuck-at patterns start. SIB/TDR pin values below are from this file; other files use the same steps with different TDI bits.</p>
    <div class="table-wrap">
      <table class="cycle-table">
        <tr><th>#</th><th>Role</th><th>Name</th><th>What this clock does</th><th>Pins</th></tr>
        ${rows}
      </table>
    </div>
  `;
}

function buildExploreHtml(data) {
  const g = data.guide || {};
  const when = new Date().toISOString();
  const rows = (g.cycles || [])
    .map((c) => {
      const cls = c.decision === "waste" ? "waste" : "keep";
      return `<tr class="${cls}"><td>${c.index}</td><td>${esc(c.decision)}</td><td>${esc(c.label)}</td><td>${esc(c.meaning)}</td><td>${esc(c.pins)}</td></tr>`;
    })
    .join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>STIL TEST_SETUP clock guide</title>
  <style>
    body { font: 14px/1.45 system-ui, Segoe UI, sans-serif; color: #1a1d23; background: #f4f5f7; margin: 0; padding: 28px; }
    h1 { margin: 0 0 6px; font-size: 22px; }
    .meta { color: #5b6472; }
    table { border-collapse: collapse; width: 100%; background: #fff; margin-top: 16px; }
    th, td { border: 1px solid #d5dbe3; padding: 8px 10px; text-align: left; vertical-align: top; }
    th { background: #eef1f5; }
    tr.keep td { background: #e6f6ec; }
    tr.waste td { background: #fdeee6; }
  </style>
</head>
<body>
  <h1>All TEST_SETUP clocks</h1>
  <p class="meta">Generated ${esc(when)} · ${esc(g.file)} · ${g.clock_count} tester clocks</p>
  <p>${esc(data.note || "")}</p>
  <table>
    <tr><th>#</th><th>Role</th><th>Name</th><th>What this clock does</th><th>Pins</th></tr>
    ${rows}
  </table>
</body>
</html>`;
}

function downloadExploreReport() {
  if (!state.lastExplore) {
    $("exploreStatus").textContent = "Open Explore first, then download the report.";
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  downloadBlob(buildExploreHtml(state.lastExplore), `stil-setup-clocks-${stamp}.html`, "text/html;charset=utf-8");
  $("exploreStatus").textContent = "Downloaded HTML guide of all setup clocks.";
}

function openOptimize() {
  $("optModal").classList.remove("hidden");
  $("optStatus").textContent = "Optimizing setup clocks…";
  $("optBody").innerHTML = "";
  $("btnDlOptStil").disabled = true;
  $("btnDlOptReport").disabled = true;
  runOptimize();
}

function resumeAnalyzeMeters() {
  if (state.lastAnalyzePeak) {
    paintHw(["hwAnalyze", "hwResults"], peakView(state.lastAnalyzePeak));
  } else if (state.lastResult) {
    freezeHw(["hwAnalyze", "hwResults"], state.lastResult.hw_peak);
  }
}

function closeOptimize() {
  $("optModal").classList.add("hidden");
  resumeAnalyzeMeters();
}

async function runOptimize() {
  const { names, uploads } = selectedPayload();
  if (names.length + uploads.length === 0) {
    $("optStatus").textContent = "Select STIL files first.";
    return;
  }
  startHwWatch(["hwOptimize"]);
  if (!$("optBody").innerHTML.trim()) {
    $("optBody").innerHTML = `<p class="caption">Optimizing setup clocks. RAM and GPU use update live above.</p>`;
  }
  try {
    const res = await fetch("/api/optimize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names, uploads }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "optimize failed");
    state.lastOptimize = data;
    $("btnDlOptStil").disabled = !data.zip_b64;
    $("btnDlOptReport").disabled = false;
    renderOptimize(data);
  } catch (err) {
    $("optStatus").textContent = String(err.message || err);
  } finally {
    freezeHw(["hwOptimize"], state.lastOptimize && state.lastOptimize.hw_peak);
  }
}

function groupList(groups, mode) {
  if (!groups.length) return "<p class='why'>None.</p>";
  return groups
    .map((g, i) => {
      const clocks = (g.cycles || []).map((n) => n).join(", ");
      const pins = g.pins ? `<div class="clk">${esc(g.pins)}</div>` : "";
      let btns = "";
      if (mode === "review") {
        btns = `<div class="review-btns">
          <button type="button" class="btn-keep" data-rev="keep" data-gi="${i}">Keep</button>
          <button type="button" class="btn-remove" data-rev="remove" data-gi="${i}">Remove</button>
        </div>`;
      }
      const countBit = mode === "review" ? "" : ` · ${g.count} clock(s)`;
      return `<div class="opt-item" data-cycles="${esc(clocks)}">
        <div><strong>${esc(g.label)}</strong>${countBit}</div>
        <div class="clk">tester clock # ${esc(clocks)}</div>
        ${pins}
        <p class="why">${esc(g.reason)}</p>
        ${btns}
      </div>`;
    })
    .join("");
}

function downloadBlob(content, filename, mime) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(a.href);
}

function downloadOptimizedStils() {
  const data = state.lastOptimize;
  if (!data || !data.zip_b64) {
    $("optStatus").textContent = "Review first, then download the STIL files.";
    return;
  }
  const n = (data.shared && data.shared.cut_clocks) || 0;
  const bin = Uint8Array.from(atob(data.zip_b64), (c) => c.charCodeAt(0));
  downloadBlob(new Blob([bin], { type: "application/zip" }), data.zip_name || "optimized_stils.zip");
  $("optStatus").textContent =
    n > 0
      ? `Downloaded STIL zip. Only ${n} clock(s) you marked Remove were cut.`
      : "Downloaded STIL zip. No Remove yet, so setup clocks are unchanged.";
}

function buildOptimizeHtml(data) {
  const s = data.shared || {};
  const when = new Date().toISOString();
  const files = (data.files || []).map((f) => `<li>${esc(f.file)} → ${esc(f.optimized_name)}</li>`).join("");
  const block = (title, groups, cls) => `
    <h2 class="${cls}">${esc(title)}</h2>
    ${(groups || [])
      .map(
        (g) => `<div class="item ${cls}">
      <h3>${esc(g.label)} · ${g.count} clock(s)</h3>
      <p class="clk">tester clock # ${(g.cycles || []).join(", ")}</p>
      <p>${esc(g.reason)}</p>
    </div>`
      )
      .join("")}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>STIL setup optimization report</title>
  <style>
    body { font: 14px/1.5 system-ui, Segoe UI, sans-serif; color: #1a1d23; background: #f4f5f7; margin: 0; padding: 28px; }
    h1 { margin: 0 0 6px; font-size: 22px; }
    h2 { margin: 24px 0 8px; font-size: 16px; }
    h2.keep { color: #1b7a45; }
    h2.waste { color: #a15c12; }
    .meta { color: #5b6472; }
    .stats { display: flex; gap: 24px; margin: 16px 0; }
    .item { background: #fff; border: 1px solid #d5dbe3; padding: 12px; margin: 0 0 10px; }
    .item.keep { border-left: 4px solid #1b7a45; }
    .item.waste { border-left: 4px solid #c9841a; }
    .item h3 { margin: 0 0 6px; font-size: 14px; }
    .clk { color: #3d6d8c; font-size: 12px; }
  </style>
</head>
<body>
  <h1>STIL setup optimization report</h1>
  <p class="meta">Generated ${esc(when)}</p>
  <div class="stats">
    <div><b>${s.before_clocks ?? "—"}</b> setup clocks now</div>
    <div><b>${s.review_clocks ?? "—"}</b> flagged for review</div>
    <div><b>${s.cut_clocks ?? "—"}</b> removed by engineer</div>
  </div>
  <p>${esc(s.note)}</p>
  <h2>Files</h2>
  <ol>${files}</ol>
  ${block("Kept", s.kept, "keep")}
  ${block("Needs engineer review", s.review, "waste")}
  ${block("Removed after review", s.removed, "waste")}
</body>
</html>`;
}

function downloadOptimizeReport() {
  if (!state.lastOptimize) {
    $("optStatus").textContent = "Optimize first, then download the report.";
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  downloadBlob(buildOptimizeHtml(state.lastOptimize), `stil-optimize-report-${stamp}.html`, "text/html;charset=utf-8");
  $("optStatus").textContent = "Downloaded HTML optimization report.";
}

function renderOptimize(data) {
  const s = data.shared || {};
  const ltd = s.ltd || {};
  const gpu = (data.cuda && data.cuda.device) || (s.cuda && s.cuda.device);
  $("optStatus").textContent = (s.note || "") + (gpu ? ` Running on CUDA (${gpu}).` : "");
  $("optBody").innerHTML = `
    <div class="opt-summary">
      <div class="stat"><b>${s.before_clocks ?? "—"}</b><span>setup clocks</span></div>
      <div class="stat"><b>${s.review_clocks ?? "—"}</b><span>need your review</span></div>
      <div class="stat"><b>${s.cut_clocks ?? "—"}</b><span>you removed</span></div>
      <div class="stat"><b>${ltd.n_reviews ?? 0}</b><span>labels in the GBC so far</span></div>
    </div>
    <p class="caption">Model: ${esc(ltd.source || "—")}${ltd.model_ready ? " (trained)" : " (rule prior until both Keep and Remove exist)"}. Recommend-cut and Defer are flags only.</p>
    <div class="opt-cols">
      <div class="opt-col keep">
        <h3>Keep — no review needed</h3>
        <p class="caption">SIB, TDR, IR, first reset, TAP exits. GBC cannot auto-remove these.</p>
        ${groupList(s.kept || [], "keep")}
      </div>
      <div class="opt-col review">
        <h3>Review — recommend cut or unsure</h3>
        <p class="caption">One row per tester clock. Click Keep or Remove. The GBC retrains from that clock.</p>
        ${groupList(s.review || [], "review")}
      </div>
    </div>
    ${(s.removed || []).length ? `<h3>Removed after your review</h3>${groupList(s.removed, "keep")}` : ""}
  `;
  $("optBody").querySelectorAll("[data-rev]").forEach((btn) => {
    btn.onclick = () => submitReview(btn.getAttribute("data-rev"), btn.closest(".opt-item"));
  });
}

async function submitReview(label, itemEl) {
  if (!state.lastOptimize || !itemEl) return;
  const cycles = (itemEl.querySelector(".clk")?.textContent || "")
    .replace("tester clock #", "")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
  const file = (state.lastOptimize.files || [])[0]?.file;
  const cycleMeta = ((state.lastOptimize.files || [])[0]?.cycles || []).concat(
    (state.lastOptimize.shared && []) || []
  );
  const byIdx = {};
  (state.lastOptimize.files || []).forEach((f) => {
    (f.cycles || []).forEach((c) => {
      byIdx[`${f.file}:${c.index}`] = c;
    });
  });
  const items = [];
  for (const f of state.lastOptimize.files || []) {
    for (const idx of cycles) {
      const c = (f.cycles || []).find((x) => x.index === idx) || {};
      items.push({
        file: f.file,
        index: idx,
        label,
        features: c.features || {},
      });
    }
  }
  $("optStatus").textContent = `Saving ${label} for ${cycles.length} clock(s), retraining GBC…`;
  startHwWatch(["hwOptimize"]);
  try {
    const res = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "review failed");
    $("optStatus").textContent = `Saved ${data.saved} label(s). Model trained=${data.model && data.model.trained}. Reloading…`;
    await runOptimize();
  } catch (err) {
    $("optStatus").textContent = String(err.message || err);
    freezeHw(["hwOptimize"], state.lastOptimizePeak || (state.lastOptimize && state.lastOptimize.hw_peak));
  }
}

loadFiles().catch((err) => setStatus(String(err)));
