import {
  escapeHtml as esc, exportFileName, paramFieldsHtml, resolveReportParams, tableHtml,
  groupByToggleHtml, emptyStateHtml, viewStateOf, visibleColumns, withViewState, VIEW_KEYS,
  PAGE_SIZES, DEFAULT_PAGE_SIZE,
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

/**
 * The app's address space is the hash, so the query a report view carries is the hash's:
 * `#/reports/attendance?mode=range&start=2026-10-05&sort=name&dir=asc`. A real query string is
 * still read as a fallback, so a link made the other way round keeps working.
 */
const hashQuery = () => {
  const at = location.hash.indexOf("?");
  return new URLSearchParams(at >= 0 ? location.hash.slice(at + 1) : location.search);
};

let renderedRoute = null;

/**
 * Closes the Columns panel if it is open. It lives out here because the panel is rebuilt with
 * every report view, and one listener on the document is better than one more added each time.
 */
function closeColumnsMenu() {
  const panel = $("#columnsPanel");
  if (!panel || panel.classList.contains("hidden")) return;
  panel.classList.add("hidden");
  $("#columnsBtn")?.setAttribute("aria-expanded", "false");
}

document.addEventListener("click", (e) => {
  if (!e.target.closest(".columns-menu")) closeColumnsMenu();
});

/**
 * Rewrites the query the current view carries: no hashchange, so nothing re-routes and the form
 * and table keep their state. `search` is the `?...` produced by `withViewState`, or "".
 */
function replaceHashQuery(id, search) {
  const next = `#/reports/${id}${search}`;
  if (location.hash === next) return;
  try {
    // Only the hash changes, which is the one history write a `file://` page is allowed, so this
    // works in the desktop window as well as in a browser.
    history.replaceState(null, "", next);
  } catch {
    // If a future engine refuses it, the view simply stays out of the address: the page keeps
    // working, and the window is still remembered in the cookie.
    return;
  }
  // The route the reader is looking at has changed, so this is not a navigation to hand focus for.
  renderedRoute = location.hash;
}

/* ---------- Helper: Status Pills ---------- */
function statusPill(status) {
  const label = esc(status);
  const icon = status === "Present"
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  return `<span class="status-pill ${status.toLowerCase()}"><span>${icon}</span>${label}</span>`;
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
const GLYPH_SUN = GLYPH('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>', 18);
const GLYPH_MOON = GLYPH('<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>', 18);
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

// Home-screen card icons. A report picks one with `icon` in its definition (server/reports/*.js).
const CARD_SVG = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const CARD_ICONS = {
  calendar: CARD_SVG('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="m9 15 2 2 4-4"/>'),
  "user-x": CARD_SVG('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m17 8 5 5m0-5-5 5"/>'),
  clock: CARD_SVG('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  chart: CARD_SVG('<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>'),
};

function homeView() {
  const cards = reportList.map((r, index) => {
    const icon = CARD_ICONS[r.icon] || CARD_ICONS.calendar;
    const category = esc(r.category || "Report");
    // The red "exception" accent goes with the user-x icon.
    return `<a class="report-card${r.icon === "user-x" ? " report-card--absence" : ""}" href="#/reports/${encodeURIComponent(r.id)}">
      <span class="report-card-icon">${icon}</span>
      <span class="report-card-category">${category}</span>
      <h3>${esc(r.title)}</h3>
      <p>${esc(r.description)}</p>
      <span class="report-card-link">Open report
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </span>
    </a>`;
  }).join("");
  const count = reportList.length;
  view.innerHTML = `<main class="home">
    <header class="home-head">
      <h1 id="homeTitle">Reports</h1>
      <p class="muted">Choose a report.</p>
    </header>
    <section class="report-library" aria-labelledby="homeTitle">
      ${cards
        ? `<div class="report-grid">${cards}</div>`
        : `<div class="no-reports" role="status">
            <span class="no-reports-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="M12 14v3m0 1h.01"/></svg></span>
            <h3>No reports are available</h3>
            <p>This build has no reports registered. Check the server log for a report that failed to load.</p>
          </div>`}
    </section>
    <footer class="home-foot"><span>${esc(appName)}</span><span>${appVersion ? `Version ${esc(appVersion)}` : "Local reporting workspace"}</span></footer>
  </main>`;
}

function reportView(id) {
  const r = reportList.find((x) => x.id === id);
  if (!r) return go("reports");

  // Three sources, in order of authority: the URL (a view someone linked or reloaded), the
  // cookies (the preference they last set) and the report's own defaults.
  const fromUrl = hashQuery();
  const urlView = viewStateOf(fromUrl);
  const { values, extra: forwarded } = resolveReportParams(r, { query: fromUrl });
  // A hand-written URL may say employeeId. The field, the saved view and the query parameter
  // stay idNumber; copying it here is what lets the box show the value that will be filtered.
  if (!String(values.idNumber ?? "").trim() && fromUrl.get("employeeId")) {
    values.idNumber = fromUrl.get("employeeId").trim();
  }
  // The view keys describe how the page is read, not what the report is asked for: they must not
  // travel to it as report parameters (which would also make them appear in every export URL).
  const extra = forwarded.filter(({ name }) => !VIEW_KEYS.includes(name) && name !== "employeeId");

  // Where the URL does not name a window, the last one this report was run with is offered, so
  // reopening "Absentees" does not silently start over at today.
  const remembered = window.getLastWindow?.(id);
  if (remembered) {
    for (const field of r.params || []) {
      if (!fromUrl.has(field.name) && remembered[field.name]) values[field.name] = remembered[field.name];
    }
  }
  let hiddenColumns = window.getHiddenColumns?.(id) || [];

  // Build segmented control for mode
  const modeOptions = r.params?.find(p => p.name === "mode")?.options || [];
  const modeValue = values.mode || modeOptions[0]?.value || "single";

  const modeSegments = modeOptions.map(opt =>
    `<button type="button"
             class="btn"
             data-mode="${esc(opt.value)}"
             aria-pressed="${opt.value === modeValue}"
             tabindex="${opt.value === modeValue ? "0" : "-1"}"
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

  // Grouping: the URL outranks the cookie, which outranks the default.
  const useGroupBy = urlView.groupBy !== null
    ? window.setGroupBy?.(urlView.groupBy) ?? urlView.groupBy
    : (window.getGroupBy !== undefined ? window.getGroupBy() : true);

  view.innerHTML = `<main class="report">
    <a class="back" href="#/reports">All reports</a>
    <header class="report-head">
      <h1>${esc(r.title)}</h1>
      <p class="muted">${esc(r.description)}</p>
    </header>
    <form class="toolbar" id="f">
      <div class="toolbar-filters">
        <div class="field mode-field">
          <span class="field-label">Report for</span>
          <div class="segmented-control" id="modeSegments" role="group" aria-label="Report for">${modeSegments}</div>
          ${modeSelect}
        </div>
        ${paramFieldsHtml(r, values, { omit: ["mode"] })}
        <button class="btn primary run-btn" id="runBtn" aria-keyshortcuts="Control+Enter" data-tooltip="Run report (Ctrl+Enter)">
          <span id="runBtnText">Run report</span>
          <span id="runBtnSpinner" class="spinner hidden"></span>
        </button>
      </div>
      <div class="toolbar-actions">
        <div class="toolbar-view-controls">
          ${groupByToggleHtml(useGroupBy)}
          <div class="columns-field">
            <div class="columns-menu">
              <button type="button" class="btn" id="columnsBtn" aria-label="Visible columns" aria-expanded="false"
                      aria-controls="columnsPanel" data-tooltip="Show or hide columns">
                <span id="columnsCount">Columns</span>
              </button>
              <div class="columns-panel hidden" id="columnsPanel" role="group" aria-label="Columns to show">
                <p class="columns-title">Show columns</p>
                <div class="columns-list" id="columnsList"></div>
                <p class="columns-note">Excel, CSV and PDF always include every column.</p>
              </div>
            </div>
          </div>
        </div>
        <div class="toolbar-export">
          <div class="export-group" id="exportGroup" role="group" aria-label="Export report">
            <button type="button" class="btn" data-x="xlsx" data-label="Excel" disabled data-tooltip="Export to Excel">Excel</button>
            <button type="button" class="btn" data-x="csv" data-label="CSV" disabled data-tooltip="Export to CSV">CSV</button>
            <button type="button" class="btn" data-x="pdf" data-label="PDF" disabled data-tooltip="Export to PDF">PDF</button>
          </div>
        </div>
      </div>
    </form>
    <div class="report-meta msg" id="m" role="status" aria-live="polite"></div>
    <div class="table-wrap hidden" id="out" role="region" aria-label="Report results"></div>
    <div class="table-footer hidden" id="pagination">
      <p class="page-summary" id="pageSummary" role="status" aria-live="polite"></p>
      <div class="page-controls hidden" id="pageControls">
        <label class="page-size" for="pageSize"><span>Rows per page</span>
          <select id="pageSize">${PAGE_SIZES.map((size) => `<option value="${size}"${size === DEFAULT_PAGE_SIZE ? " selected" : ""}>${size}</option>`).join("")}</select>
        </label>
        <nav class="page-nav" id="pageNavigation" aria-label="Report pages">
          <button class="btn page-button" id="previousPage" type="button" aria-label="Previous page">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>
          </button>
          <span class="page-indicator" id="pageIndicator"></span>
          <button class="btn page-button" id="nextPage" type="button" aria-label="Next page">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
          </button>
        </nav>
      </div>
    </div>
    <div id="progressBar" class="progress hidden"><i id="progressInner"></i></div>
  </main>`;

  const form = $("#f"), msg = $("#m"), out = $("#out");
  const modeSegmentsEl = $("#modeSegments");
  const groupByToggleEl = $("#groupByToggle");
  const columnsBtn = $("#columnsBtn");
  const columnsPanel = $("#columnsPanel");
  const columnsList = $("#columnsList");
  const columnsCount = $("#columnsCount");
  const runBtn = $("#runBtn");
  const runBtnText = $("#runBtnText");
  const runBtnSpinner = $("#runBtnSpinner");
  const progressBar = $("#progressBar");
  const exportGroup = $("#exportGroup");
  const pagination = $("#pagination");
  const pageSummary = $("#pageSummary");
  const pageControls = $("#pageControls");
  const pageSizeSelect = $("#pageSize");
  const previousPage = $("#previousPage");
  const nextPage = $("#nextPage");
  const pageIndicator = $("#pageIndicator");

  // The URL restores the view controls and requested slice; Run report fetches the rows again.
  let currentGroupBy = useGroupBy;
  let currentPage = urlView.page || 1;
  let pageSize = urlView.pageSize || DEFAULT_PAGE_SIZE;
  pageSizeSelect.value = String(pageSize);

  // A cleared time field goes back to its default instead of blocking Run report.
  for (const input of form.querySelectorAll("input[data-default]")) {
    input.addEventListener("blur", () => { if (!input.value) input.value = input.dataset.default; });
  }

  const valuesNow = () => Object.fromEntries(new FormData(form));
  const activeWindow = () => {
    const values = valuesNow();
    return Object.fromEntries((r.params || []).map((field) => [field.name, values[field.name]])
      .filter(([, value]) => value !== undefined && value !== ""));
  };
  let comparisonWindow = activeWindow();
  // Filled only after a successful run, so a view toggle before the first run does not write an
  // unrequested default window into the address.
  let runWindow = {};
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

  /**
   * Arrow keys walk a segmented control the way a radio group does. The group is one stop in the
   * tab order — the current option — and the rest are reached by arrow, which is what a pair of
   * mutually exclusive switches should feel like. Moving selects, since nothing here is destructive
   * and the table is not re-queried.
   */
  const wireSegmentedKeys = (container) => {
    const buttons = () => [...container.querySelectorAll("button")];
    const sync = () => {
      const list = buttons();
      const current = list.find((b) => b.getAttribute("aria-pressed") === "true") || list[0];
      for (const button of list) button.tabIndex = button === current ? 0 : -1;
    };
    container.addEventListener("keydown", (e) => {
      const step = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
      const list = buttons();
      const index = list.indexOf(document.activeElement);
      if (index < 0) return;
      let next = null;
      if (step) next = (index + step + list.length) % list.length;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = list.length - 1;
      else return;
      e.preventDefault();
      // Take the same path a mouse click takes, so state, cookie and table stay in one place.
      list[next].click();
      list[next].focus();
      sync();
    });
    sync();
    return sync;
  };

  const syncModeTabs = modeSegmentsEl ? wireSegmentedKeys(modeSegmentsEl) : null;
  let syncGroupTabs = null;

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
      syncModeTabs?.();
    });
  }

  // Handle segmented control for groupBy
  if (groupByToggleEl) {
    syncGroupTabs = wireSegmentedKeys(groupByToggleEl);
    groupByToggleEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-groupby]');
      if (!btn) return;

      const groupBy = btn.dataset.groupby === 'true';
      // Update aria-pressed on all buttons
      groupByToggleEl.querySelectorAll('button').forEach(b => {
        b.setAttribute('aria-pressed', b.dataset.groupby === String(groupBy));
        b.setAttribute('aria-current', b.dataset.groupby === String(groupBy) ? 'true' : 'false');
      });

      // Update preference. A different grouping changes section boundaries, so start again at page one.
      currentGroupBy = groupBy;
      currentPage = 1;
      window.toggleGroupBy();

      syncGroupTabs?.();
      // Re-render through the one path, so the summary, sort caption and address stay in step —
      // and, when there is no table yet, at least the address does.
      if (!out.classList.contains("hidden") && latestPage?.totalRows > 0) renderTable();
      else syncViewInUrl();
    });
  }

  // Day picker (Sun–Sat): each button toggles its day; the hidden input carries "1,3,5".
  form.addEventListener("click", (e) => {
    const btn = e.target.closest(".day-picker .day");
    if (!btn) return;
    btn.setAttribute("aria-pressed", String(btn.getAttribute("aria-pressed") !== "true"));
    const field = btn.closest(".days-field");
    field.querySelector("input[type=hidden]").value = [...field.querySelectorAll('.day[aria-pressed="true"]')]
      .map((b) => b.dataset.day).join(",");
  });

  // Show only the fields for the selected mode; hidden fields are disabled so they are
  // neither validated nor sent, and the server keeps validating whatever arrives.
  const syncMode = () => {
    const mode = valuesNow().mode || "single";
    for (const field of form.querySelectorAll(".field[data-mode]")) {
      const show = field.dataset.mode.split(" ").includes(mode);
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
    setMsg(`${latestSubtitle} · No records found`);
    pagination.classList.add("hidden");
    out.classList.remove("hidden");
    out.innerHTML = emptyStateHtml({ period, canRunAbsentees });
    out.querySelector('[data-empty-action="absentees"]')?.addEventListener("click", openAbsentees);
    out.querySelector('[data-empty-action="date"]')?.addEventListener("click", focusPeriodField);
  };

  // The server keeps the full run; the screen only holds the page on display. `runQs` is the query
  // the report was last run with, so paging never picks up form edits that have not been run.
  let latestPage = null;
  let runQs = "";
  let latestColumns = [];
  let latestSubtitle = "";
  let currentSort = urlView.sort;

  /** The short name of the column the table is ordered by, for the status line. */
  const sortCaption = () => {
    if (!currentSort) return "";
    const column = latestColumns.find((c) => c.key === currentSort.key);
    return column ? ` \u00b7 Sorted by ${column.label}, ${currentSort.dir === "desc" ? "descending" : "ascending"}` : "";
  };

  /** The view the next page request asks for: page, size, sort and grouping. */
  const viewQs = () => {
    const params = new URLSearchParams({ page: String(currentPage), pageSize: String(pageSize), group: currentGroupBy ? "grouped" : "flat" });
    if (currentSort) { params.set("sort", currentSort.key); params.set("dir", currentSort.dir); }
    return params.toString();
  };

  /** Draws the page in hand: table, status line and pager. */
  const drawTable = () => {
    if (!latestPage?.totalRows) return;
    const cols = latestColumns.length ? latestColumns : r.columns;
    const sort = currentSort && cols.some((c) => c.key === currentSort.key) ? currentSort : null;
    const groupBy = currentGroupBy ? r.groupBy : null;
    const page = latestPage;
    const number = (value) => new Intl.NumberFormat().format(value);
    setMsg(`${latestSubtitle} · ${formatSummary(page.summary)}${sortCaption()}`);
    syncColumnsMenu(cols);
    out.classList.remove("hidden");
    out.innerHTML = tableHtml({
      columns: visibleColumns(cols, hiddenColumns),
      groupBy, rows: page.rows, groupCounts: page.groupCounts ? new Map(page.groupCounts) : null, statusPill, sort,
    });

    const first = page.startIndex + 1;
    const last = page.startIndex + page.rows.length;
    pageSummary.textContent = page.totalRows === 1
      ? "Showing 1 record"
      : `Showing ${number(first)}–${number(last)} of ${number(page.totalRows)} records`;
    pageIndicator.textContent = `Page ${number(page.page)} of ${number(page.totalPages)}`;
    pageSizeSelect.value = String(page.pageSize);
    previousPage.disabled = page.page <= 1;
    nextPage.disabled = page.page >= page.totalPages;
    pageControls.classList.toggle("hidden", page.totalRows <= PAGE_SIZES[0]);
    pagination.classList.remove("hidden");
    syncViewInUrl();
  };

  /**
   * Fetches the page for the current view (the server re-uses the run it already has) and draws
   * it. Paging, sorting and the Grouped/Flat switch all come through here. A slower answer that
   * arrives after a newer request is dropped.
   */
  let pageTicket = 0;
  const renderTable = async () => {
    if (!runQs) return;
    const ticket = ++pageTicket;
    try {
      const data = await (await api(`/reports/${id}/data?${runQs}&${viewQs()}`)).json();
      if (ticket !== pageTicket) return;
      latestPage = data;
      currentPage = data.page;
      pageSize = data.pageSize;
      drawTable();
    } catch (err) {
      if (ticket === pageTicket) setMsg(err.message, "err");
    }
  };

  /**
   * How a report is being read belongs in the address, so its controls and requested slice are
   * restored on reload or a link. The rows still need a fresh run; the window is written only
   * after a report has actually been run with it.
   */
  const syncViewInUrl = () => {
    const params = hashQuery();
    for (const [name, value] of Object.entries(runWindow)) params.set(name, value);
    replaceHashQuery(id, withViewState(params, {
      sort: currentSort, groupBy: currentGroupBy, page: currentPage, pageSize,
    }));
  };

  const goToPage = (page) => {
    currentPage = page;
    out.scrollTop = 0;
    renderTable();
  };
  previousPage.addEventListener("click", () => goToPage(currentPage - 1));
  nextPage.addEventListener("click", () => goToPage(currentPage + 1));
  pageSizeSelect.addEventListener("change", () => {
    const firstVisibleRow = (currentPage - 1) * pageSize;
    pageSize = Number(pageSizeSelect.value);
    currentPage = Math.floor(firstVisibleRow / pageSize) + 1;
    renderTable();
  });

  /* ---------- Columns ---------- */

  /** The panel lists the columns actually in play, so it follows the report and the period. */
  const syncColumnsMenu = (cols) => {
    const shown = visibleColumns(cols, hiddenColumns).length;
    columnsCount.textContent = shown === cols.length ? "Columns" : `Columns (${shown}/${cols.length})`;
    columnsList.innerHTML = cols.map((column) => `
      <label class="columns-item">
        <input type="checkbox" value="${esc(column.key)}"${hiddenColumns.includes(column.key) ? "" : " checked"}>
        <span>${esc(column.label)}</span>
      </label>`).join("");
  };

  const openColumnsMenu = (open) => {
    columnsPanel.classList.toggle("hidden", !open);
    columnsBtn.setAttribute("aria-expanded", String(open));
    if (open) columnsList.querySelector("input")?.focus();
  };

  columnsBtn.addEventListener("click", () => openColumnsMenu(columnsPanel.classList.contains("hidden")));

  // One listener for the panel, however often its contents are rebuilt. A hidden column is a
  // preference, not a way to lose the table: the last visible one cannot be switched off.
  columnsList.addEventListener("change", (e) => {
    const checkbox = e.target.closest("input[type=checkbox]");
    if (!checkbox) return;
    const keys = [...columnsList.querySelectorAll("input[type=checkbox]")];
    let hidden = keys.filter((input) => !input.checked).map((input) => input.value);
    if (hidden.length === keys.length) {
      checkbox.checked = true;
      hidden = hidden.filter((key) => key !== checkbox.value);
    }
    hiddenColumns = hidden;
    window.setHiddenColumns?.(id, hiddenColumns);
    drawTable();
  });

  // Escape closes the panel and hands focus back to the button that opened it.
  columnsPanel.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    openColumnsMenu(false);
    columnsBtn.focus();
  });

  // Before a run there are no results to list yet, so the report's own columns are offered: what
  // is switched off there is honoured by the first run.
  syncColumnsMenu(r.columns);

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
    currentPage = 1;
    renderTable();
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const invalid = validate();
    if (invalid) {
      out.classList.add("hidden");
      pagination.classList.add("hidden");
      progressBar.classList.add("hidden");
      return setMsg(invalid, "err");
    }

    const requestedWindow = activeWindow();
    if (JSON.stringify(requestedWindow) !== JSON.stringify(comparisonWindow)) currentPage = 1;

    // Show loading state
    setMsg("Running\u2026");
    runBtn.disabled = true;
    runBtnText.textContent = "Running";
    runBtnSpinner.classList.remove("hidden");
    exportGroup.querySelectorAll("[data-x]").forEach((b) => (b.disabled = true));
    progressBar.classList.remove("hidden");
    out.classList.add("hidden");
    pagination.classList.add("hidden");

    // Animate progress bar
    const progressInner = $("#progressInner");
    progressInner.style.width = "0%";
    progressInner.style.transition = "width 2s ease-in-out";

    try {
      // fresh=1: Run report always re-reads the database; paging afterwards re-uses this run.
      const runQuery = qs();
      const data = await (await api(`/reports/${id}/data?${runQuery}&${viewQs()}&fresh=1`)).json();
      const cols = data.columns?.length ? data.columns : r.columns;

      latestPage = data;
      runQs = runQuery;
      currentPage = data.page;
      pageSize = data.pageSize;
      latestColumns = cols;
      latestSubtitle = data.subtitle;

      // Hide loading state
      progressBar.classList.add("hidden");
      runBtn.disabled = false;
      runBtnText.textContent = "Run report";
      runBtnSpinner.classList.add("hidden");

      // The window that worked is offered next time and written to the address, so a reload or
      // shared link restores those controls rather than today's. The reader can run it again.
      const window_ = activeWindow();
      window.setLastWindow?.(id, window_);
      runWindow = window_;
      comparisonWindow = window_;

      if (data.totalRows) {
        drawTable(); // sets the summary line, page summary and draws one page of the table
        exportGroup.querySelectorAll("[data-x]").forEach((b) => (b.disabled = false));
      } else {
        currentPage = 1;
        syncViewInUrl();
        showEmpty();
      }
    } catch (err) {
      progressBar.classList.add("hidden");
      runBtn.disabled = false;
      runBtnText.textContent = "Run report";
      runBtnSpinner.classList.add("hidden");
      out.classList.add("hidden");
      pagination.classList.add("hidden");

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
          ? '<p class="error-alert-hint">Run <code>npm run doctor</code> to check your database configuration.</p>'
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
  const [, page, rest] = location.hash.split("/");
  const id = rest?.split("?")[0];
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

const themeBtn = $("#themeBtn");
const syncThemeButton = () => {
  const dark = document.documentElement.dataset.theme === "dark";
  const label = dark ? "Switch to light theme" : "Switch to dark theme";
  themeBtn.setAttribute("aria-label", label);
  themeBtn.setAttribute("aria-pressed", String(dark));
  themeBtn.dataset.tooltip = label;
  themeBtn.innerHTML = dark ? GLYPH_MOON : GLYPH_SUN;
};
themeBtn.onclick = () => { window.toggleTheme(); syncThemeButton(); };
syncThemeButton();

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
