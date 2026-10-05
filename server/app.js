import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { brand } from "./brand.js";
import { login, requireAuth } from "./auth.js";
import { reports } from "./reports/registry.js";
import { toXlsx, toHtml } from "./reports/export.js";

const web = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "renderer", "app");
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

export function createApp({ secret, getConfig, renderPdf }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  // In the desktop app every window carries a per-launch secret, injected by Electron.
  // With no secret configured — the browser dev server — the API is open, so that server
  // must stay bound to loopback (see server/start.js).
  if (secret) {
    app.use((req, res, next) =>
      req.headers["x-app-token"] === secret ? next() : res.status(403).end());
  }

  app.get("/api/live", (_req, res) => res.json({ ok: true }));
  app.get("/api/meta", (_req, res) => res.json({ name: brand.name }));

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

  const run = async (req) => {
    const report = reports.get(req.params.id);
    if (!report) throw Object.assign(new Error("Unknown report."), { status: 404 });
    const params = Object.fromEntries(report.params.map((p) => [p.name, String(req.query[p.name] ?? "")]));
    const rows = await report.run(params, { tz: getConfig().tzOffsetHours });
    return { report, params, rows };
  };

  api.get("/reports/:id/data", wrap(async (req, res) => {
    const { rows, report, params } = await run(req);
    res.json({ rows, subtitle: report.subtitle(params) });
  }));
  api.get("/reports/:id/xlsx", wrap(async (req, res) => {
    const { report, params, rows } = await run(req);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(await toXlsx(report, rows, params));
  }));
  api.get("/reports/:id/pdf", wrap(async (req, res) => {
    if (!renderPdf) return res.status(501)
      .json({ error: "PDF export needs the desktop app. Use Export Excel here." });
    const { report, params, rows } = await run(req);
    res.type("application/pdf").send(await renderPdf(toHtml(report, rows, params, brand.name)));
  }));

  app.use("/api", api);
  app.use(express.static(web));
  app.use((err, _req, res, _next) => {
    if (!err.status) console.error("[server]", err);
    res.status(err.status || 500).json({ error: err.message || "Something went wrong." });
  });
  return app;
}
