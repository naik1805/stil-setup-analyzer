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
  exploreRoleFilter: "all",
  optimizeRoleFilter: "all",
  commonalityMin: 90,
  browseOpen: false,
  browsePage: 0,
};

const $ = (id) => document.getElementById(id);

function isRejectClock(c) {
  const d = String((c && (c.decision || c.rule_hint)) || "").toLowerCase();
  return d === "waste" || d === "reject";
}

function clockRole(c) {
  return isRejectClock(c) ? "reject" : "keep";
}

function clockRoleLabel(role) {
  return role === "reject" ? "Reject" : "Keep";
}

function roleFilterBar(which, current) {
  const opts = [
    ["all", "All"],
    ["keep", "Keep"],
    ["reject", "Reject"],
  ];
  return `<div class="role-filter" data-which="${which}">
    <span>Show</span>
    ${opts
      .map(
        ([id, label]) =>
          `<button type="button" class="ghost${current === id ? " on" : ""}" data-role-filter="${id}">${label}</button>`
      )
      .join("")}
  </div>`;
}

function bindRoleFilter(root, which, onChange) {
  if (!root) return;
  root.querySelectorAll("[data-role-filter]").forEach((btn) => {
    btn.onclick = () => {
      const next = btn.getAttribute("data-role-filter") || "all";
      if (which === "explore") state.exploreRoleFilter = next;
      else state.optimizeRoleFilter = next;
      onChange();
    };
  });
}

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
  const folder = data.folder || "";
  $("folderHint").textContent = /opt[/\\]render/i.test(folder) ? "" : folder;
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

function esc(v) {
  return String(v == null ? "—" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtBits(val) {
  const raw = String(val == null ? "" : val);
  if (!/^[01]{17,}$/.test(raw)) return esc(raw || "—");
  const ones = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "1") ones.push(i);
  }
  const onesTxt =
    ones.length === 0
      ? "all 0"
      : ones.length <= 12
        ? `1 at bit ${ones.join(", ")}`
        : `${ones.length} ones`;
  const head = raw.slice(0, 8);
  const tail = raw.slice(-8);
  const sum = `${raw.length} bits · ${onesTxt} · first ${head} · last ${tail}`;
  return `<details class="bits"><summary>${esc(sum)}</summary><code class="bits-dump">${esc(raw)}</code></details>`;
}

function perFileStack(reports, values) {
  return reports
    .map(
      (r, i) =>
        `<div class="per-file"><span class="pf-name">${esc(shortName(r.file))}</span><span class="pf-val">${fmtBits(values[i])}</span></div>`
    )
    .join("");
}

function fieldTable(tableId, rows, reports, emptyText, kind) {
  const el = $(tableId);
  if (!rows.length) {
    el.innerHTML = `<tr><td>${esc(emptyText)}</td></tr>`;
    return;
  }
  if (kind === "same") {
    let html = `<tr><th>What</th><th>Value in every file</th></tr>`;
    for (const row of rows) {
      html += `<tr class="table-same"><td>${esc(row.item)}</td><td>${fmtBits(row.values[0])}</td></tr>`;
    }
    el.innerHTML = html;
    return;
  }
  let html = `<tr><th>What</th><th>Per file</th></tr>`;
  for (const row of rows) {
    const stack = perFileStack(reports, row.values);
    html += `<tr class="table-diff"><td>${esc(row.item)}</td><td><details class="fold"><summary>${reports.length} files — expand</summary>${stack}</details></td></tr>`;
  }
  el.innerHTML = html;
}

function clockRanges(indices) {
  const sorted = [...indices].sort((a, b) => a - b);
  if (!sorted.length) return "";
  const parts = [];
  let a = sorted[0];
  let b = a;
  for (const i of sorted.slice(1)) {
    if (i === b + 1) {
      b = i;
      continue;
    }
    parts.push(a === b ? `#${a}` : `#${a}–${b}`);
    a = b = i;
  }
  parts.push(a === b ? `#${a}` : `#${a}–${b}`);
  return parts.join(", ");
}

const BROWSE_PAGE = 25;

function groupCommonClocks(cycles) {
  const map = new Map();
  for (const c of cycles) {
    if (!c.match_all) continue;
    const key = `${c.label}\0${c.recommend}`;
    if (!map.has(key)) {
      map.set(key, {
        label: c.label,
        recommend: c.recommend === "redundant" ? "redundant" : "keep",
        reason: c.reason || "",
        indices: [],
      });
    }
    map.get(key).indices.push(c.index);
  }
  return [...map.values()].map((g) => ({
    ...g,
    count: g.indices.length,
    clocks: clockRanges(g.indices),
  }));
}

function commonalityFilterBar(current) {
  const opts = [
    [90, "≥ 90%"],
    [80, "≥ 80%"],
    [70, "≥ 70%"],
    [0, "All"],
  ];
  return `<div class="role-filter" data-which="commonality">
    <span>Show clocks at</span>
    ${opts
      .map(
        ([min, label]) =>
          `<button type="button" class="ghost${current === min ? " on" : ""}" data-com-min="${min}">${label}</button>`
      )
      .join("")}
  </div>`;
}

function renderCommonality(compare) {
  const wrap = $("commonalityWrap");
  const clockWrap = $("clockReportWrap");
  const com = compare && compare.commonality;
  if (!wrap) return;
  if (!com || com.pct == null || (com.files_n || 0) < 2) {
    wrap.classList.add("hidden");
    if (clockWrap) clockWrap.classList.add("hidden");
    return;
  }
  wrap.classList.remove("hidden");
  if (clockWrap) clockWrap.classList.remove("hidden");
  const min = state.commonalityMin;
  $("commonalityScore").innerHTML = `
    <div class="commonality-score">
      <div>
        <div class="pct">${com.pct}%</div>
        <div class="frac">${com.matched} / ${com.clocks} clocks identical in all ${com.files_n} files</div>
      </div>
      <div class="stat"><b>${com.unmatched}</b><span>clocks not identical in every file</span></div>
      <div class="stat"><b>${com.keep_n ?? "—"}</b><span>Keep</span></div>
      <div class="stat"><b>${com.redundant_n ?? "—"}</b><span>Redundant (rule)</span></div>
    </div>
    <p class="caption">This percent is matching tester clocks, not event-name overlap. A clock is counted only when every selected file has the same pin values at that index.</p>
  `;
  const groups = compare.partition_groups || [];
  $("commonalityIslands").innerHTML = groups.length
    ? groups
        .map((g) => {
          const pct = g.commonality_pct;
          const frac =
            pct == null
              ? "—"
              : `${pct}% (${g.commonality_matched ?? "?"} / ${g.commonality_clocks ?? "?"} clocks)`;
          return `<div class="island-score kv"><strong>${esc(g.partition)}</strong> · ${esc((g.test_types || []).join(", "))} · ${frac}</div>`;
        })
        .join("")
    : "";
  const commonGroups = groupCommonClocks(com.cycles || []);
  const commonEl = $("commonClocksTable");
  if (commonEl) {
    if (!commonGroups.length) {
      commonEl.innerHTML = `<tr><td>No clocks are identical in every selected file.</td></tr>`;
    } else {
      let html = `<tr><th>What</th><th>Tester clocks</th><th>Recommend</th></tr>`;
      for (const g of commonGroups) {
        html += `<tr class="table-same"><td>${esc(g.label)} · ${g.count} clock(s)</td><td>${esc(g.clocks)}</td><td><span class="tag tag-${g.recommend}">${g.recommend === "redundant" ? "Redundant" : "Keep"}</span></td></tr>`;
      }
      commonEl.innerHTML = html;
    }
  }
  const uncommon = (com.cycles || []).filter((c) => !c.match_all);
  const uncommonEl = $("uncommonClocksTable");
  if (uncommonEl) {
    if (!uncommon.length) {
      uncommonEl.innerHTML = `<tr class="table-same"><td>Every TEST_SETUP clock matches in all ${com.files_n} files. Nothing is not-common.</td></tr>`;
    } else {
      let html = `<tr><th>Clock</th><th>Per file (why it is not common)</th><th>Recommend</th></tr>`;
      for (const c of uncommon) {
        const rec = c.recommend === "redundant" ? "redundant" : "keep";
        const files = (c.per_file || [])
          .map(
            (f) =>
              `<div class="per-file"><span class="pf-name">${esc(shortName(f.file))}</span><span class="pf-val">${esc(f.pins)}</span></div>`
          )
          .join("");
        const nfiles = (c.per_file || []).length;
        const body = files
          ? `<details class="fold"><summary>${nfiles} files — expand pins</summary>${files}</details>`
          : "—";
        html += `<tr class="table-diff"><td>#${c.index}<div class="caption">${esc(c.label)} · ${c.pct}% · ${c.agree_n}/${c.files_n} files</div></td><td>${body}</td><td><span class="tag tag-${rec}">${rec === "redundant" ? "Redundant" : "Keep"}</span></td></tr>`;
      }
      uncommonEl.innerHTML = html;
    }
  }
  if ($("commonalityFilter")) {
    const rows = (com.cycles || []).filter((c) => (c.pct ?? 0) >= min);
    const pages = Math.max(1, Math.ceil(rows.length / BROWSE_PAGE));
    if (state.browsePage >= pages) state.browsePage = 0;
    $("commonalityFilter").innerHTML = `
      ${commonalityFilterBar(min)}
      <p class="caption">${rows.length} clocks at this threshold, shown as ${groupCommonClocks(rows.filter((c) => c.match_all)).length} common groups above. The raw list is optional and paged.</p>
      <button type="button" class="ghost" id="btnBrowseToggle">${state.browseOpen ? "Hide raw clock pages" : "Show raw clock pages (25 at a time)"}</button>
    `;
    $("commonalityFilter").querySelectorAll("[data-com-min]").forEach((btn) => {
      btn.onclick = () => {
        state.commonalityMin = Number(btn.getAttribute("data-com-min") || 0);
        state.browsePage = 0;
        renderCommonality(compare);
      };
    });
    const tog = $("btnBrowseToggle");
    if (tog) {
      tog.onclick = () => {
        state.browseOpen = !state.browseOpen;
        renderCommonality(compare);
      };
    }
    let html = "";
    if (!state.browseOpen) {
      html = `<tr><td class="caption">Raw 1600-clock list is hidden. Use the grouped tables above — that is the full analysis.</td></tr>`;
    } else if (!rows.length) {
      html = `<tr><td class="caption">No clocks at this threshold. Choose 80%, 70%, or All.</td></tr>`;
    } else {
      const start = state.browsePage * BROWSE_PAGE;
      const slice = rows.slice(start, start + BROWSE_PAGE);
      html = `<tr><th>#</th><th>Clock commonality</th><th>Recommend</th><th>Name</th></tr>`;
      for (const c of slice) {
        const rec = c.recommend === "redundant" ? "redundant" : "keep";
        const cls = rec === "redundant" ? "row-reject" : "row-keep";
        html += `<tr class="${cls}">
          <td class="num">${c.index}</td>
          <td>${c.pct}%${c.match_all ? " · all files" : ` · ${c.agree_n}/${c.files_n} files`}</td>
          <td><span class="tag tag-${rec}">${rec === "redundant" ? "Redundant" : "Keep"}</span></td>
          <td>${esc(c.label)}</td>
        </tr>`;
      }
      html += `<tr><td colspan="4"><div class="role-filter">
        <button type="button" class="ghost" id="btnBrowsePrev" ${state.browsePage <= 0 ? "disabled" : ""}>Previous 25</button>
        <span>Page ${state.browsePage + 1} / ${pages}</span>
        <button type="button" class="ghost" id="btnBrowseNext" ${state.browsePage >= pages - 1 ? "disabled" : ""}>Next 25</button>
      </div></td></tr>`;
    }
    if ($("commonalityTable")) $("commonalityTable").innerHTML = html;
    const prev = $("btnBrowsePrev");
    const next = $("btnBrowseNext");
    if (prev) prev.onclick = () => { state.browsePage -= 1; renderCommonality(compare); };
    if (next) next.onclick = () => { state.browsePage += 1; renderCommonality(compare); };
  }
}

function renderResults({ reports, compare }) {
  $("empty").classList.add("hidden");
  $("results").classList.remove("hidden");

  const com = compare.commonality || {};
  const nCommon = (compare.common_rows || []).length;
  const nDiff = (compare.diff_rows || []).length;
  $("stats").innerHTML = `
    <div class="stat"><b>${com.pct != null ? com.pct + "%" : "—"}</b><span>genuine commonality</span></div>
    <div class="stat"><b>${reports.length}</b><span>files compared</span></div>
    <div class="stat"><b>${nCommon}</b><span>items the same</span></div>
    <div class="stat"><b>${nDiff}</b><span>items that differ</span></div>
  `;
  $("hint").textContent = compare.tester_hint;
  renderCommonality(compare);

  const groups = compare.partition_groups || [];
  $("partitionGroups").innerHTML = groups.length
    ? groups
        .map((g) => {
          const types = (g.test_types || []).join(", ");
          const files = (g.files || []).map((f) => `${esc(f.file)} (${esc(f.test_type)})`).join("; ");
          const flag = g.cross_test
            ? `<span class="tag tag-keep">same partition, different tests</span>`
            : "";
          const pct =
            g.commonality_pct != null
              ? ` · ${g.commonality_pct}% (${g.commonality_matched}/${g.commonality_clocks})`
              : "";
          return `<div class="kv"><strong>${esc(g.partition)}</strong> · ${esc(types)}${pct} ${flag}<div class="caption">${files}</div></div>`;
        })
        .join("")
    : "";
  $("partitionGroupsWrap").classList.toggle("hidden", !groups.length);

  fieldTable("commonTable", compare.common_rows || [], reports, "Nothing is the same across these files.", "same");
  fieldTable("diffTable", compare.diff_rows || [], reports, "Nothing differs — all compared fields match.", "diff");

  const shared = $("shared");
  shared.innerHTML = (compare.shared_events || []).length
    ? compare.shared_events.map((e) => `<li>${e.label}</li>`).join("")
    : "<li>No shared setup-step types.</li>";

  $("cards").innerHTML = `<details class="fold"><summary>${reports.length} files — expand details</summary><div class="cards" style="margin-top:10px">${reports
    .map((r) => {
      const h = r.header || {};
      return `<article class="card">
        <h3>${r.file}</h3>
        <div class="kv">Partition: <strong>${h.dft_partition || "—"}</strong></div>
        <div class="kv">Open SIB: ${esc(r.open_sib || "—")} · ${fmtBits(h.ijtag_sib_select)}</div>
        <div class="kv">TDR: ${fmtBits(h.ijtag_tdr)}</div>
        <div class="kv">Scan chains: ${(r.scan_chains || []).join(", ") || "—"}</div>
        <div class="kv">Fault: ${h.fault_model || "—"} · Test: ${h.test_set_type || "—"} · setup cycles: ${r.setup_cycles}</div>
      </article>`;
    })
    .join("")}</div></details>`;
}

function htmlTable(rows, reports, emptyText, kind) {
  if (!rows.length) return `<p class="empty-note">${esc(emptyText)}</p>`;
  if (kind === "same") {
    let html = `<table class="field-table"><thead><tr><th>What</th><th>Value in every file</th></tr></thead><tbody>`;
    for (const row of rows) {
      html += `<tr class="same"><td>${esc(row.item)}</td><td>${fmtBits(row.values[0])}</td></tr>`;
    }
    return html + "</tbody></table>";
  }
  let html = `<table class="field-table"><thead><tr><th>What</th><th>Per file</th></tr></thead><tbody>`;
  for (const row of rows) {
    html += `<tr class="diff"><td>${esc(row.item)}</td><td>${perFileStack(reports, row.values)}</td></tr>`;
  }
  return html + "</tbody></table>";
}

function clockReportHtml(compare) {
  const com = compare && compare.commonality;
  if (!com || com.pct == null || (com.files_n || 0) < 2) return "";
  const groups = groupCommonClocks(com.cycles || []);
  const uncommon = (com.cycles || []).filter((c) => !c.match_all);
  let commonTbl = "<p class='empty-note'>No clocks are identical in every selected file.</p>";
  if (groups.length) {
    commonTbl = `<table><thead><tr><th>What</th><th>Tester clocks</th><th>Recommend</th></tr></thead><tbody>`;
    for (const g of groups) {
      commonTbl += `<tr class="same"><td>${esc(g.label)} · ${g.count} clock(s)</td><td>${esc(g.clocks)}</td><td>${g.recommend === "redundant" ? "Redundant" : "Keep"}</td></tr>`;
    }
    commonTbl += "</tbody></table>";
  }
  let uncommonTbl = `<p class='empty-note'>Every TEST_SETUP clock matches in all ${com.files_n} files.</p>`;
  if (uncommon.length) {
    uncommonTbl = `<table><thead><tr><th>Clock</th><th>Per file</th><th>Recommend</th></tr></thead><tbody>`;
    for (const c of uncommon) {
      const files = (c.per_file || [])
        .map((f) => `<div class="per-file"><span class="pf-name">${esc(shortName(f.file))}</span><span class="pf-val">${esc(f.pins)}</span></div>`)
        .join("");
      uncommonTbl += `<tr class="diff"><td>#${c.index} ${esc(c.label)} · ${c.pct}%</td><td>${files}</td><td>${c.recommend === "redundant" ? "Redundant" : "Keep"}</td></tr>`;
    }
    uncommonTbl += "</tbody></table>";
  }
  return `
  <h2>Clocks that are common</h2>
  <p class="caption">${com.matched} / ${com.clocks} clocks identical in all ${com.files_n} files.</p>
  ${commonTbl}
  <h2>Clocks that are not common</h2>
  <p class="caption">${com.unmatched} clocks differ across the selected files.</p>
  ${uncommonTbl}`;
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
        <p><b>Open SIB:</b> ${esc(r.open_sib)} · ${fmtBits(h.ijtag_sib_select)}</p>
        <p><b>TDR:</b> ${fmtBits(h.ijtag_tdr)}</p>
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
    table { border-collapse: collapse; width: 100%; background: #fff; margin: 8px 0 16px; table-layout: fixed; }
    th, td { border: 1px solid #d5dbe3; padding: 8px 10px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
    .per-file { display: grid; grid-template-columns: minmax(8rem, 32%) 1fr; gap: 4px 12px; padding: 4px 0; border-bottom: 1px solid #e6e9ee; }
    .pf-name { color: #5b6472; word-break: break-all; }
    details.bits summary { cursor: pointer; }
    .bits-dump { display: block; margin-top: 8px; word-break: break-all; font-size: 11px; color: #5b6472; }
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
  ${
    (compare.commonality && compare.commonality.pct != null)
      ? `<div class="summary"><b>Genuine commonality ${esc(compare.commonality.pct)}%</b> — ${esc(compare.commonality.matched)} / ${esc(compare.commonality.clocks)} TEST_SETUP clocks identical in all ${esc(compare.commonality.files_n)} files. ${esc(compare.commonality.unmatched)} clocks differ. Keep ${esc(compare.commonality.keep_n)} · Redundant ${esc(compare.commonality.redundant_n)}.</div>`
      : ""
  }

  <h2>Files compared</h2>
  <ol>${reports.map((r) => `<li>${esc(r.file)}</li>`).join("")}</ol>

  ${clockReportHtml(compare)}

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
  $("exploreStatus").textContent = "Loading setup clocks…";
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
  const filter = state.exploreRoleFilter || "all";
  const shown = cycles.filter((c) => filter === "all" || clockRole(c) === filter);
  $("exploreStatus").textContent = data.note || "";
  const map = new Map();
  for (const c of shown) {
    const kind = clockRole(c);
    const key = `${c.label}\0${kind}`;
    if (!map.has(key)) {
      map.set(key, { label: c.label, kind, meaning: c.meaning, indices: [] });
    }
    map.get(key).indices.push(c.index);
  }
  const groups = [...map.values()];
  let rows = groups
    .map((gr) => {
      return `<tr class="row-${gr.kind}">
        <td>${esc(clockRanges(gr.indices))}</td>
        <td><span class="tag tag-${gr.kind}">${clockRoleLabel(gr.kind)}</span></td>
        <td>${esc(gr.label)} · ${gr.indices.length} clock(s)</td>
        <td>${esc(gr.meaning)}</td>
      </tr>`;
    })
    .join("");
  $("exploreBody").innerHTML = `
    <div class="opt-summary">
      <div class="stat"><b>${g.clock_count ?? cycles.length}</b><span>tester clocks in TEST_SETUP</span></div>
      <div class="stat"><b>${groups.length}</b><span>step groups (not 1600 rows)</span></div>
      <div class="stat"><b>${esc(shortName(g.file || ""))}</b><span>file used for this list</span></div>
    </div>
    ${roleFilterBar("explore", filter)}
    <p class="caption">Full bring-up is grouped by step. TDR is one row (1400 clocks), not 1400 lines. Filter Keep or Reject. Download the report if you need every clock index.</p>
    <div class="table-wrap">
      <table class="cycle-table">
        <tr><th>Clocks</th><th>Role</th><th>Name</th><th>What this does</th></tr>
        ${rows || `<tr><td colspan="4" class="caption">No clocks in this filter.</td></tr>`}
      </table>
    </div>
  `;
  bindRoleFilter($("exploreBody"), "explore", () => renderExplore(data));
}

function buildExploreHtml(data) {
  const g = data.guide || {};
  const when = new Date().toISOString();
  const rows = (g.cycles || [])
    .map((c) => {
      const cls = clockRole(c);
      return `<tr class="${cls}"><td>${c.index}</td><td>${clockRoleLabel(cls)}</td><td>${esc(c.label)}</td><td>${esc(c.meaning)}</td><td>${esc(c.pins)}</td></tr>`;
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
    tr.reject td { background: #fdeee6; }
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
      const idxs = g.cycles || [];
      const clocks = idxs.join(",");
      const ranges = clockRanges(idxs);
      const btns = `<div class="review-btns">
          <button type="button" class="btn-keep" data-rev="keep" data-gi="${i}">Keep</button>
          <button type="button" class="btn-remove" data-rev="remove" data-gi="${i}">Reject</button>
        </div>`;
      return `<div class="opt-item" data-cycles="${esc(clocks)}">
        <div><strong>${esc(g.label)}</strong> · ${g.count || idxs.length} clock(s)</div>
        <div class="clk">${esc(ranges)}</div>
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
      ? `Downloaded STIL zip. Only ${n} clock(s) you marked Reject were cut.`
      : "Downloaded STIL zip. No Reject yet, so setup clocks are unchanged.";
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
      <p class="clk">${esc(clockRanges(g.cycles || []))}</p>
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
    h2.reject { color: #a15c12; }
    .meta { color: #5b6472; }
    .stats { display: flex; gap: 24px; margin: 16px 0; }
    .item { background: #fff; border: 1px solid #d5dbe3; padding: 12px; margin: 0 0 10px; }
    .item.keep { border-left: 4px solid #1b7a45; }
    .item.reject { border-left: 4px solid #c9841a; }
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
  ${block("Needs engineer review", s.review, "reject")}
  ${block("Rejected after review", s.removed, "reject")}
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
  const filter = state.optimizeRoleFilter || "all";
  $("optStatus").textContent = (s.note || "") + (gpu ? ` Running on CUDA (${gpu}).` : "");
  const showKeep = filter === "all" || filter === "keep";
  const showReject = filter === "all" || filter === "reject";
  $("optBody").innerHTML = `
    <div class="opt-summary">
      <div class="stat"><b>${s.before_clocks ?? "—"}</b><span>setup clocks</span></div>
      <div class="stat"><b>${s.review_clocks ?? "—"}</b><span>need your review</span></div>
      <div class="stat"><b>${s.cut_clocks ?? "—"}</b><span>you removed</span></div>
      <div class="stat"><b>${ltd.n_reviews ?? 0}</b><span>labels in the GBC so far</span></div>
    </div>
    ${roleFilterBar("optimize", filter)}
    <p class="caption">Model: ${esc(ltd.source || "—")}${ltd.model_ready ? " (trained)" : " (rule prior until both Keep and Reject exist)"}. Filter Keep or Reject. You control which clocks are listed. These rejection flags are recommendations only.</p>
    <div class="opt-cols">
      ${
        showKeep
          ? `<div class="opt-col keep">
        <h3>Keep — recommendations to keep</h3>
        <p class="caption">SIB, TDR, IR, first reset, TAP exits — grouped by step. Keep or Reject applies to the whole group.</p>
        ${groupList(s.kept || [], "keep")}
      </div>`
          : ""
      }
      ${
        showReject
          ? `<div class="opt-col review">
        <h3>Recommendations for rejection</h3>
        <p class="caption">Grouped by step — not one row per clock. Recommendations only. Click Keep or Reject on a group to label all of its clocks.</p>
        ${groupList(s.review || [], "review")}
      </div>`
          : ""
      }
    </div>
    ${showReject && (s.removed || []).length ? `<h3>Rejected after your review</h3>${groupList(s.removed, "keep")}` : ""}
  `;
  bindRoleFilter($("optBody"), "optimize", () => renderOptimize(data));
  $("optBody").querySelectorAll("[data-rev]").forEach((btn) => {
    btn.onclick = () => submitReview(btn.getAttribute("data-rev"), btn.closest(".opt-item"));
  });
}

async function submitReview(label, itemEl) {
  if (!state.lastOptimize || !itemEl) return;
  const cycles = String(itemEl.getAttribute("data-cycles") || "")
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
