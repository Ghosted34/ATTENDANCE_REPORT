import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";
import { connectionStringFrom, normalizeDatabaseConfig } from "../server/config.js";

const file = () => path.join(app.getPath("userData"), "config.json");
let cache;

/**
 * Returns the decrypted config, or null if missing/incomplete.
 *
 * The connection string is the secret (it contains the password), so it is stored
 * encrypted with safeStorage; the UTC offset stays readable.
 */
export function load() {
  if (cache !== undefined) return cache;
  cache = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    const connectionString = raw.connectionStringEnc
      ? safeStorage.decryptString(Buffer.from(raw.connectionStringEnc, "base64"))
      : legacyConnectionString(raw);
    if (connectionString) cache = normalizeDatabaseConfig({ connectionString, tzOffsetHours: raw.tzOffsetHours });
  } catch { /* missing or unreadable -> setup */ }
  return cache;
}

/** Installs from before the single-string change kept split fields with an encrypted password. */
function legacyConnectionString(raw) {
  if (!raw.host || !raw.database || !raw.user || !raw.passwordEnc) return "";
  const password = safeStorage.decryptString(Buffer.from(raw.passwordEnc, "base64"));
  return connectionStringFrom({
    host: raw.host, port: raw.port ?? 1433, database: raw.database, user: raw.user, password,
  });
}

export function save(cfg) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage is not available on this system.");
  const connectionStringEnc = safeStorage.encryptString(cfg.connectionString).toString("base64");
  const data = { tzOffsetHours: cfg.tzOffsetHours, connectionStringEnc };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(data, null, 2));
  cache = cfg;
}
