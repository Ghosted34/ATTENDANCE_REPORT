import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The installer is built on Windows, which this suite cannot do. These checks pin the configuration
// that makes an in-place update over an existing install keep the user's settings.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const builder = JSON.parse(read("electron-builder.json"));

test("the app keeps its identity, so an update replaces the existing install instead of adding a second one", () => {
  // electron-builder derives the NSIS uninstall GUID from appId, and the per-user data folder from
  // productName. Changing either would orphan the installed copy and its saved settings.
  assert.equal(builder.appId, "com.reportsdesk.app");
  assert.equal(builder.productName, "Reports Desk");
  assert.equal(builder.nsis.guid, undefined, "the GUID is derived from appId; pinning another one would split upgrades");
});

test("uninstalling or upgrading never deletes per-user data", () => {
  assert.equal(builder.nsis.deleteAppDataOnUninstall, false);
  // Install per user, so each Windows account has its own settings and its own safeStorage key.
  assert.equal(builder.nsis.perMachine, false);
  assert.equal(builder.nsis.oneClick, false);
  assert.equal(builder.nsis.allowToChangeInstallationDirectory, true);
});

test("only the app's code and brand file are packaged, never a local .env, settings file or database file", () => {
  assert.deepEqual(builder.files, ["main/**/*", "server/**/*", "renderer/**/*", "brand.json"]);
  for (const pattern of builder.files) {
    assert.doesNotMatch(pattern, /\.env|config\.json|\.db$|\.bak$/);
  }
  assert.deepEqual(builder.win.target, [{ target: "nsis", arch: ["x64"] }]);
});

test("desktop settings live in Electron's userData folder, encrypted with safeStorage, and nowhere else", () => {
  const store = read("main/config-store.js");
  assert.match(store, /app\.getPath\("userData"\)/);
  assert.match(store, /config\.json/);
  assert.match(store, /safeStorage\.encryptString/);
  assert.match(store, /safeStorage\.decryptString/);
  // No hard-coded location (which would be shared across users or PCs) and no copy of the settings.
  assert.doesNotMatch(store, /C:\\\\|\/Users\/|APPDATA|process\.env\./);
  assert.doesNotMatch(store, /copyFile|renameSync|unlinkSync|rmSync/);
});

test("no real connection string or password is committed to the source or example files", () => {
  const files = ["main/config-store.js", "main/main.js", "server/config.js", "server/env.js", ".env.example"];
  for (const file of files) {
    const text = read(file);
    assert.doesNotMatch(text, /Password=(?![…$;*<\s])[^;\s]{3,}/, file);
  }
});
