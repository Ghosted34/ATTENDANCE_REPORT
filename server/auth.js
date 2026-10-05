import crypto from "crypto";

const tokens = new Set(); // in memory: users sign in on every launch
const MOCK = { username: "admin", password: "admin" };

/** Swap this body for the real login endpoint call later; keep the return shape (token or null). */
export async function login(username, password) {
  if (username !== MOCK.username || password !== MOCK.password) return null;
  const token = crypto.randomBytes(24).toString("hex");
  tokens.add(token);
  return token;
}

export function requireAuth(req, res, next) {
  const t = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (!tokens.has(t)) return res.status(401).json({ error: "Not signed in." });
  next();
}
