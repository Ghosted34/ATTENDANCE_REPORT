import dotenv from "dotenv";
import { brand } from "./brand.js";
import { configure, testConnection } from "./db/pool.js";
import { ENV_FILE, readEnvConfig } from "./env.js";
import { startServer, stopServer } from "./index.js";

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[local] ${signal}: shutting down…`);
  try {
    await stopServer();
  } catch (error) {
    console.error(`[local] Shutdown failed: ${error.message}`);
  }
  // Nodemon uses SIGUSR2 to request a clean restart.
  if (signal === "SIGUSR2") process.kill(process.pid, "SIGUSR2");
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
process.once("SIGUSR2", () => { void shutdown("SIGUSR2"); });

async function main() {
  // Populate PORT from .env while retaining shell-variable precedence.
  dotenv.config({ path: ENV_FILE, quiet: true });
  const config = readEnvConfig();
  if (!config) {
    throw new Error(
      `No complete local database configuration. Copy .env.example to .env and fill in ` +
      "DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD.",
    );
  }

  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a whole number between 1 and 65535.");
  }

  await testConnection(config); // Fail fast before opening the UI; closes its temporary pool.
  await configure(config);

  const actualPort = await startServer(
    { getConfig: () => config },
    { host: "127.0.0.1", port },
  );
  console.log(`${brand.name} — local browser mode`);
  console.log(`  UI       http://127.0.0.1:${actualPort}`);
  console.log(`  Database ${config.host},${config.port} — ${config.database} as ${config.user}`);
  console.log(`  Config   ${ENV_FILE} (UTC offset ${config.tzOffsetHours}h)`);
  console.log("  Sign in  admin / admin (mock login)");
  console.log("  Bound to 127.0.0.1 only. Press Ctrl+C to stop.");
}

main().catch(async (error) => {
  console.error(`[local] Startup failed: ${error.message}`);
  if (error.code === "EADDRINUSE") {
    console.error("[local] That port is already in use. Choose another PORT in .env and retry.");
  }
  await stopServer().catch(() => {});
  process.exitCode = 1;
});
