import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
    assert.deepEqual(Object.keys(params), ["mode", "date", "start", "end", "idNumber"]);
    assert.equal(params.mode.type, "select");
    assert.equal(params.mode.default, "single");
    assert.deepEqual(params.mode.options.map((o) => o.value), ["single", "range"]);
    assert.equal(params.date.mode, "single");
    assert.equal(params.start.mode, "range");
    assert.equal(params.end.mode, "range");
    assert.equal(params.idNumber.type, "text");
    assert.equal(params.idNumber.optional, true); // blank means everyone
    assert.equal(report.columns.some((c) => c.key === "date"), false);
    assert.equal(report.columns.some((c) => c.key === "department"), false); // the screen groups by it instead
    assert.deepEqual(report.columns.map((c) => c.label), [
      "Name", "ID number", "Card no.", "First entry", "Last entry", "Duration", "Swipes",
    ]);
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
      ["/api/reports/attendance/data?date=2026-10-05&idNumber=7%20OR%201%3D1", /ID number can only contain/],
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
    assert.deepEqual(await withToken.json(), { name: "Reports Desk" });
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
