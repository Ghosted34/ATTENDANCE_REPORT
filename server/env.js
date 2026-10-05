import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { normalizeDatabaseConfig } from "./config.js";

/** Local browser-server configuration. Electron always uses its own JSON config store. */
export const ENV_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env");

const DEFAULTS = { TZ_OFFSET_HOURS: "1" };
// One connection string is the whole database configuration; DATABASE_URL is accepted as an alias.
const CONNECTION_KEYS = ["DB_CONNECTION_STRING", "DATABASE_URL"];
// Split fields from earlier versions, named here only to point at the new setting.
const LEGACY_KEYS = ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_PORT"];

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

  const connectionString = CONNECTION_KEYS.map((key) => value(key)).find((v) => String(v ?? "").trim());
  if (!connectionString) {
    const legacy = LEGACY_KEYS.filter((key) => String(value(key) ?? "").trim());
    if (legacy.length) {
      throw new Error(
        `${legacy.join(", ")} ${legacy.length === 1 ? "is" : "are"} no longer used. Put those values into one ` +
        "DB_CONNECTION_STRING, for example Server=192.168.1.10,1433;Database=VIAC;User Id=reports;Password=…;",
      );
    }
    return null;
  }

  return normalizeDatabaseConfig({
    connectionString,
    tzOffsetHours: value("TZ_OFFSET_HOURS") || DEFAULTS.TZ_OFFSET_HOURS,
  });
}
