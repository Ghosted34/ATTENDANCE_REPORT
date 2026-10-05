const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
  const today = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  view.innerHTML = `<main>
    <a class="back" href="#/reports">‹ All reports</a>
    <h1>${esc(r.title)}</h1><p class="muted">${esc(r.description)}</p>
    <form class="toolbar" id="f">
      ${r.params.map((p) => paramField(p, today)).join("")}
      <button class="btn primary">Run report</button>
      <span class="spacer"></span>
      <button type="button" class="btn" data-x="xlsx" disabled>Export Excel</button>
      <button type="button" class="btn" data-x="pdf" disabled>Export PDF</button>
    </form>
    <div class="msg" id="m" role="status"></div>
    <div class="table-wrap hidden" id="out"></div></main>`;

  const form = $("#f"), msg = $("#m"), out = $("#out");
  const modeInput = form.elements.mode;
  const qs = () => new URLSearchParams(new FormData(form)).toString();
  const values = () => Object.fromEntries(new FormData(form));
  const setMsg = (t, cls = "") => { msg.textContent = t; msg.className = "msg " + cls; };

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
    const v = values();
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
      const range = (values().mode || "single") === "range";
      out.classList.remove("hidden");
      out.innerHTML = rows.length
        ? table(cols, r.groupBy, rows)
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
      const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${id}-${fileStem(values())}.${ext}` });
      a.click(); URL.revokeObjectURL(a.href);
      setMsg(`Saved ${ext === "xlsx" ? "Excel" : "PDF"} file to Downloads.`, "ok");
    } catch (err) { setMsg(err.message, "err"); }
    b.disabled = false; b.textContent = label;
  }));
}

/* Range runs are named for their whole window; single runs for their day. */
function fileStem(v) {
  if ((v.mode || "single") === "range") return v.start && v.end ? `${v.start}_to_${v.end}` : "range";
  return v.date || "report";
}

function paramField(p, today) {
  const id = `p_${p.name}`;
  const mode = p.mode ? ` data-mode="${esc(p.mode)}"` : "";
  if (p.type === "select") {
    const options = (p.options || []).map((o) =>
      `<option value="${esc(o.value)}"${o.value === p.default ? " selected" : ""}>${esc(o.label)}</option>`).join("");
    return `<div class="field"${mode}><label for="${id}">${esc(p.label)}</label>
      <select id="${id}" name="${p.name}">${options}</select></div>`;
  }
  const type = p.type === "date" ? "date" : p.type === "number" ? "number" : "text";
  const value = type === "date" ? today : esc(p.default ?? "");
  return `<div class="field"${mode}><label for="${id}">${esc(p.label)}</label>
    <input id="${id}" name="${p.name}" type="${type}" value="${value}" required></div>`;
}

function table(cols, groupBy, rows) {
  const head = `<thead><tr>${cols.map((c) => `<th class="${c.align || ""}">${esc(c.label)}</th>`).join("")}</tr></thead>`;
  const line = (row) => `<tr>${cols.map((c) => `<td class="${c.align || ""}">${esc(row[c.key])}</td>`).join("")}</tr>`;
  let body = "";
  if (groupBy) {
    const groups = Map.groupBy(rows, (x) => x[groupBy]);
    for (const [name, list] of groups)
      body += `<tr class="grp"><td colspan="${cols.length}">${esc(name)} (${list.length})</td></tr>` + list.map(line).join("");
  } else body = rows.map(line).join("");
  return `<table>${head}<tbody>${body}</tbody></table>`;
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
