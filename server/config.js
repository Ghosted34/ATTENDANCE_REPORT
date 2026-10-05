/** Shared database configuration validation for local and Electron modes. */
export function normalizeDatabaseConfig(values = {}) {
  const config = {
    host: String(values.host ?? "").trim(),
    port: Number(values.port),
    user: String(values.user ?? "").trim(),
    // Do not trim a password: whitespace can be part of a valid credential.
    password: String(values.password ?? ""),
    database: String(values.database ?? "").trim(),
    tzOffsetHours: Number(values.tzOffsetHours),
  };

  if (!config.host || !config.user || !config.database || !config.password.trim()) {
    throw new Error("Fill in every field.");
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error("Port must be 1–65535.");
  }
  if (!Number.isInteger(config.tzOffsetHours) || config.tzOffsetHours < -12 || config.tzOffsetHours > 14) {
    throw new Error("UTC offset must be a whole number of hours.");
  }

  return config;
}
