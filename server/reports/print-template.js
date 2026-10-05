/**
 * PDF/print template shared by both renderers.
 *
 * The standalone server draws its PDF with PDFKit (`pdf.js`); Electron renders the same
 * HTML through Chromium's `printToPDF`. This module holds what both need so a printed
 * report always looks the same:
 *   - the page setup (A4 landscape, matching margins), and
 *   - a footer with the report name, its window, the brand and "Page x of y".
 *
 * `toHtml()` in export.js renders the matching HTML template; keep margins in sync with
 * the `@page` rule there.
 */

export const PRINT_PAGE = { size: "A4", landscape: true, marginsPx: { top: 34, right: 34, bottom: 44, left: 34 } };

export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Chromium page footer: report title — window on the left, brand · page numbers on the right. */
export function footerTemplate({ title = "", subtitle = "", brandName = "" } = {}) {
  const left = [title, subtitle].filter(Boolean).map(escapeHtml).join(" — ");
  const pages = 'Page <span class="pageNumber"></span> of <span class="totalPages"></span>';
  const right = [escapeHtml(brandName), pages].filter(Boolean).join(" · ");
  return "<div style=\"width:100%;padding:0 34px;display:flex;align-items:center;justify-content:space-between;" +
    "font:8px 'Segoe UI',Arial,sans-serif;color:#64748b;\">" +
    `<span>${left}</span><span>${right}</span></div>`;
}

/** Options for Electron's `webContents.printToPDF`, i.e. the desktop half of the template. */
export function printOptions(meta = {}, { landscape = PRINT_PAGE.landscape } = {}) {
  return {
    landscape,
    pageSize: PRINT_PAGE.size,
    printBackground: true,
    displayHeaderFooter: true,
    margins: { marginType: "custom", ...PRINT_PAGE.marginsPx },
    footerTemplate: footerTemplate(meta),
  };
}
