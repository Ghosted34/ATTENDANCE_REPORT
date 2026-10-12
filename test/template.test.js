// The renderer's report template is DOM-free, so it is tested directly in Node.
import test from "node:test";
import assert from "node:assert/strict";
import {
  csvFor, emptyStateHtml, escapeHtml, exportFileName, groupByToggleHtml, isoToday,
  paramFieldsHtml, parseQuery, resolveReportParams, tableHtml,
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
    { name: "idNumber", label: "Employee ID", type: "text", optional: true, hint: "Leave blank for everyone." },
  ],
  groupBy: "department",
  columns: [
    { key: "name", label: "Name" },
    { key: "idNumber", label: "Employee ID" },
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
  assert.match(html, /<th scope="col" class="right">Swipes<\/th>/);
  assert.match(html, /<td class="wrap">Ops<\/td>/);
  assert.equal(tableHtml({ columns, groupBy: null, rows: [{ name: "A", department: "D", accessCount: 1 }] })
    .includes("grp"), false);
  // Verify accessibility attributes are present
  assert.match(html, /aria-label="Report grouped by department"/);
  assert.match(html, /<caption class="sr-only">/);
  assert.match(html, /<th scope="col" class="">Name<\/th>/);
});

test("tableHtml includes accessibility attributes for all headers", () => {
  const columns = [{ key: "name", label: "Name" }, { key: "age", label: "Age", align: "right" }];
  const html = tableHtml({ columns, groupBy: null, rows: [{ name: "A", age: 30 }] });
  assert.match(html, /<th scope="col" class="">Name<\/th>/);
  assert.match(html, /<th scope="col" class="right">Age<\/th>/);
  assert.match(html, /aria-label="Report"/);
  assert.match(html, /<caption class="sr-only">Report<\/caption>/);
});

test("tableHtml with custom statusPill renders status as pills", () => {
  const statusPill = (status) => `<span class="pill ${status}">${status}</span>`;
  const columns = [{ key: "name", label: "Name" }, { key: "status", label: "Status" }];
  const html = tableHtml({ columns, groupBy: null, rows: [{ name: "A", status: "Present" }], statusPill });
  assert.match(html, /<span class="pill Present">Present<\/span>/);
});

test("tableHtml cuts a section further when groupBy lists more than one column", () => {
  const columns = [
    { key: "department", label: "Department" },
    { key: "status", label: "Status" },
    { key: "name", label: "Name" },
  ];
  const rows = [
    { department: "Ops", status: "Present", name: "Obi Ada" },
    { department: "Ops", status: "Absent", name: "Eze Chi" },
    { department: "Ops", status: "Absent", name: "Nwosu Ben" },
    { department: "Security", status: "Present", name: "Yusuf Hassan" },
  ];
  const html = tableHtml({ columns, groupBy: ["department", "status"], rows });
  // One heading per combination, in the order the rows arrive, with its own count.
  assert.deepEqual([...html.matchAll(/<tr class="grp"><td colspan="3">([^<]*)<\/td><\/tr>/g)].map(([, name]) => name), [
    "Ops — Present (1)", "Ops — Absent (2)", "Security — Present (1)",
  ]);
  assert.match(html, /<td class="">Eze Chi<\/td>/);

  // A row with no value for the grouping columns shows under no heading at all, as on the server.
  const ungrouped = tableHtml({ columns, groupBy: ["department", "status"], rows: [{ name: "Nobody", department: null, status: "" }] });
  assert.equal(ungrouped.includes("grp"), false);
  assert.match(ungrouped, /<td class="">Nobody<\/td>/);
});

test("csvFor and exportFileName match the mode", () => {
  const csv = csvFor({ columns: [{ key: "name", label: "Name" }], rows: [{ name: 'Ada, "Obi"' }] });
  assert.equal(csv, '\uFEFFName\r\n"Ada, ""Obi"""\r\n');
  assert.equal(exportFileName("attendance", { mode: "range", start: "2026-08-16", end: "2026-08-19" }, "csv"),
    "attendance-2026-08-16_to_2026-08-19.csv");
  assert.equal(exportFileName("attendance", { mode: "single", date: "2026-08-16" }, "xlsx"),
    "attendance-2026-08-16.xlsx");
});

test("month fields render as a month input, default to the current month and name the download by month", () => {
  const monthReport = {
    ...report,
    params: [
      { name: "mode", label: "Report for", type: "select", default: "single",
        options: [{ value: "single", label: "Single date" }, { value: "month", label: "Month" }] },
      { name: "month", label: "Month", type: "month", mode: "month" },
    ],
  };
  const html = paramFieldsHtml(monthReport, { mode: "month", month: "2026-10" });
  assert.match(html, /<input id="p_month" name="month" type="month" value="2026-10"[^>]*required>/);
  assert.match(html, /data-mode="month"/);

  const { values } = resolveReportParams(monthReport, { query: parseQuery(""), today: "2026-10-12" });
  assert.equal(values.month, "2026-10"); // the current month, from today's local date
  assert.equal(values.mode, "single");

  const fromUrl = resolveReportParams(monthReport, { query: parseQuery("?mode=month&month=2028-02"), today: "2026-10-12" });
  assert.equal(fromUrl.values.month, "2028-02");

  assert.equal(exportFileName("attendance", { mode: "month", month: "2026-10" }, "pdf"), "attendance-2026-10.pdf");
  assert.equal(exportFileName("absentees", { mode: "month", month: "2026-02" }, "csv"), "absentees-2026-02.csv");
  assert.equal(exportFileName("absentees", { mode: "single", date: "2026-10-05" }, "xlsx"), "absentees-2026-10-05.xlsx");
});

test("groupByToggleHtml marks one option as pressed and names both outcomes", () => {
  const grouped = groupByToggleHtml(true);
  // The active option is the one the table follows, and only it is pressed.
  assert.match(grouped, /data-groupby="true" aria-pressed="true" aria-current="true"[^>]*>[\s\S]*?<span>By Dept<\/span>/);
  assert.match(grouped, /data-groupby="false" aria-pressed="false" aria-current="false"[^>]*>[\s\S]*?<span>All Together<\/span>/);
  // Both options are buttons in one labelled group, each with an icon and a tooltip.
  assert.match(grouped, /role="group" aria-label="Row grouping"/);
  assert.equal([...grouped.matchAll(/<button type="button"/g)].length, 2);
  assert.equal([...grouped.matchAll(/class="seg-icon"/g)].length, 2);
  assert.match(grouped, /data-tooltip="Group rows under a heading per department"/);
  assert.match(grouped, /data-tooltip="One flat list of every row"/);

  // Flipping the preference moves the pressed state to the flat option.
  const flat = groupByToggleHtml(false);
  assert.match(flat, /data-groupby="false" aria-pressed="true" aria-current="true"/);
  assert.match(flat, /data-groupby="true" aria-pressed="false" aria-current="false"/);
});

test("emptyStateHtml offers the next step for the period that came back empty", () => {
  const withAbsentees = emptyStateHtml({ period: "date range", canRunAbsentees: true });
  assert.match(withAbsentees, /No records for this date range/);
  assert.match(withAbsentees, /Try another date range, or run the Absentees report for the same window\./);
  assert.match(withAbsentees, /data-empty-action="absentees">Try Absentees</);
  assert.match(withAbsentees, /data-empty-action="date">Change Date</);
  assert.match(withAbsentees, /role="status"/);

  // A month is changed in months, and the day counts stay out of it.
  const month = emptyStateHtml({ period: "month", canRunAbsentees: true });
  assert.match(month, /data-empty-action="date">Change Month</);

  // On the Absentees report itself (or one that is not registered) the button is not offered.
  const alone = emptyStateHtml({ period: "date", canRunAbsentees: false });
  assert.equal(alone.includes("Try Absentees"), false);
  assert.equal(alone.includes("data-empty-action=\"absentees\""), false);
  assert.match(alone, /<p>Try another date\.<\/p>/);
  assert.match(alone, /data-empty-action="date">Change Date</);

  // The defaults are the single-date wording, so a caller can pass nothing.
  assert.match(emptyStateHtml(), /No records for this date/);
});

test("paramFieldsHtml omits the fields the caller draws itself", () => {
  const values = { mode: "range", start: "2026-08-16", end: "2026-08-19", date: "2026-08-16", idNumber: "" };
  // The report screen renders the mode as a segmented control plus a hidden input of its own; the
  // mode field must be left out entirely, or the form would submit "mode" twice and the report
  // would reject the request with "Choose \"Single date\", \"Date range\" or \"Month\".".
  const html = paramFieldsHtml(report, values, { omit: ["mode"] });
  assert.equal(html.includes('name="mode"'), false);
  assert.equal(html.includes('for="p_mode"'), false);
  assert.equal(html.includes("<select"), false);
  // The other fields are untouched, and nothing is omitted by default.
  assert.match(html, /<input id="p_date" name="date" type="date"/);
  assert.match(html, /<input id="p_idNumber" name="idNumber" type="text"/);
  assert.equal(paramFieldsHtml(report, values).includes('name="mode"'), true);
  assert.equal(paramFieldsHtml(report, values, { omit: [] }).includes('name="mode"'), true);
});
