import mssql from "mssql";

/**
 * Shared database configuration for local and Electron modes.
 *
 * The single source of truth is one SQL Server connection string, for example
 *   Server=192.168.1.10,1433;Database=VIAC;User Id=reports;Password=…;TrustServerCertificate=true
 * It is split internally with mssql's own parser so the rest of the app (logs, settings window,
 * error dialogs) can name the server, database and user without ever touching the secret.
 */

const unquote = (value) => {
  const text = String(value ?? "").trim();
  const quoted = (text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"));
  return quoted ? text.slice(1, -1).trim() : text;
};

/**
 * Validates one connection string and splits it into the parts the app displays.
 * The password stays inside `connectionString`; there is deliberately no `password` field.
 */
export function normalizeDatabaseConfig(values = {}) {
  const connectionString = unquote(values.connectionString);
  if (!connectionString) throw new Error("Paste the database connection string.");
  if (!connectionString.includes("=") || !connectionString.includes(";")) {
    throw new Error(
      "That is not a connection string. Example: " +
      "Server=192.168.1.10,1433;Database=VIAC;User Id=reports;Password=…;TrustServerCertificate=true",
    );
  }

  let parsed;
  try {
    parsed = mssql.ConnectionPool.parseConnectionString(connectionString);
  } catch (error) {
    throw new Error(`Could not read the connection string: ${error.message}`);
  }

  const host = String(parsed.server ?? "").trim();
  const database = String(parsed.database ?? "").trim();
  const user = String(parsed.user ?? "").trim();
  const password = String(parsed.password ?? "");

  // "Database=;User Id=u" makes the parser fold the next key into the empty value; catch
  // that here so a typo is reported as a typo instead of as a missing field.
  const folded = [host, database, user].find((v) => /[;=]/.test(v));
  if (folded) {
    throw new Error(`The connection string has an empty value ("${folded}"). Check for ";;" or "Key=;" in it.`);
  }
  if (!host || !database) throw new Error("The connection string needs a Server and a Database.");
  if (!user || !password) {
    throw new Error("The connection string needs a User Id and a Password (SQL Server authentication).");
  }
  if (!Number.isInteger(Number(parsed.port ?? 1433)) || Number(parsed.port ?? 1433) < 1 || Number(parsed.port ?? 1433) > 65535) {
    throw new Error("Port must be 1–65535.");
  }

  const rawTz = values.tzOffsetHours;
  const tzOffsetHours = rawTz === undefined || rawTz === null || String(rawTz).trim() === "" ? 1 : Number(rawTz);
  if (!Number.isInteger(tzOffsetHours) || tzOffsetHours < -12 || tzOffsetHours > 14) {
    throw new Error("UTC offset must be a whole number of hours.");
  }

  return { connectionString, host, database, user, port: Number(parsed.port ?? 1433), tzOffsetHours };
}

/** "192.168.1.10,1433 — VIAC as reports": safe to log or show, never includes the secret. */
export const describeConnection = ({ host, port, database, user }) =>
  `${host},${port} — ${database} as ${user}`;

/** Splits "key=value;key=value" without breaking braced values such as Password={p;a}ss}. */
export function splitConnectionPairs(connectionString) {
  const pairs = [];
  let current = "";
  let inBraces = false;
  for (const char of String(connectionString ?? "")) {
    if (char === "{") inBraces = true;
    else if (char === "}") inBraces = false;
    if (char === ";" && !inBraces) {
      pairs.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) pairs.push(current);
  return pairs;
}

/** The connection string with the password hidden, for the settings window and logs. */
export function maskConnectionString(connectionString) {
  return splitConnectionPairs(connectionString)
    .map((pair) => {
      const index = pair.indexOf("=");
      const key = index < 0 ? pair : pair.slice(0, index);
      return /^\s*(password|pwd)\s*$/i.test(key) ? `${key}=••••` : pair;
    })
    .join(";");
}

/** Quotes a braced value if it contains a separator, as ADO.NET connection strings require. */
const quotedValue = (input) => {
  const text = String(input ?? "");
  return /[;{}"]/.test(text) ? `{${text.replace(/\}/g, "}}")}}` : text;
};

/** Builds a connection string from split fields (used to migrate the old settings format). */
export function connectionStringFrom({ host, port = 1433, database, user, password }) {
  return `Server=${quotedValue(host)},${quotedValue(port)};Database=${quotedValue(database)};` +
    `User Id=${quotedValue(user)};Password=${quotedValue(password)};TrustServerCertificate=True`;
}
