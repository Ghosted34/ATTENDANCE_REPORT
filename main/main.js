import { app, BrowserWindow, Menu, dialog, ipcMain, session } from "electron";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import * as store from "./config-store.js";
import { startServer, stopServer } from "../server/index.js";
import { testConnection, configure, getPool } from "../server/db/pool.js";
import { brand } from "../server/brand.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = (...p) => path.join(here, "..", "renderer", ...p);
const preload = path.join(here, "preload.cjs");
const secret = crypto.randomBytes(24).toString("hex"); // per-launch API secret
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let splash = null, mainWin = null, quitting = false, onSaved = null;

/* ---------- Windows ---------- */
async function createSplash() {
  splash = new BrowserWindow({
    width: 420, height: 260, frame: false, resizable: false, center: true, alwaysOnTop: true,
    webPreferences: { preload, contextIsolation: true },
  });
  await splash.loadFile(ui("splash", "splash.html"));
}
const status = (text, pct) =>
  splash && !splash.isDestroyed() && splash.webContents.send("splash:status", { text, pct, brand: brand.name });

function openSettings() {
  return new Promise((resolve) => {
    let saved = false;
    splash?.hide();
    const win = new BrowserWindow({
      width: 520, height: 600, resizable: false, center: true, title: `${brand.name} – Database settings`,
      webPreferences: { preload, contextIsolation: true },
    });
    win.removeMenu();
    win.loadFile(ui("setup", "setup.html"));
    onSaved = () => { saved = true; setTimeout(() => win.close(), 700); };
    win.on("closed", () => { onSaved = null; if (!mainWin) splash?.show(); resolve(saved); });
  });
}

function createMainWindow(port) {
  mainWin = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600, show: false, title: brand.name,
    webPreferences: { contextIsolation: true },
  });
  mainWin.loadURL(`http://127.0.0.1:${port}`);
  mainWin.once("ready-to-show", () => { mainWin.show(); splash?.close(); });
  mainWin.on("closed", () => app.quit());
}

async function renderPdf(html) {
  const w = new BrowserWindow({ show: false });
  try {
    await w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    return await w.webContents.printToPDF({ pageSize: "A4", printBackground: true });
  } finally { w.destroy(); }
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "File", submenu: [
      { label: "Database settings…", accelerator: "Ctrl+,", click: () => openSettings() },
      { type: "separator" }, { role: "quit" } ] },
    { label: "Edit", submenu: [{ role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "zoomIn" }, { role: "zoomOut" }, { role: "resetZoom" },
      ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }])] },
  ]));
}

/* ---------- Settings IPC ---------- */
ipcMain.handle("settings:get", () => {
  const c = store.load();
  return c
    ? { ...c, password: "", hasPassword: true }
    : { host: "", port: "1433", user: "", password: "", database: "", tzOffsetHours: 1, hasPassword: false };
});

ipcMain.handle("settings:save", async (_e, v) => {
  try {
    const old = store.load();
    const cfg = {
      host: String(v.host || "").trim(), port: Number(v.port), user: String(v.user || "").trim(),
      password: v.password || old?.password || "", database: String(v.database || "").trim(),
      tzOffsetHours: Number(v.tzOffsetHours),
    };
    if (!cfg.host || !cfg.user || !cfg.database || !cfg.password) throw new Error("Fill in every field.");
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error("Port must be 1–65535.");
    if (!Number.isInteger(cfg.tzOffsetHours) || cfg.tzOffsetHours < -12 || cfg.tzOffsetHours > 14)
      throw new Error("UTC offset must be a whole number of hours.");
    await testConnection(cfg);       // save only if it connects
    store.save(cfg);
    await configure(cfg);            // recycles the pool, no restart needed
    onSaved?.();
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

/* ---------- Boot ---------- */
async function connectDatabase() {
  for (;;) {
    const cfg = store.load();
    if (!cfg) { if (!(await openSettings())) return false; continue; }
    status("Connecting to database", 35);
    try { await configure(cfg); await getPool(); return true; }
    catch (err) {
      splash?.hide();
      const choice = dialog.showMessageBoxSync({
        type: "error", title: brand.name, message: "Can't connect to the database.",
        detail: err.message, buttons: ["Open settings", "Quit"], defaultId: 0, cancelId: 1,
      });
      splash?.show();
      if (choice === 1 || !(await openSettings())) return false;
    }
  }
}

async function boot() {
  await createSplash();
  status("Checking configuration", 10);
  await wait(250);
  if (!(await connectDatabase())) return app.quit();

  status("Starting service", 65);
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ["http://127.0.0.1:*/*"] }, (d, cb) => {
    d.requestHeaders["x-app-token"] = secret;
    cb({ requestHeaders: d.requestHeaders });
  });
  const port = await startServer({ secret, getConfig: store.load, renderPdf });
  const live = await fetch(`http://127.0.0.1:${port}/api/live`, { headers: { "x-app-token": secret } });
  if (!live.ok) throw new Error("Service failed its health check.");

  status("Ready", 100);
  buildMenu();
  createMainWindow(port);
}

if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on("second-instance", () => {
    if (!mainWin) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  });
  // Keep the app alive while windows swap (splash -> settings -> main); quit is explicit.
  app.on("window-all-closed", () => {});
  app.on("before-quit", async (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    await Promise.race([stopServer(), wait(5000)]);
    app.exit(0);
  });
  app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox(brand.name, err.stack || err.message);
    app.exit(1);
  });
}
