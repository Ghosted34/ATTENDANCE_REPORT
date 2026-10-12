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
 *   - Dynamic (extra) inputs: any unrecognized *report* key in the page URL is passed through
 *     to the report on every run and export. The reserved sort, grouping and pagination keys are
 *     removed before the request. Paste a window such as
 *     `?mode=range&start=2026-08-16&end=2026-08-19` and the fields are preset while other report
 *     keys keep travelling with the request.
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

/**
 * The keys that describe *how* a report is being read rather than *what* it asked the database
 * for: sort order, grouping, and the current page size. They live in the URL so a view can be
 * bookmarked and shared, and they are kept out of what travels to the report — a report is asked
 * about a window, not about its presentation.
 */
export const VIEW_KEYS = Object.freeze(["sort", "dir", "group", "page", "pageSize"]);
export const PAGE_SIZES = Object.freeze([25, 50, 100]);
export const DEFAULT_PAGE_SIZE = 50;

/** The view a query string asks for. `null` means "not specified here", not "false". */
export function viewStateOf(search = "") {
  const query = search instanceof URLSearchParams ? search : parseQuery(search);
  const dir = query.get("dir") === "desc" ? "desc" : query.get("dir") === "asc" ? "asc" : null;
  const key = (query.get("sort") || "").trim();
  const group = query.get("group");
  const pageValue = Number(query.get("page"));
  const sizeValue = Number(query.get("pageSize"));
  return {
    sort: key && dir ? { key, dir } : null,
    groupBy: group === "grouped" ? true : group === "flat" ? false : null,
    page: Number.isSafeInteger(pageValue) && pageValue > 1 ? pageValue : null,
    pageSize: PAGE_SIZES.includes(sizeValue) ? sizeValue : null,
  };
}

/** The same query string with the view state written into it, or taken out of it. */
export function withViewState(search = "", { sort = null, groupBy = null, page = null, pageSize = null } = {}) {
  const params = search instanceof URLSearchParams ? search : parseQuery(search);
  for (const key of VIEW_KEYS) params.delete(key);
  if (sort?.key && (sort.dir === "asc" || sort.dir === "desc")) {
    params.set("sort", sort.key);
    params.set("dir", sort.dir);
  }
  if (groupBy === true || groupBy === false) params.set("group", groupBy ? "grouped" : "flat");

  // Page size is explicit on later pages so a shared link always opens at the same boundary,
  // even when the person opening it has a different local preference.
  const pageNumber = Number(page);
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : DEFAULT_PAGE_SIZE;
  if (Number.isSafeInteger(pageNumber) && pageNumber > 1) {
    params.set("page", String(pageNumber));
    params.set("pageSize", String(size));
  } else if (size !== DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(size));
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

/**
 * The columns a reader has left visible. Hiding is a view preference, so it can never empty the
 * table: asking for all of them to go returns the list untouched.
 */
export function visibleColumns(columns = [], hidden = []) {
  const shown = columns.filter((column) => !hidden.includes(column.key));
  return shown.length ? shown : columns;
}

/**
 * The toolbar fields for a report, pre-filled from `values`. A caller that draws a field itself —
 * the report screen renders the mode as a segmented control with its own hidden input — names it in
 * `omit`, so the field is left out before it is rendered rather than patched out of the markup.
 */
export function paramFieldsHtml(report, values = {}, { omit = [] } = {}) {
  return (report.params || []).filter((p) => !omit.includes(p.name)).map((p) => {
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

/* Inline icons for the toolbar and the states. Decorative only: every control they sit in
   carries its own text label, so they are hidden from assistive technology. */
const ICON = (paths, size = 14) =>
  `<svg class="seg-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"` +
  ` stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"` +
  ` aria-hidden="true">${paths}</svg>`;

/** Stacked layers — rows gathered under a department heading. */
export const ICON_GROUPED = ICON('<path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z"/><path d="m3 12.4 9 4.5 9-4.5"/><path d="m3 16.9 9 4.5 9-4.5"/>');

/** Even rows — one flat list. */
export const ICON_FLAT = ICON('<path d="M3 6h18M3 12h18M3 18h18"/>');

/**
 * The Grouped/Flat switch at the end of the toolbar: whether the table keeps a heading and a
 * count per department, or lists every row in one run. Labels name the *outcome* ("By Dept",
 * "All Together") rather than the mechanism, and each option carries an icon and a tooltip.
 */
export function groupByToggleHtml(useGroupBy = true) {
  const active = (value) => (value === Boolean(useGroupBy) ? "true" : "false");
  const option = (value, label, tooltip, icon) =>
    `<button type="button" class="btn" data-groupby="${value}"` +
    ` aria-pressed="${active(value)}" aria-current="${active(value)}" data-tooltip="${escapeHtml(tooltip)}">` +
    `${icon}<span>${escapeHtml(label)}</span></button>`;
  return `<div class="segmented-control" id="groupByToggle" role="group" aria-label="Row grouping">` +
    option(true, "By Dept", "Group rows under a heading per department", ICON_GROUPED) +
    option(false, "All Together", "One flat list of every row", ICON_FLAT) +
    `</div>`;
}

/**
 * The empty state for a run that came back with no rows: what happened, and the two things
 * worth doing next — open the same window on the Absentees report (`canRunAbsentees`, false on
 * that report itself and on a deployment that does not offer it), or pick another period.
 */
export function emptyStateHtml({ period = "date", canRunAbsentees = false } = {}) {
  const word = escapeHtml(period);
  const changeLabel = period === "month" ? "Change Month" : "Change Date";
  const next = canRunAbsentees
    ? `<p>Try another ${word}, or run the Absentees report for the same window.</p>`
    : `<p>Try another ${word}.</p>`;
  const actions = [
    canRunAbsentees ? '<button type="button" class="btn" data-empty-action="absentees">Try Absentees</button>' : "",
    `<button type="button" class="btn" data-empty-action="date">${changeLabel}</button>`,
  ].filter(Boolean).join("");
  return `<div class="empty" role="status">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/></svg>
    <h3>No records for this ${word}</h3>
    ${next}
    <div class="empty-actions">${actions}</div>
  </div>`;
}

/**
 * Rows in the order the reader asked for: by a column, its own way (numbers numerically, dates
 * and clock times as text — both sort chronologically that way — names the way a person would).
 * Rows with nothing in that column stay at the bottom in both directions, which is what people
 * expect when they sort a report that has blanks in it.
 */
export function sortRows(rows, sort = {}) {
  const { key, dir } = sort || {};
  if (!key || !dir) return rows;
  const sign = dir === "desc" ? -1 : 1;
  const blank = (row) => (row[key] === null || row[key] === undefined || row[key] === "" ? 1 : 0);
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const gaps = blank(a.row) - blank(b.row);
      if (gaps) return gaps;
      if (blank(a.row)) return a.index - b.index; // blanks keep their order
      const left = a.row[key], right = b.row[key];
      const order = typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" });
      // The index keeps equal values in the order the report produced them.
      return order ? order * sign : a.index - b.index;
    })
    .map(({ row }) => row);
}

/**
 * Sorts in the same order the table displays, then returns only one page. Grouped reports keep
 * their section order and sort inside each section; the count map lets a section split across two
 * pages keep showing its full result count rather than a misleading count for just that page.
 */
export function paginateRows(rows = [], { page = 1, pageSize = DEFAULT_PAGE_SIZE, groupBy = null, sort = null } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const requestedSize = Number(pageSize);
  const size = Number.isSafeInteger(requestedSize) && requestedSize > 0 ? requestedSize : DEFAULT_PAGE_SIZE;
  const requestedPage = Number(page);
  const totalRows = list.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / size));
  const currentPage = Number.isSafeInteger(requestedPage)
    ? Math.min(totalPages, Math.max(1, requestedPage))
    : 1;
  let ordered;
  let groupCounts = null;

  if (groupBy) {
    const sections = [...sectionsOf(list, groupBy)];
    groupCounts = new Map(sections.filter(([name]) => name !== null).map(([name, section]) => [name, section.length]));
    ordered = sections.flatMap(([, section]) => sortRows(section, sort));
  } else {
    ordered = sortRows(list, sort);
  }

  const startIndex = (currentPage - 1) * size;
  return {
    rows: ordered.slice(startIndex, startIndex + size),
    page: currentPage,
    pageSize: size,
    totalRows,
    totalPages,
    startIndex,
    groupCounts,
  };
}

/** The caret on a sorted header. Decoration: `aria-sort` on the cell carries the meaning. */
const CARET_ASC = '<svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 15 6-6 6 6"/></svg>';
const CARET_DESC = '<svg class="caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

/** Widths are a property of the column, not of its position: `minWidth` in the report's own
    column list. Keying them to `nth-child` in CSS put the Name column's width on Employee ID as
    soon as a report or period changed the number of columns in front of it. */
const widthOf = (column) => {
  const min = Number(column.minWidth);
  return Number.isFinite(min) && min > 0 ? ` style="min-width:${min}px"` : "";
};

/** The results table: sticky head, group headings, right-aligned and wrapping cells. */
export function tableHtml({ columns, groupBy, rows, statusPill = defaultStatusPill, sort = null, groupCounts = null }) {
  const sorted = (list) => (sort ? sortRows(list, sort) : list);
  const cells = (row, tag) => columns.map((c) => {
    let value = row[c.key];
    // A value the report never filled in is a blank cell, not the word "null".
    if (value === null || value === undefined) value = "";
    // Apply status pill to status column if a custom renderer is provided
    if (c.key === "status" && statusPill !== defaultStatusPill) {
      value = statusPill(value);
    }
    return `<${tag} class="${cellClass(c)}"${widthOf(c)}>${value}</${tag}>`;
  }).join("");

  const head = `<thead><tr>${columns.map((c) => {
    // aria-sort belongs on the sorted column only, and in words rather than an arrow.
    const active = sort && sort.key === c.key ? sort.dir : null;
    const ariaSort = active ? ` aria-sort="${active === "desc" ? "descending" : "ascending"}"` : "";
    const caret = active === "desc" ? CARET_DESC : active ? CARET_ASC : "";
    return `<th scope="col" class="${cellClass(c)}"${widthOf(c)}${ariaSort}>` +
      `<button type="button" class="th-sort" data-sort-key="${escapeHtml(c.key)}">` +
      `${escapeHtml(c.label)}${caret}</button></th>`;
  }).join("")}</tr></thead>`;
  const line = (row) => `<tr>${cells(row, "td")}</tr>`;
  // Each section is its own `<tbody>`, which is what confines the sticky heading to the rows it
  // names: it is pushed out by the next department rather than piling up with the others.
  let body = "";
  if (groupBy) {
    for (const [name, list] of sectionsOf(rows, groupBy)) {
      // Sorting orders the rows inside each heading; the headings keep the report's own order, so
      // sorting by name does not shuffle the departments around.
      const ordered = sorted(list);
      // A null name means the row has no value for the grouping column: the rows still show, with
      // no heading — the same rule server/reports/export.js follows.
      body += "<tbody>" +
        (name === null ? "" : `<tr class="grp"><td colspan="${columns.length}">${escapeHtml(name)} (${groupCounts?.get(name) ?? ordered.length})</td></tr>`) +
        ordered.map(line).join("") + "</tbody>";
    }
  } else {
    body = `<tbody>${sorted(rows).map(line).join("")}</tbody>`;
  }

  // The caption is the table's accessible name: it is announced once, and it is what the
  // `scope` attributes are read against. An aria-label alongside it would say it all twice.
  const caption = groupBy ? `Report grouped by ${Array.isArray(groupBy) ? groupBy.join(" and ") : groupBy}` : "Report";

  return `<table${groupBy ? ' class="grouped"' : ""}><caption class="sr-only">${caption}</caption>${head}${body}</table>`;
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
