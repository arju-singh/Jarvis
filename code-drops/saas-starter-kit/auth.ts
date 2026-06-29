/**
 * auth — password hashing, signed tokens, a user store, brute-force lockout,
 * and an Express guard. Zero dependencies (Node's built-in crypto).
 *
 *   • hashPassword / verifyPassword — scrypt + per-password salt, timing-safe.
 *   • signToken / verifyToken       — compact JWT-like HMAC-SHA256 tokens with exp.
 *   • UserStore                     — file-backed signup/login (swap for your DB).
 *   • LoginLimiter                  — lock an identity after N failed logins.
 *   • requireAuth(secret)           — middleware; sets req.user from a Bearer token.
 *
 * For production: serve over HTTPS, set a strong persistent AUTH_SECRET, and
 * replace the JSON UserStore with a real database.
 */
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Request, Response, NextFunction } from "express";

// ── password hashing (scrypt) ───────────────────────────────────────────────
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const test = scryptSync(password, salt, 64);
  const orig = Buffer.from(hash, "hex");
  return test.length === orig.length && timingSafeEqual(test, orig);
}

// ── signed tokens (HMAC-SHA256, JWT-ish) ────────────────────────────────────
const b64 = (s: string) => Buffer.from(s).toString("base64url");
export function signToken(payload: Record<string, unknown>, secret: string, ttlSec = 3600): string {
  const body = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function verifyToken(token: string, secret: string): Record<string, any> | null {
  const [body, sig] = (token || "").split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ── user store (file-backed; swap for a DB) ─────────────────────────────────
export interface User { username: string; passwordHash: string; createdAt: string; }
export class UserStore {
  private users = new Map<string, User>();
  constructor(private file = process.env.USERS_FILE ?? "./users.json") {
    if (existsSync(file)) for (const u of JSON.parse(readFileSync(file, "utf8"))) this.users.set(u.username, u);
  }
  private persist() {
    mkdirSync(dirname(this.file) || ".", { recursive: true });
    writeFileSync(this.file, JSON.stringify([...this.users.values()], null, 2) + "\n");
  }
  create(username: string, password: string): User {
    username = username.trim().toLowerCase();
    if (username.length < 3) throw new Error("username must be 3+ characters");
    if (password.length < 8) throw new Error("password must be 8+ characters");
    if (this.users.has(username)) throw new Error("username is taken");
    const user: User = { username, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    this.users.set(username, user); this.persist();
    return user;
  }
  verify(username: string, password: string): User | null {
    const u = this.users.get(username.trim().toLowerCase());
    return u && verifyPassword(password, u.passwordHash) ? u : null;
  }
}

// ── brute-force lockout ─────────────────────────────────────────────────────
export class LoginLimiter {
  private fails = new Map<string, { count: number; until: number }>();
  constructor(private maxFails = 5, private windowMs = 15 * 60 * 1000) {}
  /** Seconds remaining if locked, else 0. */
  lockedFor(key: string): number {
    const e = this.fails.get(key);
    return e && e.until > Date.now() ? Math.ceil((e.until - Date.now()) / 1000) : 0;
  }
  fail(key: string): void {
    const e = this.fails.get(key) ?? { count: 0, until: 0 };
    e.count++;
    if (e.count >= this.maxFails) e.until = Date.now() + this.windowMs;
    this.fails.set(key, e);
  }
  reset(key: string): void { this.fails.delete(key); }
}

// ── route guard ─────────────────────────────────────────────────────────────
export function requireAuth(secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const h = req.headers.authorization;
    const token = h?.startsWith("Bearer ") ? h.slice(7) : null;
    const payload = token ? verifyToken(token, secret) : null;
    if (!payload) return res.status(401).json({ error: "unauthorized" });
    (req as any).user = payload;
    next();
  };
}
