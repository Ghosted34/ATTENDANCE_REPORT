import {
  escapeHtml as esc, exportFileName, paramFieldsHtml, resolveReportParams, tableHtml,
} from "./template.js";

const $ = (s) => document.querySelector(s);
const view = $("#view");
let token = null, reportList = [];

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

/* ---------- Views ---------- */
function loginView() {
  view.innerHTML = `<form class="panel" id="f">
    <h1>Sign in</h1>
    <div class="field"><label for="u">Username</label><input id="u" autocomplete="username" required autofocus></div>
    <div class="field"><label for="p">Password</label><input id="p" type="password" autocomplete="current-password" required></div>
    <div class="msg err" id="m" role="alert"></div>
    <button class="btn primary" style="width:100%">Sign in</button>
    <p class="hint" style="margin-top:.8rem">Temporary sign-in: admin / admin</p></form>`;
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
  view.innerHTML = `<main class="report">
    <a class="back" href="#/reports">‹ All reports</a>
    <header class="report-head">
      <div><h1>${esc(r.title)}</h1><p class="muted">${esc(r.description)}</p></div>
      <div class="report-meta msg" id="m" role="status"></div>
    </header>
    <form class="toolbar" id="f">
      ${paramFieldsHtml(r, values)}
      <button class="btn primary">Run report</button>
      <span class="spacer"></span>
      <button type="button" class="btn" data-x="xlsx" disabled>Excel</button>
      <button type="button" class="btn" data-x="csv" disabled>CSV</button>
      <button type="button" class="btn" data-x="pdf" disabled>PDF</button>
    </form>
    <div class="table-wrap hidden" id="out"></div></main>`;

  const form = $("#f"), msg = $("#m"), out = $("#out");
  const modeInput = form.elements.mode;
  const valuesNow = () => Object.fromEntries(new FormData(form));
  // Only the visible fields are submitted; the URL's extra keys are appended untouched.
  const qs = () => {
    const params = new URLSearchParams(new FormData(form));
    for (const { name, value } of extra) params.set(name, value);
    return params.toString();
  };
  const setMsg = (t, cls = "") => { msg.textContent = t; msg.className = "report-meta msg " + cls; };

  // Show only the fields for the selected mode; hidden fields are disabled so they are
  // neither validated nor sent, and the server keeps validating whatever arrives.
  const syncMode = () => {
    const mode = modeInput ? modeInput.value : "single";
    for (const field of form.querySelectorAll(".field[data-mode]")) {
      const show = field.dataset.mode === mode;
      field.classList.toggle("hidden", !show);
      field.querySelectorAll("input,select").forEach((el) => (el.disabled = !show));
    }
  };
  if (modeInput) { modeInput.onchange = syncMode; syncMode(); }

  const validate = () => {
    const v = valuesNow();
    if ((v.mode || "single") === "range" && v.start > v.end)
      return "The start date must be on or before the end date.";
    return "";
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const invalid = validate();
    if (invalid) { out.classList.add("hidden"); return setMsg(invalid, "err"); }
    setMsg("Running…");
    form.querySelectorAll("[data-x]").forEach((b) => (b.disabled = true));
    try {
      const { rows, subtitle, columns } = await (await api(`/reports/${id}/data?${qs()}`)).json();
      const cols = columns?.length ? columns : r.columns;
      const range = (valuesNow().mode || "single") === "range";
      out.classList.remove("hidden");
      out.innerHTML = rows.length
        ? tableHtml({ columns: cols, groupBy: r.groupBy, rows })
        : `<div class="empty">No records for this ${range ? "date range" : "date"}. Try another ${range ? "range" : "date"}.</div>`;
      setMsg(`${subtitle} · ${rows.length} record${rows.length === 1 ? "" : "s"}`);
      form.querySelectorAll("[data-x]").forEach((b) => (b.disabled = !rows.length));
    } catch (err) { out.classList.add("hidden"); setMsg(err.message, "err"); }
  };

  form.querySelectorAll("[data-x]").forEach((b) => (b.onclick = async () => {
    const ext = b.dataset.x, label = b.textContent;
    b.disabled = true; b.textContent = "Preparing…";
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
