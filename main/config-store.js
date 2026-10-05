import { app, safeStorage } from "electron";
import fs from "fs";
import path from "path";

const file = () => path.join(app.getPath("userData"), "config.json");
let cache;

/** Returns the decrypted config, or null if missing/incomplete. */
export function load() {
  if (cache !== undefined) return cache;
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
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage is not available on this system.");
  const { password, ...rest } = cfg;
  const passwordEnc = safeStorage.encryptString(password).toString("base64");
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ ...rest, passwordEnc }, null, 2));
  cache = cfg;
}
