import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { brand, version } from "./brand.js";
import { login, requireAuth } from "./auth.js";
import { reports } from "./reports/registry.js";
import { toCsv, toXlsx, toHtml } from "./reports/export.js";
import { toPdf } from "./reports/pdf.js";
// The screen's own sort and grouping functions, so an export comes out in the same order as the table.
import { paginateRows, sectionsOf, sortRows } from "../renderer/app/js/template.js";

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer", "app");
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

/**
 * Finished runs, kept for a few minutes so paging, sorting and exporting a big report do not
 * re-run its SQL, and so the screen only ever receives one page of rows (a month of rows sent
 * to the window at once is what used to turn it white). "Run report" always asks for a fresh run.
 */
const RUN_TTL_MS = 10 * 60 * 1000;
const RUN_CACHE_MAX = 4;
const runCache = new Map();
const cachedRun = async (key, fresh, compute) => {
  const hit = runCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < RUN_TTL_MS) return hit.rows;
  const rows = await compute();
  runCache.delete(key);
  runCache.set(key, { at: Date.now(), rows });
  while (runCache.size > RUN_CACHE_MAX) runCache.delete(runCache.keys().next().value);
  return rows;
};

/** Totals for the status line, over every row of the run (not just the page). */
const summaryOf = (rows) => ({
  total: rows.length,
  present: rows.filter((r) => r.status === "Present").length,
  absent: rows.filter((r) => r.status === "Absent").length,
  departments: new Set(rows.map((r) => r.department)).size,
});

export function createApp({ secret, getConfig, renderPdf }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // Electron windows must present their per-launch token. The standalone server
  // has no Electron window, so only accept loopback requests in that mode.
  app.use((req, res, next) => {
    if (secret) {
      return req.headers["x-app-token"] === secret ? next() : res.status(403).end();
    }
    const address = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    return address === "127.0.0.1" || address === "::1" ? next() : res.status(403).end();
  });

  app.get("/api/live", (_req, res) => res.json({ ok: true }));
  app.get("/api/meta", (_req, res) => res.json({ name: brand.name, version }));

  app.post("/api/auth/login", wrap(async (req, res) => {
    const token = await login(req.body?.username, req.body?.password);
    if (!token) return res.status(401).json({ error: "Wrong username or password." });
    res.json({ token });
  }));

  const api = express.Router();
  api.use(requireAuth);

  api.get("/reports", (_req, res) =>
    res.json([...reports.values()].map(({ id, title, description, category, icon, params, columns, groupBy }) =>
      ({ id, title, description, category, icon, params, columns, groupBy }))));

  /**
   * The rows in the order the reader asked for. The table sorts in the browser for speed and
   * sends the same request through here, so an exported file comes out ordered like the screen it
   * came from; a key that is not one of the report's columns is ignored rather than trusted.
   *
   * A grouped report is ordered *inside its sections*, which is what the table does: sorting the
   * rows globally instead would leave each section sorted but reorder the sections themselves
   * (they appear in the order their first row does), so the sheet would open on a different
   * department from the one at the top of the screen.
   */
  const inRequestedOrder = (rows, columns, query, groupBy) => {
    const key = String(query.sort ?? "");
    const dir = query.dir === "desc" ? "desc" : query.dir === "asc" ? "asc" : "";
    if (!key || !dir || !columns.some((c) => c.key === key)) return rows;
    if (!groupBy) return sortRows(rows, { key, dir });
    return [...sectionsOf(rows, groupBy).values()].flatMap((section) => sortRows(section, { key, dir }));
  };

  const run = async (req) => {
    const report = reports.get(req.params.id);
    if (!report) throw Object.assign(new Error("Unknown report."), { status: 404 });
    const raw = Object.fromEntries(report.params.map((p) => [p.name, String(req.query[p.name] ?? "")]));
    // Hand-written URLs may say employeeId. The form, saved views and exports keep idNumber;
    // a non-empty idNumber wins so an existing link is unchanged.
    if (!String(raw.idNumber ?? "").trim() && req.query.employeeId != null && String(req.query.employeeId).trim()) {
      raw.employeeId = String(req.query.employeeId);
    }
    // Reports own their validation so bad dates/ranges fail with a clear 400 before SQL runs.
    const params = report.normalize ? report.normalize(raw) : raw;
    const tz = getConfig().tzOffsetHours;
    const rows = await cachedRun(JSON.stringify([report.id, params, tz]), req.query.fresh === "1",
      () => report.run(params, { tz }));
    const columns = report.columnsFor ? report.columnsFor(params) : report.columns;
    return { report, params, columns, allRows: rows, rows: inRequestedOrder(rows, columns, req.query, report.groupBy) };
  };

  /**
   * One page of a run, in the order and grouping the screen asked for (page, pageSize, sort, dir,
   * group=grouped|flat), plus the totals. Exports use the full run instead.
   */
  api.get("/reports/:id/data", wrap(async (req, res) => {
    const { report, params, columns, allRows } = await run(req);
    const key = String(req.query.sort ?? "");
    const dir = req.query.dir === "desc" || req.query.dir === "asc" ? req.query.dir : "";
    const sort = key && dir && columns.some((c) => c.key === key) ? { key, dir } : null;
    const groupBy = req.query.group === "flat" ? null : report.groupBy ?? null;
    const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
    const page = paginateRows(allRows, { page: Number(req.query.page) || 1, pageSize, groupBy, sort });
    res.json({
      subtitle: report.subtitle(params),
      columns,
      rows: page.rows,
      page: page.page,
      pageSize: page.pageSize,
      totalRows: page.totalRows,
      totalPages: page.totalPages,
      startIndex: page.startIndex,
      groupCounts: page.groupCounts ? [...page.groupCounts] : null,
      summary: summaryOf(allRows),
    });
  }));
  api.get("/reports/:id/xlsx", wrap(async (req, res) => {
    const { report, params, rows } = await run(req);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(await toXlsx(report, rows, params));
  }));
  api.get("/reports/:id/csv", wrap(async (req, res) => {
    const { report, params, rows } = await run(req);
    res.type("text/csv; charset=utf-8")
      .set("Content-Disposition", `attachment; filename="${report.id}.csv"`)
      .send(toCsv(report, rows, params));
  }));
  api.get("/reports/:id/pdf", wrap(async (req, res) => {
    const { report, params, rows } = await run(req);
    // Electron renders the same HTML template through Chromium's printToPDF, with the
    // page setup and footer from server/reports/print-template.js.
    const meta = { title: report.title, subtitle: report.subtitle(params), brandName: brand.name };
    const pdf = renderPdf
      ? await renderPdf(toHtml(report, rows, params, brand.name), meta)
      : await toPdf(report, rows, params, brand.name);
    res.type("application/pdf").send(pdf);
  }));

  app.use("/api", api);
  app.use(express.static(web));
  app.use((err, _req, res, _next) => {
    if (!err.status) console.error("[server]", err);
    res.status(err.status || 500).json({ error: err.message || "Something went wrong." });
  });
  return app;
}
