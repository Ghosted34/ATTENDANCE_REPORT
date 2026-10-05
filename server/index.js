import http from "http";
import { createApp } from "./app.js";
import { closePool } from "./db/pool.js";

let server = null;
const conns = new Set();

/** Listens on loopback by default; Electron uses a free port, local mode can choose one. */
export function startServer(opts, { host = "127.0.0.1", port = 0 } = {}) {
  return new Promise((resolve, reject) => {
    server = http.createServer(createApp(opts));
    server.on("connection", (c) => { conns.add(c); c.on("close", () => conns.delete(c)); });
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

export async function stopServer() {
  for (const c of conns) c.destroy();
  conns.clear();
  if (server?.listening) await new Promise((r) => server.close(() => r()));
  server = null;
  await closePool();
}
