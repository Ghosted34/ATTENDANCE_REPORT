import test from "node:test";
import assert from "node:assert/strict";
import { PRINT_PAGE, escapeHtml, footerTemplate, printOptions } from "../server/reports/print-template.js";
import { toHtml } from "../server/reports/export.js";
import attendance from "../server/reports/attendance.js";

test("the print template is A4 landscape with matching margins", () => {
  assert.deepEqual(PRINT_PAGE, { size: "A4", landscape: true, marginsPx: { top: 34, right: 34, bottom: 44, left: 34 } });
  const html = toHtml(attendance, [], attendance.normalize({ date: "2026-10-05" }), "Reports Desk");
  const page = /@page\{size:A4 landscape;\s*margin:(\d+)mm (\d+)mm (\d+)mm\}/.exec(html);
  assert.ok(page, "the HTML template carries the same @page setup");
  // 34px ≈ 9mm, 44px ≈ 12mm — keep the HTML and the Chromium print options in step.
  assert.deepEqual(page.slice(1), ["9", "9", "12"]);
});

test("printOptions drives Chromium's printToPDF from the template", () => {
  const options = printOptions({ title: "Daily attendance", subtitle: "Attendance for 2026-10-05", brandName: "Reports Desk" });
  assert.equal(options.pageSize, "A4");
  assert.equal(options.landscape, true);
  assert.equal(options.printBackground, true);
  assert.equal(options.displayHeaderFooter, true);
  assert.deepEqual(options.margins, { marginType: "custom", top: 34, right: 34, bottom: 44, left: 34 });
  assert.match(options.footerTemplate, /Daily attendance — Attendance for 2026-10-05/);
  assert.match(options.footerTemplate, /Reports Desk · Page <span class="pageNumber"><\/span> of <span class="totalPages"><\/span>/);
});

test("the footer template escapes whatever it is given", () => {
  const footer = footerTemplate({ title: "A <b>", subtitle: "1 & 2", brandName: 'Desk "X"' });
  assert.match(footer, /A &lt;b&gt; — 1 &amp; 2/);
  assert.match(footer, /Desk &quot;X&quot;/);
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
  assert.equal(footerTemplate({}).includes("Page"), true); // page numbers work even with no metadata
});
