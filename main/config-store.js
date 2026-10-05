import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";
import { readEnvConfig, writeEnvConfig } from "../server/env.js";

const file = () => path.join(app.getPath("userData"), "config.json");
let cache;
let env = null; // null = not looked up yet, false = no .env, object = .env is the source

/**
 * Two configuration paths, picked once per launch:
 *   - unpackaged + a usable `.env`  -> env file (local development)
 *   - everything else               -> config.json with an encrypted password (installed app)
 */
function envConfig() {
  if (env === null) env = app.isPackaged ? false : readEnvConfig() || false;
  return env || null;
}

/** Returns the decrypted config, or null if missing/incomplete. */
export function load() {
  if (cache !== undefined) return cache;
  const fromEnv = envConfig();
  if (fromEnv) return (cache = fromEnv);

  cache = null;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    const password = safeStorage.decryptString(Buffer.from(raw.passwordEnc, "base64"));
    const c = { ...raw, password };
    delete c.passwordEnc;
    if (c.host && c.port && c.user && c.database) cache = c;
  } catch { /* missing or unreadable -> setup */ }
  return cache;
}

export function save(cfg) {
  if (envConfig()) { writeEnvConfig(cfg); cache = cfg; return; }

  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage is not available on this system.");
  const { password, ...rest } = cfg;
  const passwordEnc = safeStorage.encryptString(password).toString("base64");
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ ...rest, passwordEnc }, null, 2));
  cache = cfg;
}

/** Where the current settings came from — used by the settings window. */
export function source() {
  return envConfig() ? "env" : "config.json";
}
