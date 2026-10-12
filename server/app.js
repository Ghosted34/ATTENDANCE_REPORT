import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { brand, version } from "./brand.js";
import { login, requireAuth } from "./auth.js";
import { reports } from "./reports/registry.js";
import { toCsv, toXlsx, toHtml } from "./reports/export.js";
import { toPdf } from "./reports/pdf.js";
// The renderer's template module is the DOM-free home of the report presentation rules (its own
// docstring says so, and the tests import it from both sides), so the ordering an export uses is
// the very function the table sorts with — one comparator, so the sheet cannot come out in a
// different order from the screen it was exported from.
import { sectionsOf, sortRows } from "../renderer/app/js/template.js";

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer", "app");
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

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
    res.json([...reports.values()].map(({ id, title, description, params, columns, groupBy }) =>
      ({ id, title, description, params, columns, groupBy }))));

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
    const rows = await report.run(params, { tz: getConfig().tzOffsetHours });
    const columns = report.columnsFor ? report.columnsFor(params) : report.columns;
    return { report, params, columns, rows: inRequestedOrder(rows, columns, req.query, report.groupBy) };
  };

  api.get("/reports/:id/data", wrap(async (req, res) => {
    const { rows, report, params, columns } = await run(req);
    res.json({ rows, subtitle: report.subtitle(params), columns });
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
