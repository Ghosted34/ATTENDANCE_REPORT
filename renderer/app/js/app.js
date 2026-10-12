import {
  escapeHtml as esc, exportFileName, paramFieldsHtml, resolveReportParams, tableHtml,
  groupByToggleHtml, emptyStateHtml,
} from "./template.js";

const $ = (s) => document.querySelector(s);
const view = $("#view");
let token = null, reportList = [];
// What /api/meta reports: the sign-in card stamps the build from these before anything else loads.
let appName = "Reports", appVersion = "";
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

// Field and control glyphs, drawn as the widely used Lucide outlines at 16px.
const GLYPH = (paths, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor"` +
  ` stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const GLYPH_USER = GLYPH('<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>');
const GLYPH_LOCK = GLYPH('<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>');
const EYE_SHOW = GLYPH('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>');
const EYE_HIDE = GLYPH('<path d="M2 2l20 20"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/>');

/**
 * Sign in: one card, two fields, one button.
 *
 * The card opens with the product's mark — the same one the top bar draws — so the screen is
 * identifiably this app's before a word is read, then says what to do and nothing else. Each field
 * carries a glyph and the autocomplete hints a password manager reads; the password has a reveal
 * control and a Caps Lock warning. The button reports progress instead of going quiet. A failure
 * lands above the button — where the eye already is — marks both fields `aria-invalid` (which of
 * the pair was wrong is exactly what the server does not say), moves focus to the field to retype,
 * and clears as soon as the user starts fixing it. The footer stamps the build, which is what the
 * sign-in screen of a desktop app is for.
 */
function loginView() {
  view.innerHTML = `<main class="auth">
    <div class="auth-stack">
      <form class="auth-card" id="f">
        <div class="auth-head">
          <span class="brand-mark" aria-hidden="true"></span>
          <h1 class="auth-title">Sign in</h1>
          <p class="auth-sub">Enter your username and password to continue.</p>
        </div>

        <div class="field">
          <label for="u">Username</label>
          <div class="input-affix">
            <span class="field-icon">${GLYPH_USER}</span>
            <input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
          </div>
        </div>

        <div class="field">
          <label for="p">Password</label>
          <div class="input-affix">
            <span class="field-icon">${GLYPH_LOCK}</span>
            <input id="p" name="password" type="password" autocomplete="current-password" required aria-describedby="caps">
            <button type="button" class="reveal" id="reveal" aria-label="Show password" aria-pressed="false">${EYE_SHOW}</button>
          </div>
          <p class="hint hidden" id="caps" role="status">Caps Lock is on.</p>
        </div>

        <div class="msg" id="m" role="alert"></div>

        <button class="btn primary auth-submit" id="sub" type="submit">
          <span id="subText">Sign in</span>
          <span class="spinner hidden" id="subSpin"></span>
        </button>
      </form>
      <footer class="auth-foot">
        <p class="auth-note">Local development build — sign in with <code>admin</code> / <code>admin</code></p>
        ${appVersion ? `<p class="auth-version">${esc(appName)} ${esc(appVersion)}</p>` : ""}
      </footer>
    </div>
  </main>`;

  const form = $("#f"), user = $("#u"), pass = $("#p"), msg = $("#m");
  const submit = $("#sub"), submitText = $("#subText"), submitSpinner = $("#subSpin");
  const reveal = $("#reveal"), caps = $("#caps");

  const setError = (text) => {
    msg.textContent = text;
    // The red box only exists while there is something wrong. Both fields are handed back to the
    // user marked invalid: which of the pair was wrong is exactly what the server does not say.
    msg.className = text ? "msg err" : "msg";
    user.setAttribute("aria-invalid", String(Boolean(text)));
    pass.setAttribute("aria-invalid", String(Boolean(text)));
    if (text) (user.value ? pass : user).focus();
  };

  // The error belongs to the attempt that produced it: typing clears it.
  const clearError = () => { if (msg.textContent) setError(""); };
  user.addEventListener("input", clearError);
  pass.addEventListener("input", clearError);

  // Caps Lock is the most common reason a correct password is refused.
  const syncCaps = (event) => {
    const on = typeof event.getModifierState === "function" && event.getModifierState("CapsLock");
    caps.classList.toggle("hidden", !on);
  };
  pass.addEventListener("keydown", syncCaps);
  pass.addEventListener("keyup", syncCaps);
  pass.addEventListener("blur", () => caps.classList.add("hidden"));

  reveal.addEventListener("click", () => {
    const hiding = pass.type === "text";
    pass.type = hiding ? "password" : "text";
    const label = hiding ? "Show password" : "Hide password";
    reveal.setAttribute("aria-pressed", String(!hiding));
    reveal.setAttribute("aria-label", label);
    reveal.innerHTML = hiding ? EYE_SHOW : EYE_HIDE;
    pass.focus();
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (submit.disabled) return; // one attempt at a time
    setError("");
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
    submitText.textContent = "Signing in";
    submitSpinner.classList.remove("hidden");
    try {
      const res = await api("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: user.value.trim(), password: pass.value }),
      });
      token = (await res.json()).token;
      reportList = await (await api("/reports")).json();
      go("reports");
    } catch (err) {
      setError(err.message);
    } finally {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
      submitText.textContent = "Sign in";
      submitSpinner.classList.add("hidden");
    }
  };
}

function homeView() {
  const list = reportList.map((r) =>
    `<a href="#/reports/${r.id}"><strong>${esc(r.title)}</strong><span class="muted">${esc(r.description)}</span></a>`).join("");
  view.innerHTML = `<main><h1>Reports</h1><p class="muted">Choose a report to run.</p>
    ${list ? `<div class="list">${list}</div>` : `<div class="empty" role="status">
      <h3>No reports are available</h3>
      <p>This build registered none. Check the server log for a report that failed to load.</p>
    </div>`}</main>`;
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

  // The mode travels as a hidden input: the segmented control above draws it and keeps this in
  // step, and `paramFieldsHtml` is told to omit the field so no second mode input can reach the
  // server (a duplicate would arrive at the report as "single,single" and fail validation).
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
      ${paramFieldsHtml(r, values, { omit: ["mode"] })}
      <button class="btn primary" id="runBtn" aria-keyshortcuts="Control+Enter" data-tooltip="Run report (Ctrl+Enter)">
        <span id="runBtnText">Run report</span>
        <span id="runBtnSpinner" class="spinner hidden"></span>
      </button>
      <span class="spacer"></span>
      <div class="export-group" id="exportGroup">
        <button type="button" class="btn" data-x="xlsx" data-label="Excel" disabled data-tooltip="Export to Excel">Excel</button>
        <button type="button" class="btn" data-x="csv" data-label="CSV" disabled data-tooltip="Export to CSV">CSV</button>
        <button type="button" class="btn" data-x="pdf" data-label="PDF" disabled data-tooltip="Export to PDF">PDF</button>
      </div>
      <div class="field" style="margin-left:auto">
        <label>&nbsp;</label>
        ${groupByToggleHtml(useGroupBy)}
      </div>
    </form>
    <div class="table-wrap hidden" id="out" role="region" aria-label="Report results"></div>
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

  const OK_ICON = '<svg class="ok-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M20 6 9 17l-5-5"/></svg>';

  /** Success message with a checkmark; the text is escaped and the icon is ours. */
  const setOk = (t) => {
    msg.innerHTML = `${OK_ICON}<span>${esc(t)}</span>`;
    msg.className = "report-meta msg ok";
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

      // Re-render through the one path, so the summary and sort caption stay in step
      if (!out.classList.contains("hidden") && latestRows.length > 0) renderTable();
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

  // Empty-state actions. "Try Absentees" carries this window over in the query string and then
  // switches reports with a hash change, so the in-memory session token survives (a reload would
  // sign the user out). "Change Date" returns to the field the current period is read from.
  const openAbsentees = () => {
    const url = new URL(location.href);
    url.search = qs();
    history.replaceState(null, "", url);
    go("reports/absentees");
  };

  const focusPeriodField = () => {
    const mode = valuesNow().mode || "single";
    const field = form.querySelector(`.field[data-mode="${mode}"] input`);
    if (!field) return;
    field.scrollIntoView({ block: "center", behavior: "smooth" });
    field.focus();
    // Chromium opens the calendar on demand; it needs the click that got us here.
    if (typeof field.showPicker === "function") { try { field.showPicker(); } catch { /* ignore */ } }
  };

  const showEmpty = () => {
    // The Absentees report shares this window, but not on its own empty state.
    const canRunAbsentees = id !== "absentees" && reportList.some((x) => x.id === "absentees");
    const period = PERIOD_WORDS[valuesNow().mode || "single"] || PERIOD_WORDS.single;
    out.classList.remove("hidden");
    out.innerHTML = emptyStateHtml({ period, canRunAbsentees });
    out.querySelector('[data-empty-action="absentees"]')?.addEventListener("click", openAbsentees);
    out.querySelector('[data-empty-action="date"]')?.addEventListener("click", focusPeriodField);
  };

  // Store latest rows and columns for re-rendering when toggling groupBy
  let latestRows = [];
  let latestColumns = [];
  let latestSubtitle = "";
  let currentSort = null;

  /** The short name of the column the table is ordered by, for the status line. */
  const sortCaption = () => {
    if (!currentSort) return "";
    const column = latestColumns.find((c) => c.key === currentSort.key);
    return column ? ` \u00b7 Sorted by ${column.label}, ${currentSort.dir === "desc" ? "descending" : "ascending"}` : "";
  };

  /**
   * Draws the table from the rows already in hand. Both switches that change the view without
   * re-running the report — Grouped/Flat and a header click — come through here, so the table,
   * the summary and the sort caption cannot disagree about what is on screen.
   */
  const renderTable = () => {
    if (!latestRows.length) return;
    const cols = latestColumns.length ? latestColumns : r.columns;
    // A sort survives a change of period, but not the disappearance of its column.
    const sort = currentSort && cols.some((c) => c.key === currentSort.key) ? currentSort : null;
    currentSort = sort;
    const summary = computeSummary(latestRows, currentGroupBy ? r.groupBy : null);
    setMsg(`${latestSubtitle} · ${formatSummary(summary)}${sortCaption()}`);
    out.classList.remove("hidden");
    out.innerHTML = tableHtml({
      columns: cols, groupBy: currentGroupBy ? r.groupBy : null, rows: latestRows, statusPill, sort,
    });
  };

  // A click on any header orders the table by that column: ascending, descending, then back to
  // the report's own order, which is what the third click is for. The listener is on the
  // container, so it survives every re-render of the table inside it.
  out.addEventListener("click", (e) => {
    const button = e.target.closest("[data-sort-key]");
    if (!button) return;
    const key = button.dataset.sortKey;
    if (!currentSort || currentSort.key !== key) currentSort = { key, dir: "asc" };
    else if (currentSort.dir === "asc") currentSort = { key, dir: "desc" };
    else currentSort = null;
    renderTable();
  });

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

      // Store for re-rendering
      latestRows = rows;
      latestColumns = cols;
      latestSubtitle = subtitle;

      // Hide loading state
      progressBar.classList.add("hidden");
      runBtn.disabled = false;
      runBtnText.textContent = "Run report";
      runBtnSpinner.classList.add("hidden");

      if (rows.length) {
        renderTable(); // sets the summary line and draws the table
        exportGroup.querySelectorAll("[data-x]").forEach((b) => (b.disabled = false));
      } else {
        showEmpty();
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

  // An export that ignores the table's order would be a different report from the one on screen,
  // so the sort travels with the request and the server applies the same comparator.
  const exportQs = () => {
    const params = new URLSearchParams(qs());
    if (currentSort) { params.set("sort", currentSort.key); params.set("dir", currentSort.dir); }
    return params.toString();
  };

  form.querySelectorAll("[data-x]").forEach((b) => (b.onclick = async () => {
    const ext = b.dataset.x, label = b.dataset.label || b.textContent.trim();
    b.disabled = true; b.textContent = "Preparing\u2026";
    let saved = false;
    try {
      const blob = await (await api(`/reports/${id}/${ext}?${exportQs()}`)).blob();
      const a = Object.assign(document.createElement("a"), {
        href: URL.createObjectURL(blob), download: exportFileName(id, valuesNow(), ext),
      });
      a.click(); URL.revokeObjectURL(a.href);
      saved = true;
      setOk(`Saved ${label} file.`);
    } catch (err) { setMsg(err.message, "err"); }
    b.disabled = false;
    if (!saved) { b.textContent = label; return; }
    // The button itself confirms the save, then goes back to its own name.
    b.textContent = "\u2713 Saved!";
    setTimeout(() => { if (b.textContent === "\u2713 Saved!") b.textContent = label; }, 1600);
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

// Nothing is a full page load here, so the browser has no reason to move focus: a keyboard user
// who opened a report would be left on a link that no longer exists. Each navigation hands focus
// to the new page's heading instead — except on the first render (nothing was replaced) and on
// the sign-in card, which puts focus in the username field itself.
let renderedRoute = null;

function handFocusToView() {
  const route_ = location.hash;
  const navigate = renderedRoute !== null && renderedRoute !== route_;
  renderedRoute = route_;
  if (!navigate) return;
  const heading = view.querySelector("h1");
  if (!heading || view.querySelector(".auth-card")) return;
  heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

function route() {
  const [, page, id] = location.hash.split("/");
  $("#signOut").classList.toggle("hidden", !token);
  // Row height only means something where there is a table to set it for.
  densityBtn?.classList.toggle("hidden", !token);
  if (!token) {
    if (page !== "login") return go("login");
    document.title = `Sign in \u00b7 ${appName}`;
    renderedRoute = location.hash;
    return loginView();
  }
  if (page === "reports" && id) {
    const report = reportList.find((x) => x.id === id);
    document.title = report ? `${report.title} \u00b7 ${appName}` : appName;
    reportView(id);
  } else if (page === "reports") {
    document.title = appName;
    homeView();
  } else {
    return go("reports");
  }
  handFocusToView();
}

$("#themeBtn").onclick = () => window.toggleTheme();

// Density lives in the top bar next to the theme: it is a property of the desk, not of a report.
const densityBtn = $("#densityBtn");
if (densityBtn) {
  const syncDensity = () => {
    const compact = (document.documentElement.dataset.density || "comfortable") === "compact";
    densityBtn.setAttribute("aria-pressed", String(compact));
    densityBtn.dataset.tooltip = compact ? "Row density: compact (32px)" : "Row density: comfortable (40px)";
  };
  densityBtn.onclick = () => { window.toggleDensity(); syncDensity(); };
  syncDensity();
}

$("#signOut").onclick = () => { token = null; reportList = []; go("login"); };
addEventListener("hashchange", route);
fetch("/api/meta").then((r) => r.json()).then(({ name, version }) => {
  appName = name; appVersion = version || "";
  $("#brand").textContent = name; document.title = name;
}).finally(route);
