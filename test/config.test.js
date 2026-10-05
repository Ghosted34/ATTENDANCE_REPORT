import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  connectionStringFrom, describeConnection, maskConnectionString, normalizeDatabaseConfig,
} from "../server/config.js";
import { readEnvConfig } from "../server/env.js";

const CONNECTION = "Server=192.168.1.10,1433;Database=VIAC;User Id=reports;Password=s3cret!;TrustServerCertificate=True";

function withEnvFile(contents, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-env-"));
  const filePath = path.join(dir, ".env");
  fs.writeFileSync(filePath, contents);
  try { run(filePath); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("one connection string is split internally and the password is never a field of its own", () => {
  const config = normalizeDatabaseConfig({ connectionString: CONNECTION, tzOffsetHours: 1 });
  assert.deepEqual(config, {
    connectionString: CONNECTION,
    host: "192.168.1.10",
    database: "VIAC",
    user: "reports",
    port: 1433,
    tzOffsetHours: 1,
  });
  assert.equal(Object.keys(config).includes("password"), false);
  assert.equal(describeConnection(config), "192.168.1.10,1433 — VIAC as reports");
  assert.equal(config.connectionString.includes("s3cret!"), true); // kept whole for mssql
});

test("connection strings accept the usual aliases, named instances and pasted quotes", () => {
  const named = normalizeDatabaseConfig({
    connectionString: "Data Source=HOST\\SQLEXPRESS;Initial Catalog=VIAC;User ID=sa;PWD=pw;TrustServerCertificate=True",
  });
  assert.equal(named.host, "HOST");
  assert.equal(named.database, "VIAC");
  assert.equal(named.user, "sa");

  const ported = normalizeDatabaseConfig({
    connectionString: "server=10.0.0.5,1444;database=Att;uid=u;pwd=p;encrypt=true",
  });
  assert.equal(ported.host, "10.0.0.5");
  assert.equal(ported.port, 1444);

  const quoted = normalizeDatabaseConfig({ connectionString: `"${CONNECTION}"` });
  assert.equal(quoted.connectionString, CONNECTION);
});

test("incomplete or malformed connection strings are rejected with clear messages", () => {
  const bad = (connectionString, expected) =>
    assert.throws(() => normalizeDatabaseConfig({ connectionString }), expected);
  bad("", /Paste the database connection string/);
  bad("nonsense", /not a connection string/);
  bad("Server=db;Database=VIAC", /User Id and a Password/);
  bad("Server=db;Database=VIAC;User Id=u", /User Id and a Password/);
  bad("Server=;Database=VIAC;User Id=u;Password=p", /empty value/);
  bad("Server=db;Database=;User Id=u;Password=p", /empty value/);
  bad("Server=db,0;Database=VIAC;User Id=u;Password=p", /Port must be/);
});

test("the UTC offset stays a validated whole number of hours and defaults to 1", () => {
  assert.equal(normalizeDatabaseConfig({ connectionString: CONNECTION }).tzOffsetHours, 1);
  assert.equal(normalizeDatabaseConfig({ connectionString: CONNECTION, tzOffsetHours: "2" }).tzOffsetHours, 2);
  assert.equal(normalizeDatabaseConfig({ connectionString: CONNECTION, tzOffsetHours: "" }).tzOffsetHours, 1);
  assert.throws(() => normalizeDatabaseConfig({ connectionString: CONNECTION, tzOffsetHours: 15 }), /UTC offset/);
  assert.throws(() => normalizeDatabaseConfig({ connectionString: CONNECTION, tzOffsetHours: 1.5 }), /UTC offset/);
});

test("maskConnectionString hides the password, even one with separators in it", () => {
  assert.equal(
    maskConnectionString(CONNECTION),
    "Server=192.168.1.10,1433;Database=VIAC;User Id=reports;Password=••••;TrustServerCertificate=True",
  );
  const awkward = connectionStringFrom({ host: "h", port: 1433, database: "d", user: "u", password: 'p;a{s}s"x' });
  assert.equal(maskConnectionString(awkward).includes("s}}s"), false);
  assert.match(maskConnectionString(awkward), /Password=••••/);
});

test("connectionStringFrom round-trips split fields, so old Electron settings can be migrated", () => {
  const password = 'p;a{s}s"x';
  const built = connectionStringFrom({ host: "h", port: 1444, database: "d", user: "u", password });
  const config = normalizeDatabaseConfig({ connectionString: built });
  assert.equal(config.host, "h");
  assert.equal(config.port, 1444);
  assert.equal(config.database, "d");
  assert.equal(config.user, "u");
  assert.equal(/Password=(.*);TrustServerCertificate/.exec(config.connectionString)[1], `{p;a{s}}s"x}`);
});

test("local .env config applies the connection string, Lagos default and shell overrides", () => {
  withEnvFile([
    `DB_CONNECTION_STRING=${CONNECTION}`,
    "TZ_OFFSET_HOURS=",
  ].join("\n"), (filePath) => {
    const config = readEnvConfig({ env: { DB_CONNECTION_STRING: "Server=shell;Database=Other;User Id=u;Password=p" }, filePath });
    assert.equal(config.connectionString, "Server=shell;Database=Other;User Id=u;Password=p");
    assert.equal(config.tzOffsetHours, 1);

    const fromFile = readEnvConfig({ env: {}, filePath });
    assert.equal(fromFile.connectionString, CONNECTION);
  });
});

test("DATABASE_URL is accepted as an alias and a missing connection string returns null", () => {
  withEnvFile("DATABASE_URL=Server=db;Database=VIAC;User Id=u;Password=p\n", (filePath) => {
    assert.equal(readEnvConfig({ env: {}, filePath }).database, "VIAC");
  });
  withEnvFile("TZ_OFFSET_HOURS=1\nPORT=3000\n", (filePath) => {
    assert.equal(readEnvConfig({ env: {}, filePath }), null);
  });
});

test("a .env still holding the old split fields explains what to change", () => {
  withEnvFile([
    "DB_HOST=db.example.test",
    "DB_NAME=VIAC",
    "DB_USER=reports",
    "DB_PASSWORD=pw",
  ].join("\n"), (filePath) => {
    assert.throws(
      () => readEnvConfig({ env: {}, filePath }),
      /DB_HOST, DB_NAME, DB_USER, DB_PASSWORD are no longer used.*DB_CONNECTION_STRING/s,
    );
  });
});
