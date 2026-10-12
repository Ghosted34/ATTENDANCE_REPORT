/**
 * Report presentation template — what every report shares.
 *
 * A report definition says *what* to run (id, title, description, params, columns); this
 * template decides *how* it looks (toolbar, group headings, table, exports) and how its
 * inputs are collected.
 *
 * Inputs
 *   - Fixed inputs: the fields a report declares with `type` "date" | "text" | "number",
 *     or an `options` list. Every field is rendered every time; the ones whose `mode` does
 *     not match are hidden and disabled, so they never reach the request.
 *   - Defaults: a field's own `default` (for example today for date fields, or the current
 *     month for month fields) is used until the URL or the user says otherwise.
 *   - Dynamic (extra) inputs: any *other* key in the page URL is passed straight through
 *     to the report on every run and export. Paste the window a report needs, such as
 *     `?mode=range&start=2026-08-16&end=2026-08-19`, and the fields are preset while the
 *     extra keys keep travelling with the request.
 *
 * Presentation
 *   - `groupBy` turns rows into sections with a heading and a count (default: department).
 *   - `columns` (or `columnsFor(params)`) are rendered in order; `align` and `wrap` are
 *     honoured by the table, the CSV, and the printable template.
 */

export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Today in local time as YYYY-MM-DD (the value a date input expects). */
export const isoToday = (now = new Date()) =>
  new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/**
 * Reads a query string into URLSearchParams. It tolerates a pasted lead-in ("?", "&" or
 * "?") and is decoded before splitting, so a query that arrives already escaped
 * ("%3Fmode=range%26start=2026-08-16") is understood as well. Values may not contain a
 * raw or escaped "&" or ";", which is fine for the windows and IDs this app passes along.
 */
export function parseQuery(search = "") {
  const params = new URLSearchParams();
  for (const pair of decode(String(search)).replace(/^[?#&\s]+/, "").split(/[&;]/)) {
    if (!pair) continue;
    const at = pair.indexOf("=");
    const key = (at < 0 ? pair : pair.slice(0, at)).trim();
    if (key) params.set(key, at < 0 ? "" : pair.slice(at + 1));
  }
  return params;
}

const decode = (value) => {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, " "));
  } catch {
    return String(value);
  }
};

/**
 * Merges the URL query string and the field defaults into the values the toolbar starts
 * with, and collects the extra keys to forward. Returns { values, extra }.
 */
export function resolveReportParams(report, { query = parseQuery(location.search), today = isoToday() } = {}) {
  const fields = report.params || [];
  const declared = new Set(fields.map((p) => p.name));
  const values = {};
  for (const field of fields) {
    const fallback = field.default ?? (field.type === "date" ? today : field.type === "month" ? today.slice(0, 7) : "");
    values[field.name] = query.has(field.name) ? query.get(field.name) : fallback;
  }
  const extra = [];
  for (const [name, value] of query) if (!declared.has(name) && value !== "") extra.push({ name, value });
  return { values, extra };
}

/** The toolbar fields for a report, pre-filled from `values`. */
export function paramFieldsHtml(report, values = {}) {
  return (report.params || []).map((p) => {
    const id = `p_${p.name}`;
    const scope = p.mode ? ` data-mode="${escapeHtml(p.mode)}"` : "";
    const label = `<label for="${id}">${escapeHtml(p.label)}</label>`;
    const hint = p.hint ? `<p class="hint">${escapeHtml(p.hint)}</p>` : "";
    if (p.type === "select") {
      const options = (p.options || []).map((option) =>
        `<option value="${escapeHtml(option.value)}"${String(option.value) === String(values[p.name]) ? " selected" : ""}>` +
        `${escapeHtml(option.label)}</option>`).join("");
      return `<div class="field"${scope}>${label}<select id="${id}" name="${escapeHtml(p.name)}">${options}</select>${hint}</div>`;
    }
    const type = ["date", "month", "number"].includes(p.type) ? p.type : "text";
    const required = p.optional ? "" : " required";
    const placeholder = p.placeholder ? ` placeholder="${escapeHtml(p.placeholder)}"` : "";
    return `<div class="field"${scope}>${label}` +
      `<input id="${id}" name="${escapeHtml(p.name)}" type="${type}" value="${escapeHtml(values[p.name] ?? "")}"${placeholder}${required}>` +
      `${hint}</div>`;
  }).join("");
}

/** Default status pill renderer - can be overridden by caller */
export function defaultStatusPill(status) {
  const label = escapeHtml(status);
  return label;
}

/** The results table: sticky head, group headings, right-aligned and wrapping cells. */
export function tableHtml({ columns, groupBy, rows, statusPill = defaultStatusPill }) {
  const cells = (row, tag) => columns.map((c) => {
    let value = row[c.key];
    // Apply status pill to status column if a custom renderer is provided
    if (c.key === "status" && statusPill !== defaultStatusPill) {
      value = statusPill(value);
    }
    return `<${tag} class="${cellClass(c)}">${value}</${tag}>`;
  }).join("");

  const head = `<thead><tr>${columns.map((c) => `<th scope="col" class="${cellClass(c)}">${escapeHtml(c.label)}</th>`).join("")}</tr></thead>`;
  const line = (row) => `<tr>${cells(row, "td")}</tr>`;
  let body = "";
  if (groupBy) {
    for (const [name, list] of sectionsOf(rows, groupBy)) {
      // A null name means the row has no value for the grouping column: the rows still show, with
      // no heading — the same rule server/reports/export.js follows.
      body += (name === null ? "" : `<tr class="grp"><td colspan="${columns.length}">${escapeHtml(name)} (${list.length})</td></tr>`) +
        list.map(line).join("");
    }
  } else {
    body = rows.map(line).join("");
  }

  // Add caption for accessibility
  const caption = groupBy ? `Report grouped by ${Array.isArray(groupBy) ? groupBy.join(" and ") : groupBy}` : "Report";

  return `<table aria-label="${caption}"><caption class="sr-only">${caption}</caption>${head}<tbody>${body}</tbody></table>`;
}

/** Joins the parts of a composite heading ("Front Desk — Present"), matching server/reports/export.js. */
export const GROUP_JOINER = " — ";

/**
 * Rows grouped into headed sections, in the order they arrive. `groupBy` may be one column
 * (department) or several (department *and* status), in which case each combination gets its own
 * heading — that is how the attendance report shows a department's Present and Absent rows apart.
 */
export function sectionsOf(rows, groupBy) {
  const keys = Array.isArray(groupBy) ? groupBy : [groupBy];
  const sections = new Map();
  for (const row of rows) {
    const parts = keys.map((key) => row[key]).filter((value) => value !== null && value !== undefined && value !== "");
    const name = parts.length ? parts.join(GROUP_JOINER) : null;
    if (!sections.has(name)) sections.set(name, []);
    sections.get(name).push(row);
  }
  return sections;
}

const cellClass = (column) => [column.align || "", column.wrap ? "wrap" : ""].join(" ").trim();

/** CSV built from the same columns, so a spreadsheet matches the table. */
export function csvFor({ columns, rows }) {
  const cell = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return "\uFEFF" + [
    columns.map((c) => cell(c.label)).join(","),
    ...rows.map((row) => columns.map((c) => cell(row[c.key])).join(",")),
  ].join("\r\n") + "\r\n";
}

/**
 * Download name: the report id plus its window, e.g. attendance-2026-08-16_to_2026-08-19 for a
 * range or attendance-2026-08 for a month.
 */
export function exportFileName(reportId, values, ext) {
  if ((values.mode || "single") === "month") return `${reportId}-${values.month || "month"}.${ext}`;
  if ((values.mode || "single") === "range") return `${reportId}-${values.start || "range"}_to_${values.end || "range"}.${ext}`;
  return `${reportId}-${values.date || "report"}.${ext}`;
}
