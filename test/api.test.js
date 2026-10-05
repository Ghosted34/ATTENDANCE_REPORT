import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp } from "../server/app.js";

/** Runs the real Express app on a loopback port, signed in via the mock login. */
async function withApi(run) {
  const app = createApp({ secret: null, getConfig: () => ({ tzOffsetHours: 1 }) });
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
    assert.deepEqual(Object.keys(params), ["mode", "date", "start", "end"]);
    assert.equal(params.mode.type, "select");
    assert.equal(params.mode.default, "single");
    assert.deepEqual(params.mode.options.map((o) => o.value), ["single", "range"]);
    assert.equal(params.date.mode, "single");
    assert.equal(params.start.mode, "range");
    assert.equal(params.end.mode, "range");
    assert.equal(report.columns.some((c) => c.key === "date"), false);
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
