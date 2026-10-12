import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { createApp } from "../server/app.js";
import { reports } from "../server/reports/registry.js";

/** Runs the real Express app on a loopback port, signed in via the mock login. */
async function withApi(run, options = {}) {
  const app = createApp({ secret: null, getConfig: () => ({ tzOffsetHours: 1 }), ...options });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "admin" }),
    });
    const { token } = await login.json();
    const get = (path) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
    await run({ base, get });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the report list advertises the mode select, a single-date default and mode-tagged fields", async () => {
  await withApi(async ({ get }) => {
    const list = await (await get("/api/reports")).json();
    const report = list.find((r) => r.id === "attendance");
    assert.ok(report, "attendance report is registered");
    const params = Object.fromEntries(report.params.map((p) => [p.name, p]));
    assert.deepEqual(Object.keys(params), ["mode", "date", "start", "end", "month", "idNumber"]);
    assert.equal(params.mode.type, "select");
    assert.equal(params.mode.default, "single");
    assert.deepEqual(params.mode.options.map((o) => o.value), ["single", "range", "month"]);
    assert.equal(params.date.mode, "single");
    assert.equal(params.start.mode, "range");
    assert.equal(params.end.mode, "range");
    assert.equal(params.month.type, "month");
    assert.equal(params.month.mode, "month");
    assert.equal(params.idNumber.type, "text");
    assert.equal(params.idNumber.optional, true); // blank means everyone
    // The mode-independent base list: a run's Date and every period's Day come from columnsFor(params).
    assert.equal(report.columns.some((c) => c.key === "date"), false);
    assert.equal(report.columns.some((c) => c.key === "day"), false);
    assert.equal(report.columns.some((c) => c.key === "department"), true); // on screen, not only in the export
    assert.deepEqual(report.columns.map((c) => c.label), [
      "Name", "Employee ID", "Card no.", "Department", "First entry", "Last entry", "Duration", "Swipes", "Status",
    ]);
    assert.equal(report.columns.at(-1).label, "Status");
    assert.equal(report.columns[report.columns.findIndex((c) => c.label === "Employee ID") + 1].label, "Card no.");
    assert.match(report.description, /Absent/);
    // Sections are cut twice: a department's Present rows and its Absent rows are separate blocks.
    assert.deepEqual(report.groupBy, ["department", "status"]);
  });
});

test("invalid dates and reversed ranges are rejected with 400 before the database is used", async () => {
  await withApi(async ({ get }) => {
    const cases = [
      ["/api/reports/attendance/data?date=2026-02-31", /Pick a valid date/],
      ["/api/reports/attendance/data?mode=single&date=not-a-date", /Pick a valid date/],
      ["/api/reports/attendance/data?mode=range&start=2026-10-05&end=2026-10-01", /on or before/],
      ["/api/reports/attendance/data?mode=range&start=2026-10-05&end=2026-02-31", /valid start date and end date/],
      ["/api/reports/attendance/data?mode=range&start=&end=", /valid start date and end date/],
      ["/api/reports/attendance/data?mode=week&date=2026-10-05", /Single date/],
      ["/api/reports/attendance/data?date=2026-10-05&idNumber=7%20OR%201%3D1", /Employee ID can only contain/],
      ["/api/reports/attendance/data?date=2026-10-05&employeeId=7%20OR%201%3D1", /Employee ID can only contain/],
      ["/api/reports/attendance/data?mode=month&month=2026-13", /valid month/],
      ["/api/reports/attendance/data?mode=month&month=2026-02-01", /valid month/],
      ["/api/reports/attendance/data?mode=month", /valid month/],
      ["/api/reports/attendance/data?mode=range&start=2025-01-01&end=2026-12-31", /at most 366 days/],
      ["/api/reports/absentees/data?date=2026-02-31", /Pick a valid date/],
      ["/api/reports/absentees/data?mode=month&month=2026-00", /valid month/],
      ["/api/reports/absentees/csv?mode=range&start=2026-10-05&end=2026-10-01", /on or before/],
      ["/api/reports/attendance/data", /Pick a valid date/], // no parameters at all
    ];
    for (const [path, message] of cases) {
      const res = await get(path);
      assert.equal(res.status, 400, path);
      assert.match((await res.json()).error, message, path);
    }
    // The same validation guards the exports because they share the run() path.
    const xlsx = await get("/api/reports/attendance/xlsx?mode=range&start=2026-10-05&end=2026-10-01");
    assert.equal(xlsx.status, 400);
    const pdf = await get("/api/reports/attendance/pdf?date=2026-02-31");
    assert.equal(pdf.status, 400);
    const csv = await get("/api/reports/attendance/csv?mode=range&start=2026-10-05&end=2026-10-01");
    assert.equal(csv.status, 400);
  });
});

test("unknown report ids and unauthenticated requests are still refused", async () => {
  await withApi(async ({ base, get }) => {
    assert.equal((await get("/api/reports/nope/data?date=2026-10-05")).status, 404);
    const anon = await fetch(`${base}/api/reports`);
    assert.equal(anon.status, 401);
  });
});

test("the app only serves loopback clients unless an Electron token is configured", async () => {
  const app = createApp({ secret: "sea", getConfig: () => ({ tzOffsetHours: 1 }) });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/meta`)).status, 403); // standalone mode with a secret set
    const withToken = await fetch(`${base}/api/meta`, { headers: { "x-app-token": "sea" } });
    assert.equal(withToken.status, 200);
    // The sign-in card stamps its build from these two.
    const meta = await withToken.json();
    assert.equal(meta.name, "Reports Desk");
    assert.equal(meta.version, JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ---------- An in-memory report: no database, so the template and the exports are testable ---------- */

// Shaped like a real report definition, including the mode-dependent template hooks.
const fixture = {
  id: "fixture",
  title: "Fixture report",
  description: "In-memory report used by the API tests.",
  params: [{ name: "scope", label: "Scope", type: "text", optional: true }],
  groupBy: null,
  columns: [{ key: "name", label: "Name" }],
  columnsFor: (p) => (p.scope === "wide"
    ? [{ key: "name", label: "Name" }, { key: "extra", label: "Extra" }]
    : [{ key: "name", label: "Name" }]),
  normalize: (values) => ({ scope: String(values.scope ?? "").trim() }),
  subtitle: ({ scope }) => `Fixture for ${scope || "everything"}`,
  run: async () => [{ name: 'Ada, "Obi"', extra: "wide" }],
};

async function withFixtureReport(run, options) {
  reports.set(fixture.id, fixture);
  try { await withApi(run, options); }
  finally { reports.delete(fixture.id); }
}

test("the data endpoint returns the columns and subtitle for the requested mode", async () => {
  await withFixtureReport(async ({ get }) => {
    const narrow = await (await get("/api/reports/fixture/data")).json();
    assert.deepEqual(narrow.columns, [{ key: "name", label: "Name" }]);
    assert.equal(narrow.subtitle, "Fixture for everything");

    const wide = await (await get("/api/reports/fixture/data?scope=wide")).json();
    assert.deepEqual(wide.columns.map((c) => c.key), ["name", "extra"]);
    assert.equal(wide.subtitle, "Fixture for wide");
    assert.equal(wide.rows.length, 1);
  });
});

test("CSV export is offered with the template columns and Excel-friendly escaping", async () => {
  await withFixtureReport(async ({ get }) => {
    const res = await get("/api/reports/fixture/csv?scope=wide");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="fixture.csv"');
    // fetch's text() strips the BOM, so check the bytes are there for Excel.
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const body = bytes.toString("utf8").slice(1);
    assert.equal(body.split("\r\n")[0], "Name,Extra");
    assert.equal(body.split("\r\n")[1], '"Ada, ""Obi""",wide');
  });
});

test("Electron PDF rendering receives the print template's metadata", async () => {
  const calls = [];
  await withFixtureReport(async ({ get }) => {
    const res = await get("/api/reports/fixture/pdf?scope=wide");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true }); // the stub's body, i.e. renderPdf was used
  }, {
    renderPdf: async (html, meta) => {
      calls.push({ html, meta });
      return Buffer.from(JSON.stringify({ ok: true }));
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].meta, { title: "Fixture report", subtitle: "Fixture for wide", brandName: "Reports Desk" });
  assert.match(calls[0].html, /<h1>Fixture report<\/h1>/);
  assert.match(calls[0].html, /Fixture for wide · Reports Desk · Total 1/);
  assert.match(calls[0].html, /<th class="">Extra<\/th>/);
});

test("the absentee report is listed beside attendance, with its own name, columns and the same periods", async () => {
  await withApi(async ({ get }) => {
    const list = await (await get("/api/reports")).json();
    const absentees = list.find((r) => r.id === "absentees");
    assert.ok(absentees, "absentee report is registered");
    assert.equal(absentees.title, "Absentees");
    assert.deepEqual(absentees.params.map((p) => p.name), ["mode", "date", "start", "end", "month", "idNumber"]);
    assert.deepEqual(absentees.columns.map((c) => c.label), ["Name", "Employee ID", "Card no.", "Department"]);
    assert.equal(absentees.columns[absentees.columns.findIndex((c) => c.label === "Employee ID") + 1].label, "Card no.");
    assert.equal(absentees.groupBy, "department");
    // Same period validation as the attendance report, so the two reports take the same inputs.
    const res = await get("/api/reports/absentees/xlsx?mode=range&start=2026-10-05&end=2026-10-01");
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /on or before/);
  });
});

test("an export comes out in the order the table was sorted, and ignores a sort it cannot honour", async () => {
  // A report whose rows arrive in one order and whose columns are known, so the sheets can be read.
  // Deliberately not spread from `fixture`: its `columnsFor` hook would keep advertising the
  // fixture's two columns and the sort below would be rejected as unknown — which is the
  // safeguard working, not the sort failing.
  const sortable = {
    id: "sortable",
    title: "Sortable report",
    description: "Rows the exports can be read back from.",
    params: [],
    groupBy: null,
    columns: [{ key: "name", label: "Name" }, { key: "accessCount", label: "Swipes" }],
    normalize: (values) => ({ ...values }),
    subtitle: () => "Sortable",
    run: async () => [
      { name: "Ada", accessCount: 10 },
      { name: "Ben", accessCount: 2 },
      { name: "Chidi", accessCount: null },
    ],
  };
  reports.set(sortable.id, sortable);
  try {
    await withApi(async ({ get }) => {
      const body = async (path) => (await (await get(path)).text());
      const namesIn = async (path) => (await body(path)).split("\r\n").slice(1).filter(Boolean)
        .map((line) => line.split(",")[0]);

      // Unsorted: the report's own order.
      assert.deepEqual(await namesIn("/api/reports/sortable/csv"), ["Ada", "Ben", "Chidi"]);

      // Sorted by a column, in both directions — the same order the table shows, with the blank
      // value last either way.
      assert.deepEqual(await namesIn("/api/reports/sortable/csv?sort=name&dir=desc"), ["Chidi", "Ben", "Ada"]);
      assert.deepEqual(await namesIn("/api/reports/sortable/csv?sort=accessCount&dir=asc"), ["Ben", "Ada", "Chidi"]);
      assert.deepEqual(await namesIn("/api/reports/sortable/csv?sort=accessCount&dir=desc"), ["Ada", "Ben", "Chidi"]);

      // A sort naming a column this report does not have, or a direction that is not one, leaves
      // the report's own order rather than trusting the query string.
      assert.deepEqual(await namesIn("/api/reports/sortable/csv?sort=secret&dir=asc"), ["Ada", "Ben", "Chidi"]);
      assert.deepEqual(await namesIn("/api/reports/sortable/csv?sort=name&dir=sideways"), ["Ada", "Ben", "Chidi"]);
      assert.deepEqual(await namesIn("/api/reports/sortable/csv?sort=name"), ["Ada", "Ben", "Chidi"]);

      // A grouped report sorts *inside* its sections, which is what the table does. Sorting the
      // rows globally would leave each section sorted but reorder the sections themselves — they
      // appear in the order their first row does — so the sheet would open on a different
      // department from the one at the top of the screen.
      const grouped = {
        ...sortable,
        id: "grouped",
        groupBy: "department",
        run: async () => [
          { name: "Zara", department: "Warehouse" },
          { name: "Ada", department: "Front Desk" },
          { name: "Ben", department: "Warehouse" },
          { name: "Chidi", department: "Front Desk" },
        ],
      };
      reports.set(grouped.id, grouped);
      try {
        const firstColumn = (text) => text.split("\r\n").slice(1).filter(Boolean).map((line) => line.split(",")[0]);
        // The sections keep the report's own order — its first row is Warehouse, so Warehouse
        // leads — and only the rows inside them are sorted.
        const csv = await body("/api/reports/grouped/csv?sort=name&dir=asc");
        assert.deepEqual(firstColumn(csv), ["Ben", "Zara", "Ada", "Chidi"]);
        const csvDesc = await body("/api/reports/grouped/csv?sort=name&dir=desc");
        assert.deepEqual(firstColumn(csvDesc), ["Zara", "Ben", "Chidi", "Ada"]);
      } finally {
        reports.delete(grouped.id);
      }

      // Excel and PDF are built from the same rows, so they are ordered the same way.
      const xlsx = await get("/api/reports/sortable/xlsx?sort=name&dir=desc");
      assert.equal(xlsx.status, 200);
      const pdf = await get("/api/reports/sortable/pdf?sort=name&dir=desc");
      assert.equal(pdf.status, 200);
    });
  } finally {
    reports.delete(sortable.id);
  }
});
