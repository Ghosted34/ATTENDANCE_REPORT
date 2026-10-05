/**
 * Standalone server for local development: `npm run dev` (nodemon) or `npm run serve`.
 *
 * This is the browser-based counterpart to the desktop app. It serves the same renderer
 * and the same API, so you can develop reports without launching a window. Two deliberate
 * differences, both because there is no Electron here:
 *   - no `x-app-token` secret, so the API is open (see the loopback default below)
 *   - no PDF export, which relies on Electron's printToPDF (Excel export still works)
 */
import http from "http";
import dotenv from "dotenv";
import { createApp } from "./app.js";
import { configure, getPool } from "./db/pool.js";
import { readEnvConfig, ENV_FILE } from "./env.js";
import { brand } from "./brand.js";

const cfg = readEnvConfig();
if (!cfg) {
  console.error(
    `\n${brand.name}: no usable database configuration.\n` +
    `  Copy .env.example to .env and fill in DB_HOST, DB_NAME, DB_USER and DB_PASSWORD,\n` +
    `  or export those variables in your shell.\n` +
    `  Looked for: ${ENV_FILE}\n`);
  process.exit(1);
}

await configure(cfg);
try {
  await getPool(); // fail fast, with the real error, instead of on the first report
} catch (err) {
  console.error(
    `\n${brand.name}: cannot reach SQL Server at ${cfg.host},${cfg.port} ` +
    `(database "${cfg.database}" as "${cfg.user}"):\n  ${err.message}\n`);
  process.exit(1);
}

// PORT/HOST are dev-server concerns, not database ones, so they are not part of
// readEnvConfig(). Load the file into process.env for them; dotenv leaves shell
// variables alone, which keeps "DB_HOST=... npm run dev" winning over the file.
dotenv.config({ path: ENV_FILE, quiet: true });

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";

http.createServer(createApp({ secret: null, getConfig: () => cfg, renderPdf: null }))
  .listen(port, host, () => {
    console.log(`${brand.name} — dev server`);
    console.log(`  UI       http://${host}:${port}`);
    console.log(`  Database ${cfg.host},${cfg.port} — ${cfg.database} as ${cfg.user}`);
    console.log(`  Config   ${ENV_FILE} (tz offset ${cfg.tzOffsetHours}h)`);
    console.log(`  Sign in  admin / admin (mock login in server/auth.js)`);
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1")
      console.warn(`  WARNING  listening on ${host} with no API token — anyone who can reach this port can query the database.`);
  });
