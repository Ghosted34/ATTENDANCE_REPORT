import {
  escapeHtml as esc, exportFileName, paramFieldsHtml, resolveReportParams, tableHtml,
} from "./template.js";

const $ = (s) => document.querySelector(s);
const view = $("#view");
let token = null, reportList = [];
const PERIOD_WORDS = { single: "date", range: "date range", month: "month" };

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (res.status === 401 && token) { token = null; go("login"); throw new Error("Your session ended. Sign in again."); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Request failed.");
  return res;
}
const go = (p) => { location.hash = "#/" + p; };

/* ---------- Helper: Status Pills ---------- */
function statusPill(status) {
  const label = esc(status);
  const icon = status === "Present"
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  return `<span class="status-pill ${status.toLowerCase()}"><span>${icon}</span>${label}</span>`;
}

/* ---------- Helper: Compute Summary ---------- */
function computeSummary(rows, groupBy) {
  if (!rows || rows.length === 0) return { total: 0, present: 0, absent: 0, departments: 0 };

  const total = rows.length;
  let present = 0, absent = 0;
  const departments = new Set();

  for (const row of rows) {
    departments.add(row.department);
    if (row.status === "Present") present++;
    else if (row.status === "Absent") absent++;
  }

  return {
    total,
    present,
    absent,
    departments: departments.size
  };
}

/* ---------- Helper: Format Summary Text ---------- */
function formatSummary(summary) {
  const parts = [];
  parts.push(`${summary.total} record${summary.total === 1 ? "" : "s"}`);
  if (summary.present > 0) parts.push(`${summary.present} present`);
  if (summary.absent > 0) parts.push(`${summary.absent} absent`);
  if (summary.departments > 0) parts.push(`${summary.departments} department${summary.departments === 1 ? "" : "s"}`);
  return parts.join(" \u00b7 ");
}

/* ---------- Views ---------- */
function loginView() {
  view.innerHTML = `<form class="panel" id="f">
    <h1>Sign in</h1>
    <div class="field"><label for="u">Username</label><input id="u" autocomplete="username" required autofocus></div>
    <div class="field"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required></div>
    <div class="msg err" id="m" role="alert"></div>
    <button class="btn primary" style="width:100%">Sign in</button>
    <p class="hint" style="margin-top:var(--sp-4);text-align:center">Temporary sign-in: admin / admin</p></form>`;
  $("#f").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await api("/auth/login", { method: "POST", body: JSON.stringify({ username: $("#u").value, password: $("#p").value }) });
      token = (await res.json()).token;
      reportList = await (await api("/reports")).json();
      go("reports");
    } catch (err) { $("#m").textContent = err.message; }
  };
}

function homeView() {
  view.innerHTML = `<main><h1>Reports</h1><p class="muted">Choose a report to run.</p>
    <div class="list">${reportList.map((r) =>
      `<a href="#/reports/${r.id}"><strong>${esc(r.title)}</strong><span class="muted">${esc(r.description)}</span></a>`).join("")}</div></main>`;
}

function reportView(id) {
  const r = reportList.find((x) => x.id === id);
  if (!r) return go("reports");
  // The report's own template fills in its fields; extra query-string keys travel through.
  const { values, extra } = resolveReportParams(r);

  // Build segmented control for mode
  const modeOptions = r.params?.find(p => p.name === "mode")?.options || [];
  const modeValue = values.mode || modeOptions[0]?.value || "single";

  const modeSegments = modeOptions.map(opt =>
    `<button type="button"
             class="btn"
             data-mode="${esc(opt.value)}"
             aria-pressed="${opt.value === modeValue}"
             ${opt.value === modeValue ? 'aria-current="true"' : ''}>
      ${esc(opt.label)}
    </button>`
  ).join("");

  // Build the mode field (hidden select for form submission)
  const modeSelect = r.params?.find(p => p.name === "mode")
    ? `<input type="hidden" name="mode" id="p_mode" value="${esc(modeValue)}">`
    : "";

  // Get groupBy preference
  const useGroupBy = window.getGroupBy !== undefined ? window.getGroupBy() : true;

  view.innerHTML = `<main class="report">
    <a class="back" href="#/reports">All reports</a>
    <header class="report-head">
      <div><h1>${esc(r.title)}</h1><p class="muted">${esc(r.description)}</p></div>
      <div class="report-meta msg" id="m" role="status" aria-live="polite"></div>
    </header>
    <form class="toolbar" id="f">
      <div class="field">
        <label>Report for</label>
        <div class="segmented-control" id="modeSegments">${modeSegments}</div>
        ${modeSelect}
      </div>
      ${paramFieldsHtml(r, values).replace(/<div class="field" data-mode="[^"]*"><label for="p_mode">[\s\S]*?<\/div>/g, '')}
      <button class="btn primary" id="runBtn">
        <span id="runBtnText">Run report</span>
        <span id="runBtnSpinner" class="spinner hidden"></span>
      </button>
      <span class="spacer"></span>
      <div class="export-group" id="exportGroup">
        <button type="button" class="btn" data-x="xlsx" disabled data-tooltip="Export to Excel">Excel</button>
        <button type="button" class="btn" data-x="csv" disabled data-tooltip="Export to CSV">CSV</button>
        <button type="button" class="btn" data-x="pdf" disabled data-tooltip="Export to PDF">PDF</button>
      </div>
      <div class="field" style="margin-left:auto">
        <label>&nbsp;</label>
        <div class="segmented-control" id="groupByToggle" style="width:auto" data-tooltip="Toggle grouped view by department">
          <button type="button" class="btn" data-groupby="true" aria-pressed="${useGroupBy}" aria-current="${useGroupBy ? 'true' : 'false'}">Grouped</button>
          <button type="button" class="btn" data-groupby="false" aria-pressed="${!useGroupBy}" aria-current="${!useGroupBy ? 'true' : 'false'}">Flat</button>
        </div>
      </div>
    </form>
    <div class="table-wrap hidden" id="out" role="region" aria-live="polite"></div>
    <div id="resultsInfo" class="hidden"></div>
    <div id="progressBar" class="progress hidden"><i id="progressInner"></i></div></main>`;

  const form = $("#f"), msg = $("#m"), out = $("#out");
  const modeSegmentsEl = $("#modeSegments");
  const groupByToggleEl = $("#groupByToggle");
  const runBtn = $("#runBtn");
  const runBtnText = $("#runBtnText");
  const runBtnSpinner = $("#runBtnSpinner");
  const progressBar = $("#progressBar");
  const exportGroup = $("#exportGroup");

  // Current groupBy state
  let currentGroupBy = window.getGroupBy !== undefined ? window.getGroupBy() : true;

  const valuesNow = () => Object.fromEntries(new FormData(form));
  // Only the visible fields are submitted; the URL's extra keys are appended untouched.
  const qs = () => {
    const params = new URLSearchParams(new FormData(form));
    for (const { name, value } of extra) params.set(name, value);
    return params.toString();
  };

  const setMsg = (t, cls = "") => {
    msg.textContent = t;
    msg.className = "report-meta msg " + cls;
  };

  // Handle segmented control for mode
  if (modeSegmentsEl) {
    modeSegmentsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mode]');
      if (!btn) return;

      const mode = btn.dataset.mode;
      // Update aria-pressed on all buttons
      modeSegmentsEl.querySelectorAll('button').forEach(b => {
        b.setAttribute('aria-pressed', b.dataset.mode === mode);
        b.setAttribute('aria-current', b.dataset.mode === mode ? 'true' : 'false');
      });

      // Update hidden input
      const hiddenInput = form.querySelector('input[name="mode"]');
      if (hiddenInput) hiddenInput.value = mode;

      // Sync field visibility
      syncMode();
    });
  }

  // Handle segmented control for groupBy
  if (groupByToggleEl) {
    groupByToggleEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-groupby]');
      if (!btn) return;

      const groupBy = btn.dataset.groupby === 'true';
      // Update aria-pressed on all buttons
      groupByToggleEl.querySelectorAll('button').forEach(b => {
        b.setAttribute('aria-pressed', b.dataset.groupby === String(groupBy));
        b.setAttribute('aria-current', b.dataset.groupby === String(groupBy) ? 'true' : 'false');
      });

      // Update preference
      currentGroupBy = groupBy;
      window.toggleGroupBy();

      // Re-render table if results are visible
      if (!out.classList.contains('hidden') && latestRows.length > 0) {
        const cols = latestColumns.length ? latestColumns : r.columns;
        const summary = computeSummary(latestRows, currentGroupBy ? r.groupBy : null);
        const summaryText = formatSummary(summary);
        setMsg(`${latestSubtitle} \u00b7 ${summaryText}`);
        out.innerHTML = tableHtml({ columns: cols, groupBy: currentGroupBy ? r.groupBy : null, rows: latestRows, statusPill });
      }
    });
  }

  // Show only the fields for the selected mode; hidden fields are disabled so they are
  // neither validated nor sent, and the server keeps validating whatever arrives.
  const syncMode = () => {
    const mode = valuesNow().mode || "single";
    for (const field of form.querySelectorAll(".field[data-mode]")) {
      const show = field.dataset.mode === mode;
      field.classList.toggle("hidden", !show);
      field.querySelectorAll("input,select").forEach((el) => (el.disabled = !show));
    }
  };
  syncMode();

  const validate = () => {
    const v = valuesNow();
    if ((v.mode || "single") === "range" && v.start > v.end)
      return "The start date must be on or before the end date.";
    return "";
  };

  // Store latest rows and columns for re-rendering when toggling groupBy
  let latestRows = [];
  let latestColumns = [];
  let latestSubtitle = "";

  form.onsubmit = async (e) => {
    e.preventDefault();
    const invalid = validate();
    if (invalid) {
      out.classList.add("hidden");
      progressBar.classList.add("hidden");
      return setMsg(invalid, "err");
    }

    // Show loading state
    setMsg("Running\u2026");
    runBtn.disabled = true;
    runBtnText.textContent = "Running";
    runBtnSpinner.classList.remove("hidden");
    exportGroup.querySelectorAll("[data-x]").forEach((b) => (b.disabled = true));
    progressBar.classList.remove("hidden");
    out.classList.add("hidden");

    // Animate progress bar
    const progressInner = $("#progressInner");
    progressInner.style.width = "0%";
    progressInner.style.transition = "width 2s ease-in-out";

    try {
      const { rows, subtitle, columns } = await (await api(`/reports/${id}/data?${qs()}`)).json();
      const cols = columns?.length ? columns : r.columns;
      const period = PERIOD_WORDS[valuesNow().mode || "single"] || PERIOD_WORDS.single;

      // Store for re-rendering
      latestRows = rows;
      latestColumns = cols;
      latestSubtitle = subtitle;

      // Compute summary
      const summary = computeSummary(rows, currentGroupBy ? r.groupBy : null);
      const summaryText = formatSummary(summary);

      // Update message with summary
      setMsg(`${subtitle} \u00b7 ${summaryText}`);

      // Hide loading state
      progressBar.classList.add("hidden");
      runBtn.disabled = false;
      runBtnText.textContent = "Run report";
      runBtnSpinner.classList.add("hidden");

      if (rows.length) {
        out.classList.remove("hidden");
        out.innerHTML = tableHtml({ columns: cols, groupBy: currentGroupBy ? r.groupBy : null, rows, statusPill });
        exportGroup.querySelectorAll("[data-x]").forEach((b) => (b.disabled = false));
      } else {
        out.classList.remove("hidden");
        out.innerHTML = `<div class="empty" role="status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>
          <h3>No records for this ${period}</h3>
          <p>Try another ${period}, or run the Absentees report for the same window.</p>
        </div>`;
      }
    } catch (err) {
      progressBar.classList.add("hidden");
      runBtn.disabled = false;
      runBtnText.textContent = "Run report";
      runBtnSpinner.classList.add("hidden");
      out.classList.add("hidden");

      // Check if it's an error that needs special handling
      const errorMsg = err.message;
      if (errorMsg.includes("241") || errorMsg.includes("242") || errorMsg.includes("9810")) {
        setMsg(`Error: ${errorMsg}. Run npm run doctor to check your database configuration.`, "err");
      } else {
        setMsg(errorMsg, "err");
      }

      // Show error alert
      out.innerHTML = `<div class="error-alert" role="alert">
        <h4>Report Error</h4>
        <p>${esc(errorMsg)}</p>
        ${errorMsg.includes("241") || errorMsg.includes("242") || errorMsg.includes("9810")
          ? '<p style="margin-top:var(--sp-2);font-size:var(--text-hint)">Run <code>npm run doctor</code> to check your database configuration.</p>'
          : ''}
      </div>`;
      out.classList.remove("hidden");
    }
  };

  form.querySelectorAll("[data-x]").forEach((b) => (b.onclick = async () => {
    const ext = b.dataset.x, label = b.textContent;
    b.disabled = true; b.textContent = "Preparing\u2026";
    try {
      const blob = await (await api(`/reports/${id}/${ext}?${qs()}`)).blob();
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(blob), download: exportFileName(id, valuesNow(), ext),
      });
      a.click(); URL.revokeObjectURL(a.href);
      setMsg(`Saved ${label} file to Downloads.`, "ok");
    } catch (err) { setMsg(err.message, "err"); }
    b.disabled = false; b.textContent = label;
  }));

  // Add Ctrl+Enter shortcut
  form.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      e.preventDefault();
      form.dispatchEvent(new Event('submit'));
    }
  });
}

/* ---------- Router ---------- */
function route() {
  const [, page, id] = location.hash.split("/");
  $("#signOut").classList.toggle("hidden", !token);
  if (!token) { if (page !== "login") return go("login"); return loginView(); }
  if (page === "reports" && id) return reportView(id);
  if (page === "reports") return homeView();
  go("reports");
}

$("#themeBtn").onclick = () => window.toggleTheme();
$("#signOut").onclick = () => { token = null; reportList = []; go("login"); };
addEventListener("hashchange", route);
fetch("/api/meta").then((r) => r.json()).then(({ name }) => {
  $("#brand").textContent = name; document.title = name;
}).finally(route);
