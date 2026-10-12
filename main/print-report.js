import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { printOptions } from "../server/reports/print-template.js";

/**
 * Electron's half of the print template: report HTML in, PDF buffer out.
 *
 * The report used to be handed to Chromium as a `data:text/html;charset=utf-8,…` URL. That only
 * works while the document stays well under Chromium's ~2 MB URL limit, and a real report does
 * not: August 2026 with absentees (18,517 rows) encodes to about 8.6 MB, and a report is already
 * over 2 MB at roughly 5,000 rows. Chromium then refuses the navigation with
 * `ERR_INVALID_URL (-300)` and the PDF button fails without printing anything.
 *
 * The same HTML is written to a temporary file instead and loaded with `loadFile`, so the size of
 * a report is no longer part of a URL. The file lives in its own temporary folder and is deleted
 * as soon as the PDF has been rendered — on the failure path too, so a failed print cannot leave
 * reports behind on disk.
 *
 * Page setup and footer still come from server/reports/print-template.js: this module only decides
 * *where* the HTML comes from, never how it is printed.
 *
 * Electron itself is not imported here: `loadFile` and `printToPDF` are passed in, which is what
 * lets the whole path be covered by `npm test` without a browser or a database.
 */

/** The URL scheme the report must never be loaded through again. */
export const DATA_URL_PREFIX = "data:text/html;charset=utf-8,";

/** Folder prefix of a print job's temporary directory, e.g. reports-desk-print-a1b2c3/. */
export const TEMP_DIR_PREFIX = "reports-desk-print-";

/** The file name inside that folder. */
export const REPORT_FILE_NAME = "report.html";

/** Length the whole report would take as an encoded data: URL — the number that used to overflow. */
export const dataUrlLength = (html) => DATA_URL_PREFIX.length + encodeURIComponent(String(html ?? "")).length;

/** Writes the report HTML into a fresh temporary folder of its own. Returns { dir, file }. */
export async function writeReportHtml(html, tmpRoot = os.tmpdir()) {
  const dir = await fs.mkdtemp(path.join(tmpRoot, TEMP_DIR_PREFIX));
  const file = path.join(dir, REPORT_FILE_NAME);
  await fs.writeFile(file, String(html ?? ""), "utf8");
  return { dir, file };
}

/**
 * Best-effort removal of a print job's folder. Cleanup must never be the reason a report fails to
 * print, so a failure here is swallowed: the file is in the OS temp folder either way.
 */
export async function removeReportHtml(dir) {
  if (!dir) return;
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    /* the temporary folder is the OS's to reclaim */
  }
}

/**
 * Renders report HTML to a PDF through a hidden Chromium window, without a data: URL:
 * `writeReportHtml` puts the document on disk, `loadFile(file)` navigates to it, and
 * `printToPDF(options)` prints it with the shared page setup and footer. The temporary folder is
 * removed in `finally`, so it is gone whether the print worked or not.
 *
 * `loadFile` and `printToPDF` are injected (main.js supplies Electron's `BrowserWindow`), which
 * keeps the URL-limit fix covered by tests that need neither Electron nor a database.
 */
export async function printHtmlToPdf({ html, meta = {}, loadFile, printToPDF, tmpRoot = os.tmpdir() }) {
  if (typeof loadFile !== "function" || typeof printToPDF !== "function") {
    throw new TypeError("printHtmlToPdf needs a loadFile and a printToPDF function.");
  }
  const { dir, file } = await writeReportHtml(html, tmpRoot);
  try {
    await loadFile(file);
    return await printToPDF(printOptions(meta));
  } finally {
    await removeReportHtml(dir);
  }
}
