import ExcelJS from "exceljs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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

export async function toXlsx(report, rows, params) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(report.title.slice(0, 31));
  ws.addRow([report.title]).font = { bold: true, size: 14 };
  ws.addRow([report.subtitle(params)]);
  ws.addRow([]);
  const head = ws.addRow(report.columns.map((c) => c.label));
  head.font = { bold: true };
  head.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } }; });
  for (const g of group(report, rows)) {
    if (g.name !== null) ws.addRow([`${g.name} (${g.rows.length})`]).font = { bold: true };
    for (const r of g.rows) ws.addRow(report.columns.map((c) => r[c.key]));
  }
  ws.addRow([]);
  ws.addRow([`Total: ${rows.length}`]).font = { bold: true };
  report.columns.forEach((c, i) => { ws.getColumn(i + 1).width = Math.max(14, c.label.length + 4); });
  ws.getColumn(1).width = 32;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function toHtml(report, rows, params, brandName) {
  const cols = report.columns;
  const body = group(report, rows).map((g) =>
    (g.name !== null ? `<tr class="g"><td colspan="${cols.length}">${esc(g.name)} (${g.rows.length})</td></tr>` : "") +
    g.rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.align || ""}">${esc(r[c.key])}</td>`).join("")}</tr>`).join("")
  ).join("");
  return `<!doctype html><meta charset="utf-8"><style>
    body{font:12px "Segoe UI",Arial,sans-serif;color:#1e293b;margin:0}
    h1{font-size:18px;margin:0 0 2px}p{margin:0 0 14px;color:#64748b}
    table{width:100%;border-collapse:collapse}th,td{padding:5px 8px;text-align:left;border-bottom:1px solid #e2e8f0}
    th{background:#e2e8f0}.right{text-align:right}.g td{background:#f1f5f9;font-weight:600}
    tr{page-break-inside:avoid}thead{display:table-header-group}
  </style><h1>${esc(report.title)}</h1><p>${esc(report.subtitle(params))} · ${esc(brandName)} · Total ${rows.length}</p>
  <table><thead><tr>${cols.map((c) => `<th class="${c.align || ""}">${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}
