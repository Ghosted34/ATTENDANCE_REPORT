import ExcelJS from "exceljs";
import { escapeHtml as esc, PRINT_PAGE } from "./print-template.js";

export { esc };

export function group(report, rows) {
  if (!report.groupBy) return [{ name: null, rows }];
  const m = new Map();
  for (const r of rows) {
    const k = r[report.groupBy];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m].map(([name, rows]) => ({ name, rows }));
}

/**
 * Columns for a run of exports. A report may vary them by mode, and the printable
 * template may keep a column the on-screen table hides (the attendance report shows
 * Department only as the section heading, which a filtered or sorted sheet would lose).
 */
export const columnsOf = (report, params) =>
  (report.exportColumnsFor || report.columnsFor ? (report.exportColumnsFor || report.columnsFor)(params) : report.columns) || [];

const widthFor = (column) =>
  ["date", "firstEntry", "lastEntry"].includes(column.key) ? 14 : Math.max(14, column.label.length + 4);

export async function toXlsx(report, rows, params) {
  const cols = columnsOf(report, params);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(report.title.slice(0, 31));
  ws.addRow([report.title]).font = { bold: true, size: 14 };
  ws.addRow([report.subtitle(params)]);
  ws.addRow([]);
  const head = ws.addRow(cols.map((c) => c.label));
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } }; });
  for (const g of group(report, rows)) {
    if (g.name !== null) ws.addRow([`${g.name} (${g.rows.length})`]).font = { bold: true };
    for (const r of g.rows) {
      const row = ws.addRow(cols.map((c) => r[c.key]));
      if (cols.some((c) => c.wrap)) row.alignment = { vertical: "top" };
    }
  }
  ws.addRow([]);
  ws.addRow([`Total: ${rows.length}`]).font = { bold: true };
  cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.wrap ? 40 : widthFor(c); });
  ws.getColumn(1).width = cols[0]?.key === "date" ? 14 : 32;
  ws.views = [{ state: "frozen", ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Plain CSV built from the same template columns, for spreadsheets and other tools. */
export function toCsv(report, rows, params) {
  const cols = columnsOf(report, params);
  const cell = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    cols.map((c) => cell(c.label)).join(","),
    ...rows.map((r) => cols.map((c) => cell(r[c.key])).join(",")),
  ];
  // The BOM makes Excel read the file as UTF-8, so dashes and accents survive.
  return Buffer.from(`\uFEFF${lines.join("\r\n")}\r\n`, "utf8");
}

/** The HTML half of the print template: same table the PDF renderers draw. */
export function toHtml(report, rows, params, brandName) {
  const cols = columnsOf(report, params);
  const body = group(report, rows).map((g) =>
    (g.name !== null ? `<tr class="g"><td colspan="${cols.length}">${esc(g.name)} (${g.rows.length})</td></tr>` : "") +
    g.rows.map((r) => `<tr>${cols.map((c) => `<td class="${[c.align || "", c.wrap ? "wrap" : ""].join(" ").trim()}">${esc(r[c.key])}</td>`).join("")}</tr>`).join("")
  ).join("");
  const margin = PRINT_PAGE.marginsPx;
  return `<!doctype html><meta charset="utf-8"><title>${esc(report.title)}</title><style>
    @page{size:${PRINT_PAGE.size} ${PRINT_PAGE.landscape ? "landscape" : "portrait"};
      margin:${Math.round(margin.top * 0.2646)}mm ${Math.round(margin.right * 0.2646)}mm ${Math.round(margin.bottom * 0.2646)}mm}
    body{font:12px "Segoe UI",Arial,sans-serif;color:#1e293b;margin:0}
    h1{font-size:18px;margin:0 0 2px}p{margin:0 0 14px;color:#64748b}
    table{width:100%;border-collapse:collapse}th,td{padding:5px 8px;text-align:left;border-bottom:1px solid #e2e8f0}
    th{background:#e2e8f0}.right{text-align:right}.g td{background:#f1f5f9;font-weight:600}
    td.wrap{white-space:normal;overflow-wrap:anywhere;min-width:180px}
    tr{page-break-inside:avoid}thead{display:table-header-group}
  </style><h1>${esc(report.title)}</h1><p>${esc(report.subtitle(params))} · ${esc(brandName)} · Total ${rows.length}</p>
  <table><thead><tr>${cols.map((c) => `<th class="${[c.align || "", c.wrap ? "wrap" : ""].join(" ").trim()}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}
