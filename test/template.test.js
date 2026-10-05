// The renderer's report template is DOM-free, so it is tested directly in Node.
import test from "node:test";
import assert from "node:assert/strict";
import {
  csvFor, escapeHtml, exportFileName, isoToday, paramFieldsHtml, parseQuery,
  resolveReportParams, tableHtml,
} from "../renderer/app/js/template.js";

const report = {
  id: "attendance",
  title: "Daily attendance",
  description: "Who swiped in on a single day or a date range.",
  params: [
    { name: "mode", label: "Report for", type: "select", default: "single",
      options: [{ value: "single", label: "Single date" }, { value: "range", label: "Date range" }] },
    { name: "date", label: "Date", type: "date", mode: "single" },
    { name: "start", label: "Start date", type: "date", mode: "range" },
    { name: "end", label: "End date", type: "date", mode: "range" },
    { name: "idNumber", label: "ID number", type: "text", optional: true, hint: "Leave blank for everyone." },
  ],
  groupBy: "department",
  columns: [
    { key: "name", label: "Name" },
    { key: "idNumber", label: "ID number" },
  ],
};

test("parseQuery accepts a pasted or escaped query string", () => {
  const q = parseQuery("?mode=range&start=2026-08-16&end=2026-08-19");
  assert.equal(q.get("mode"), "range");
  assert.equal(q.get("start"), "2026-08-16");
  assert.equal(parseQuery("%3Fmode=range%26start=2026-08-16").get("start"), "2026-08-16");
  assert.equal(parseQuery("&&mode=single;date=2026-08-16").get("date"), "2026-08-16");
  assert.equal(parseQuery("").has("mode"), false);
});

test("resolveReportParams presets fields from the URL and forwards extra keys", () => {
  const { values, extra } = resolveReportParams(report, {
    query: parseQuery("?mode=range&start=2026-08-16&end=2026-08-19&plant=Lagos&empty="),
    today: "2026-10-05",
  });
  assert.deepEqual(values, {
    mode: "range", date: "2026-10-05", start: "2026-08-16", end: "2026-08-19", idNumber: "",
  });
  assert.deepEqual(extra, [{ name: "plant", value: "Lagos" }]); // empty values are not forwarded
});

test("resolveReportParams defaults to a single date of today", () => {
  const { values, extra } = resolveReportParams(report, { query: parseQuery(""), today: "2026-10-05" });
  assert.deepEqual(values, {
    mode: "single", date: "2026-10-05", start: "2026-10-05", end: "2026-10-05", idNumber: "",
  });
  assert.deepEqual(extra, []);
  assert.equal(isoToday(new Date("2026-10-05T23:30:00")), "2026-10-05"); // local, not UTC, day
});

test("paramFieldsHtml renders each field type with its mode, hint and escaping", () => {
  const html = paramFieldsHtml(report, { mode: "range", start: "2026-08-16", end: "2026-08-19", idNumber: "" });
  assert.match(html, /<select id="p_mode" name="mode">/);
  assert.match(html, /<option value="range" selected>Date range<\/option>/);
  assert.match(html, /<div class="field" data-mode="single"><label for="p_date">/);
  assert.match(html, /<div class="field" data-mode="range"><label for="p_start">/);
  assert.match(html, /<input id="p_start" name="start" type="date" value="2026-08-16" required>/);
  assert.match(html, /<input id="p_idNumber" name="idNumber" type="text" value=""( placeholder="")?>.*Leave blank/s);
  assert.doesNotMatch(html, /id="p_idNumber" name="idNumber" type="text" value="" placeholder="" required/);
  assert.equal(escapeHtml('Ada & "Ben" <b>'), "Ada &amp; &quot;Ben&quot; &lt;b&gt;");
});

test("tableHtml renders group headings, alignment and wrapping", () => {
  const columns = [
    { key: "name", label: "Name" },
    { key: "department", label: "Department", wrap: true },
    { key: "accessCount", label: "Swipes", align: "right" },
  ];
  const html = tableHtml({
    columns,
    groupBy: "department",
    rows: [
      { name: "Obi Ada", department: "Ops", accessCount: 2 },
      { name: "Nwosu Ben", department: "Security", accessCount: 4 },
    ],
  });
  assert.match(html, /<tr class="grp"><td colspan="3">Ops \(1\)<\/td><\/tr>/);
  assert.match(html, /<tr class="grp"><td colspan="3">Security \(1\)<\/td><\/tr>/);
  assert.match(html, /<th class="right">Swipes<\/th>/);
  assert.match(html, /<td class="wrap">Ops<\/td>/);
  assert.equal(tableHtml({ columns, groupBy: null, rows: [{ name: "A", department: "D", accessCount: 1 }] })
    .includes("grp"), false);
});

test("csvFor and exportFileName match the mode", () => {
  const csv = csvFor({ columns: [{ key: "name", label: "Name" }], rows: [{ name: 'Ada, "Obi"' }] });
  assert.equal(csv, '\uFEFFName\r\n"Ada, ""Obi"""\r\n');
  assert.equal(exportFileName("attendance", { mode: "range", start: "2026-08-16", end: "2026-08-19" }, "csv"),
    "attendance-2026-08-16_to_2026-08-19.csv");
  assert.equal(exportFileName("attendance", { mode: "single", date: "2026-08-16" }, "xlsx"),
    "attendance-2026-08-16.xlsx");
});
