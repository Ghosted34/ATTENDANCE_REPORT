// The renderer's report template is DOM-free, so it is tested directly in Node.
import test from "node:test";
import assert from "node:assert/strict";
import {
  csvFor, emptyStateHtml, escapeHtml, exportFileName, groupByToggleHtml, isoToday,
  paramFieldsHtml, parseQuery, resolveReportParams, sortRows, tableHtml,
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
  assert.match(html, /<th scope="col" class="right"><button type="button" class="th-sort" data-sort-key="accessCount">Swipes<\/button><\/th>/);
  assert.match(html, /<td class="wrap">Ops<\/td>/);
  assert.equal(tableHtml({ columns, groupBy: null, rows: [{ name: "A", department: "D", accessCount: 1 }] })
    .includes("grp"), false);
  // The caption is the table's name. Assert the duplicate is gone, not just that the caption is
  // there: a table announced twice is the defect being guarded against.
  assert.match(html, /<caption class="sr-only">Report grouped by department<\/caption>/);
  assert.equal(html.includes("aria-label"), false, "the caption already names the table");
  assert.match(html, /<th scope="col" class=""><button type="button" class="th-sort" data-sort-key="name">Name<\/button><\/th>/);
});

test("tableHtml includes accessibility attributes for all headers", () => {
  const columns = [{ key: "name", label: "Name" }, { key: "age", label: "Age", align: "right" }];
  const html = tableHtml({ columns, groupBy: null, rows: [{ name: "A", age: 30 }] });
  assert.match(html, /<th scope="col" class=""><button[^>]*>Name<\/button><\/th>/);
  assert.match(html, /<th scope="col" class="right"><button[^>]*>Age<\/button><\/th>/);
  assert.match(html, /<caption class="sr-only">Report<\/caption>/);
  // Every header is sortable, and none of them claims a sort direction until one is sorted.
  assert.equal([...html.matchAll(/<button type="button" class="th-sort"/g)].length, 2);
  assert.equal(html.includes("aria-sort"), false);
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

test("sortRows orders by the column's own kind and leaves the blanks at the bottom", () => {
  const rows = [
    { name: "Ada", accessCount: 10, date: "2026-10-07" },
    { name: "chidi", accessCount: 9, date: "" },
    { name: "Ben", accessCount: null, date: "2026-10-05" },
  ];
  const names = (list) => list.map((r) => r.name);

  // A person sorting names does not expect "chidi" after "Ben" because of its case.
  assert.deepEqual(names(sortRows(rows, { key: "name", dir: "asc" })), ["Ada", "Ben", "chidi"]);
  assert.deepEqual(names(sortRows(rows, { key: "name", dir: "desc" })), ["chidi", "Ben", "Ada"]);

  // Numbers compare as numbers, not as the text "10" < "9".
  assert.deepEqual(names(sortRows(rows, { key: "accessCount", dir: "asc" })), ["chidi", "Ada", "Ben"]);
  assert.deepEqual(names(sortRows(rows, { key: "accessCount", dir: "desc" })), ["Ada", "chidi", "Ben"]);

  // Dates as text still sort chronologically; the empty one goes last either way.
  assert.deepEqual(names(sortRows(rows, { key: "date", dir: "asc" })), ["Ben", "Ada", "chidi"]);
  assert.deepEqual(names(sortRows(rows, { key: "date", dir: "desc" })), ["Ada", "Ben", "chidi"]);

  // No sort means the rows are handed back untouched, in the report's own order.
  assert.equal(sortRows(rows, null), rows);
  assert.equal(sortRows(rows, {}), rows);

  // Equal values keep the order the report produced them in.
  const ties = [{ k: 1, n: "first" }, { k: 1, n: "second" }];
  assert.deepEqual(sortRows(ties, { key: "k", dir: "asc" }).map((r) => r.n), ["first", "second"]);
});

test("tableHtml carries min-width on the column it belongs to, not on a position", () => {
  const columns = [
    { key: "name", label: "Name", minWidth: 150 },
    { key: "id", label: "Employee ID", minWidth: 80 },
    { key: "note", label: "Note" },
  ];
  const html = tableHtml({ columns, groupBy: null, rows: [{ name: "Ada", id: "1", note: "x" }] });
  // The width travels with the column, so it cannot land on a neighbour when a report or a
  // period changes how many columns come first (which is what nth-child rules did).
  assert.match(html, /<th scope="col" class="" style="min-width:150px"><button[^>]*>Name<\/button><\/th>/);
  assert.match(html, /<td class="" style="min-width:150px">Ada<\/td>/);
  assert.match(html, /class="" style="min-width:80px"/);
  // A column without one gets no style attribute at all.
  assert.equal(html.includes('class="" style="min-width:undefined"'), false);
  assert.match(html, /<td class="">x<\/td>/);
  // Nonsense is ignored rather than emitted.
  assert.equal(tableHtml({ columns: [{ key: "a", label: "A", minWidth: "wide" }], rows: [{ a: 1 }] }).includes("min-width"), false);
});

test("tableHtml marks the sorted column in words and sorts inside the group headings", () => {
  const columns = [{ key: "department", label: "Department" }, { key: "name", label: "Name" }];
  const rows = [
    { department: "Ops", name: "Zara" },
    { department: "Ops", name: "Ada" },
    { department: "Security", name: "Yusuf" },
  ];
  const html = tableHtml({ columns, groupBy: "department", rows, sort: { key: "name", dir: "asc" } });

  // aria-sort is on the sorted column only, and it says the direction rather than showing an arrow.
  assert.equal([...html.matchAll(/aria-sort="ascending"/g)].length, 1);
  assert.match(html, /<th scope="col" class="" aria-sort="ascending"><button[^>]*>Name<svg class="caret"/);
  assert.match(html, /<th scope="col" class=""><button[^>]*>Department<\/button><\/th>/);

  // Rows are ordered inside each heading, and the headings keep the report's own order — sorting
  // by name must not also reshuffle the departments.
  const body = html.slice(html.indexOf("<tbody>"));
  assert.deepEqual([...body.matchAll(/<tr class="grp"><td colspan="2">([^<]*)<\/td><\/tr>/g)].map(([, g]) => g),
    ["Ops (2)", "Security (1)"]);
  // The name column is the second cell of a data row.
  assert.deepEqual([...body.matchAll(/<tr><td class="">[^<]*<\/td><td class="">([^<]*)<\/td><\/tr>/g)].map(([, n]) => n),
    ["Ada", "Zara", "Yusuf"]);

  // The descending caret and aria value follow the direction.
  const desc = tableHtml({ columns, groupBy: null, rows, sort: { key: "name", dir: "desc" } });
  assert.match(desc, /aria-sort="descending"/);
  assert.match(desc, /class="caret"/);
});

test("tableHtml only claims a sort it was asked for", () => {
  const columns = [{ key: "name", label: "Name" }];
  const rows = [{ name: "B" }, { name: "A" }];
  // Asking to sort by a column the table does not have leaves every header unsorted and the rows
  // in the order they arrived, rather than tearing the table.
  const html = tableHtml({ columns, groupBy: null, rows, sort: { key: "gone", dir: "asc" } });
  assert.equal(html.includes("aria-sort"), false);
  assert.equal([...html.matchAll(/class="caret"/g)].length, 0);
});
