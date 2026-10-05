import mssql from "mssql";

let cfg = null, pool = null;

const make = (c) => new mssql.ConnectionPool({
  user: c.user, password: c.password, server: c.host, port: Number(c.port), database: c.database,
  connectionTimeout: 5000, requestTimeout: 30000,
  options: { trustServerCertificate: true, enableArithAbort: true },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
});

export async function testConnection(c) {
  const p = make(c);
  try { await p.connect(); await p.request().query("SELECT 1 AS ok"); }
  finally { await p.close().catch(() => {}); }
}

export async function closePool() {
  const p = pool; pool = null;
  if (p) await p.close().catch(() => {});
}

export async function configure(c) { await closePool(); cfg = c; }

export async function getPool() {
  if (!cfg) throw new Error("Database is not configured.");
  if (!pool) {
    const p = make(cfg);
    p.on("error", () => { if (pool === p) pool = null; }); // reconnect lazily on next query
    await p.connect();
    pool = p;
  }
  return pool;
}

/** query(sql, { name: value }) -> recordset rows. Params bind as @name. */
export async function query(sql, params = {}) {
  const req = (await getPool()).request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  return (await req.query(sql)).recordset;
}
