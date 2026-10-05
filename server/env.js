import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

/**
 * Local-development configuration from `.env`.
 *
 * Two consumers, one source of truth:
 *   - `server/start.js`  — the browser dev server (`npm run dev`), which has no Electron
 *     around it and needs the database settings straight from the environment.
 *   - `main/config-store.js` — the desktop app when run unpackaged, so a developer does
 *     not have to duplicate their settings. The installed app ignores `.env` entirely and
 *     uses <userData>/config.json with the password encrypted by safeStorage.
 *
 * `.env` is never packaged (see the `files` list in electron-builder.json) and is gitignored.
 */

export const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

export const ENV_VARS = {
  host: "DB_HOST",
  port: "DB_PORT",
  user: "DB_USER",
  password: "DB_PASSWORD",
  database: "DB_NAME",
  tzOffsetHours: "TZ_OFFSET_HOURS",
};

const BY_VAR = Object.fromEntries(Object.entries(ENV_VARS).map(([key, name]) => [name, key]));
const DEFAULTS = { port: "1433", tzOffsetHours: "1" };
const RANGES = { port: [1, 65535], tzOffsetHours: [-12, 14] };

const text = (v) => (v === undefined || v === null ? "" : String(v).trim());

function whole(v, key) {
  const raw = text(v);
  if (raw === "") return null;
  const n = Number(raw);
  const [lo, hi] = RANGES[key];
  return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

/**
 * Reads `.env`, with real environment variables taking precedence over file values.
 * Returns a config object, or null when there is no usable `.env` at all.
 */
export function readEnvConfig() {
  let file = {};
  try {
    file = dotenv.parse(fs.readFileSync(ENV_FILE));
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("[env] Could not read .env:", err.message);
  }

  // A variable counts as "present" if the shell or the file supplies it.
  const val = (name) => {
    const fromEnv = process.env[name];
    return fromEnv !== undefined && fromEnv !== "" ? fromEnv : file[name];
  };
  const supplied = (name) => val(name) !== undefined && text(val(name)) !== "";

  const cfg = {
    host: text(val(ENV_VARS.host)),
    user: text(val(ENV_VARS.user)),
    database: text(val(ENV_VARS.database)),
    password: text(val(ENV_VARS.password)),
    port: whole(val(ENV_VARS.port) ?? DEFAULTS.port, "port"),
    tzOffsetHours: whole(val(ENV_VARS.tzOffsetHours) ?? DEFAULTS.tzOffsetHours, "tzOffsetHours"),
  };

  if (!cfg.host || !cfg.user || !cfg.database) {
    // Something was configured but incomplete — say so instead of silently falling back.
    if (Object.keys(ENV_VARS).some((key) => supplied(ENV_VARS[key]))) {
      const missing = ["host", "user", "database"].filter((k) => !cfg[k]).map((k) => ENV_VARS[k]);
      console.warn(`[env] ${path.basename(ENV_FILE)} is incomplete (missing ${missing.join(", ")}); ignoring it.`);
    }
    return null;
  }
  if (cfg.port === null || cfg.tzOffsetHours === null) {
    const bad = ["port", "tzOffsetHours"].filter((k) => cfg[k] === null).map((k) => ENV_VARS[k]);
    console.warn(`[env] ${path.basename(ENV_FILE)} has an out-of-range ${bad.join(", ")}; ignoring it.`);
    return null;
  }
  return { ...cfg, source: "env" };
}

const quote = (v) => (/[\s#"'\\]/.test(v) ? `"${v.replace(/(["\\])/g, "\\$1")}"` : v);

/** Writes a config back to `.env`, preserving comments, ordering and unrelated keys. */
export function writeEnvConfig(cfg) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const done = new Set();

  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || !(m[1] in BY_VAR)) return line;
    done.add(m[1]);
    return `${m[1]}=${quote(text(cfg[BY_VAR[m[1]]]))}`;
  });

  for (const [name, key] of Object.entries(BY_VAR)) {
    if (!done.has(name)) out.push(`${name}=${quote(text(cfg[key]))}`);
  }

  const body = out.join("\n").replace(/\n*$/, "") + "\n";
  fs.writeFileSync(ENV_FILE, body);
  try { fs.chmodSync(ENV_FILE, 0o600); } catch { /* Windows: best effort */ }
  return ENV_FILE;
}
