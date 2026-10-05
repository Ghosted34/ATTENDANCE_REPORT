import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeDatabaseConfig } from "../server/config.js";
import { readEnvConfig } from "../server/env.js";

function withEnvFile(contents, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-env-"));
  const filePath = path.join(dir, ".env");
  fs.writeFileSync(filePath, contents);
  try { run(filePath); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("local .env config applies database and Lagos defaults and shell overrides", () => {
  withEnvFile([
    "DB_HOST=db.example.test",
    "DB_NAME=Attendance",
    "DB_USER=file_user",
    'DB_PASSWORD=" secret "',
  ].join("\n"), (filePath) => {
    assert.deepEqual(readEnvConfig({ env: { DB_USER: "shell_user" }, filePath }), {
      host: "db.example.test",
      port: 1433,
      user: "shell_user",
      password: " secret ",
      database: "Attendance",
      tzOffsetHours: 1,
    });
  });
});

test("local .env config returns null when required values are absent", () => {
  withEnvFile("DB_HOST=db.example.test\n", (filePath) => {
    assert.equal(readEnvConfig({ env: {}, filePath }), null);
  });
});

test("shared settings validation rejects invalid ports and UTC offsets", () => {
  const valid = { host: "db", port: 1433, user: "u", password: "p", database: "d", tzOffsetHours: 1 };
  assert.throws(() => normalizeDatabaseConfig({ ...valid, port: 70000 }), /Port must be/);
  assert.throws(() => normalizeDatabaseConfig({ ...valid, tzOffsetHours: 15 }), /UTC offset must be/);
});
