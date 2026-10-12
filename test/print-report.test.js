import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import attendance from "../server/reports/attendance.js";
import { toHtml } from "../server/reports/export.js";
import { printOptions } from "../server/reports/print-template.js";
import { DATA_URL_PREFIX, dataUrlLength, printHtmlToPdf, removeReportHtml } from "../main/print-report.js";

/*
 * The desktop PDF path without Electron, a browser or a database: the report HTML is built by the
 * real template, and the Chromium halves (`loadFile`, `printToPDF`) are injected. That is enough to
 * pin the fix for `ERR_INVALID_URL (-300)`, which came from passing the whole report as a
 * `data:text/html,…` URL: Chromium's URL limit is about 2 MB, a month of rows is much bigger, and
 * the report now travels through a temporary file instead.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const AUGUST = Array.from({ length: 31 }, (_, day) => `2026-08-${String(day + 1).padStart(2, "0")}`);
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekday = (date) => WEEKDAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()];
const DEPARTMENTS = ["Ops", "Security", "Admin", "Front Desk"];

/** One row per person per local day, present and absent, exactly as the month report produces them. */
function monthRows(count) {
  const rows = [];
  for (let person = 0; rows.length < count; person += 1) {
    const date = AUGUST[Math.floor(person / 597) % AUGUST.length];
    const absent = person % 5 === 0;
    rows.push({
      date,
      day: weekday(date),
      name: absent ? `Okonkwo Chidịmma ${person}` : `Person ${person} Surname`,
      idNumber: 1000 + person,
      department: DEPARTMENTS[person % DEPARTMENTS.length],
      status: absent ? "Absent" : "Present",
      cardNumber: absent ? "—" : 12000 + person,
      firstEntry: absent ? "—" : "08:01:02",
      lastEntry: absent ? "—" : "17:12:00",
      duration: absent ? "—" : "9h 11m",
      accessCount: absent ? 0 : 2,
    });
  }
  return rows;
}

const monthHtml = (rows) =>
  toHtml(attendance, rows, attendance.normalize({ mode: "month", month: "2026-08" }), "Reports Desk");

const exists = (target) => fs.existsSync(target);

test("a report too big for a data: URL is printed from a temporary file instead", async () => {
  const rows = monthRows(18517); // August 2026 with absentees: the month that failed to print
  const html = monthHtml(rows);
  const meta = { title: attendance.title, subtitle: attendance.subtitle(attendance.normalize({ mode: "month", month: "2026-08" })), brandName: "Reports Desk" };

  // What the URL limit could not take, and why nothing here builds a URL at all.
  assert.equal(DATA_URL_PREFIX, "data:text/html;charset=utf-8,");
  assert.ok(dataUrlLength(html) > 8 * 1024 * 1024, "the August report is far over Chromium's ~2 MB URL limit");
  assert.ok(dataUrlLength(monthHtml(monthRows(5000))) > 2 * 1024 * 1024,
    "a report is already over the ~2 MB URL limit at roughly 5,000 rows");

  const seen = [];
  const pdf = await printHtmlToPdf({
    html,
    meta,
    loadFile: async (file) => {
      // The loader is Electron's `BrowserWindow.loadFile`, so it gets a path, never a data: URL.
      assert.equal(typeof file, "string");
      assert.equal(path.isAbsolute(file), true, file);
      assert.equal(file.startsWith("data:"), false, file);
      assert.equal(path.extname(file), ".html");
      seen.push({ file, dir: path.dirname(file), body: fs.readFileSync(file, "utf8") });
    },
    printToPDF: async (options) => {
      assert.deepEqual(options, printOptions(meta)); // page setup and footer still come from the template
      return Buffer.from("%PDF-1.7 big report");
    },
  });

  assert.equal(pdf.toString(), "%PDF-1.7 big report");
  assert.equal(seen.length, 1);
  // The whole report reached the file, byte for byte and as UTF-8: no truncation at a URL limit.
  assert.equal(seen[0].body, html);
  assert.equal(seen[0].body.length, html.length);
  assert.match(seen[0].body, /Okonkwo Chidịmma 0/); // a name outside ASCII survives
  assert.match(seen[0].body, /@page\{size:A4 landscape/); // the print template's page setup
  assert.ok(seen[0].body.includes("—"), "the em dash in absent rows survives");
  assert.equal(exists(seen[0].file), false, "the report file is deleted after printing");
  assert.equal(exists(seen[0].dir), false, "its temporary folder is deleted too");
});

test("the temporary report file is removed even when printing fails", async () => {
  const failure = Object.assign(new Error("ERR_FILE_NOT_FOUND (-6) loading 'report.html'"), { code: "ERR_FILE_NOT_FOUND", errno: -6 });
  let dir = null;
  await assert.rejects(
    printHtmlToPdf({
      html: monthHtml(monthRows(50)),
      meta: { title: attendance.title, subtitle: "x", brandName: "Reports Desk" },
      loadFile: async (file) => { dir = path.dirname(file); assert.equal(exists(file), true); throw failure; },
      printToPDF: async () => { throw new Error("must not be reached"); },
    }),
    (error) => error === failure, // the real reason reaches the log, not a cleanup error
  );
  assert.equal(exists(dir), false, "a failed print leaves no report behind on disk");

  // Cleanup is best effort: a folder that is already gone (or unreadable) is not an error.
  await removeReportHtml(dir);
  await removeReportHtml(null);
});

test("two prints never share a file, and a new one starts writing again", async () => {
  const paths = [];
  const print = (label) => printHtmlToPdf({
    html: `<h1>${label}</h1>`,
    meta: { title: label },
    loadFile: async (file) => { paths.push({ label, dir: path.dirname(file), body: fs.readFileSync(file, "utf8") }); },
    printToPDF: async () => Buffer.from(label),
  });
  const results = await Promise.all([print("first"), print("second"), print("third")]);

  assert.deepEqual(results.map((b) => b.toString()), ["first", "second", "third"]);
  assert.equal(new Set(paths.map((p) => p.dir)).size, 3, "each print gets its own temporary folder");
  for (const { label, body } of paths) assert.equal(body, `<h1>${label}</h1>`);
  for (const { dir } of paths) assert.equal(exists(dir), false);
});

test("the desktop app loads report HTML from a file, and no longer from a data: URL", () => {
  // Electron cannot run in the test suite; this pins the wiring the fix depends on.
  const main = fs.readFileSync(path.join(root, "main", "main.js"), "utf8");
  assert.doesNotMatch(main, /data:text\/html/);
  // The one remaining loadURL is the app's own loopback window, not a report.
  const navigations = [...main.matchAll(/loadURL\(([^)]*)/g)].map(([, url]) => url.trim());
  assert.deepEqual(navigations, ["`http://127.0.0.1:${port}`"]);
  assert.match(main, /printHtmlToPdf\(\{/);
  assert.match(main, /loadFile: \(file\) => w\.loadFile\(file\)/);
  assert.match(main, /printToPDF: \(options\) => w\.webContents\.printToPDF\(options\)/);
  // The print window lives outside the app's own temporary folder only as far as Electron says.
  assert.match(main, /app\.getPath\("temp"\)/);

  const module = fs.readFileSync(path.join(root, "main", "print-report.js"), "utf8");
  assert.match(module, /mkdtemp/);
  assert.match(module, /fs\.rm\(dir, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(module, /loadURL/);
});
