import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { normalizeDatabaseConfig } from "./config.js";

/** Local browser-server configuration. Electron always uses its own JSON config store. */
export const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

const DEFAULTS = { DB_PORT: "1433", TZ_OFFSET_HOURS: "1" };
const REQUIRED = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"];

/**
 * Load database settings from a root .env file, with non-empty shell variables taking
 * precedence. Returns null when there is no complete local configuration.
 */
export function readEnvConfig({ env = process.env, filePath = ENV_FILE } = {}) {
  let file = {};
  try {
    file = dotenv.parse(fs.readFileSync(filePath));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read ${path.basename(filePath)}: ${error.message}`);
    }
  }

  const value = (key) => {
    const fromShell = env[key];
    return fromShell !== undefined && fromShell !== "" ? fromShell : file[key];
  };
  const raw = {
    host: value("DB_HOST"),
    port: value("DB_PORT") || DEFAULTS.DB_PORT,
    database: value("DB_NAME"),
    user: value("DB_USER"),
    password: value("DB_PASSWORD"),
    tzOffsetHours: value("TZ_OFFSET_HOURS") || DEFAULTS.TZ_OFFSET_HOURS,
  };

  if (REQUIRED.some((key) => !String(value(key) ?? "").trim())) return null;

  return normalizeDatabaseConfig(raw);
}
