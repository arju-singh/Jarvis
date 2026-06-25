/**
 * security — dependency-free hardening middleware for the Jarvis brain server.
 *
 * OWASP-aligned for a localhost single-user service:
 *   • rateLimit          — in-memory token-bucket limiter, per client IP, 429 + Retry-After.
 *   • securityHeaders     — nosniff / frame-deny / referrer / CSP.
 *   • requireLoopbackHost — Host-header allow-list (anti DNS-rebinding).
 *   • validateBody        — strict allow-list schema: type, length, required,
 *                           and rejection of unexpected fields (no mass-assignment).
 *
 * All in-memory, no new packages — keeps a fresh clone booting unchanged.
 */
import type { Request, Response, NextFunction } from "express";

// ── token-bucket rate limiter ─────────────────────────────────────
interface Bucket {
  tokens: number;
  updated: number;
}

export interface RateLimitOptions {
  /** max burst */
  capacity: number;
  /** sustained refills per second once the burst is spent */
  refillPerSec: number;
  /** label used in the 429 message */
  name?: string;
}

/** Build an express middleware that token-bucket rate-limits by client IP. */
export function rateLimit(opts: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  // Periodically drop idle buckets so memory can't grow unbounded.
  const idleMs = 60 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [k, b] of buckets) if (b.updated < cutoff) buckets.delete(k);
  }, idleMs).unref?.();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: opts.capacity, updated: now };
      buckets.set(key, b);
    }
    // Refill proportional to elapsed time, capped at capacity.
    const elapsedSec = (now - b.updated) / 1000;
    b.tokens = Math.min(opts.capacity, b.tokens + elapsedSec * opts.refillPerSec);
    b.updated = now;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      next();
      return;
    }
    const retryAfter = Math.max(1, Math.ceil((1 - b.tokens) / opts.refillPerSec));
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({ error: "Too many requests — slow down." });
  };
}

// ── security headers ──────────────────────────────────────────────
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  // The chat UI uses inline <style>/<script> and fetches the same origin.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
      "connect-src 'self'; img-src 'self' data:; media-src 'self' blob:",
  );
  next();
}

// ── Host allow-list (anti DNS-rebinding) ──────────────────────────
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function requireLoopbackHost(req: Request, res: Response, next: NextFunction) {
  const host = (req.headers.host ?? "").split(":")[0].trim().toLowerCase();
  if (!LOOPBACK.has(host)) {
    res.status(403).json({ error: "Forbidden host." });
    return;
  }
  next();
}

// ── strict body validation ────────────────────────────────────────
export interface FieldSpec {
  type: "string" | "number" | "boolean";
  required?: boolean;
  maxLen?: number; // strings
  min?: number; // numbers
  max?: number; // numbers
  trim?: boolean; // strings
}

export type Schema = Record<string, FieldSpec>;

export class ValidationError extends Error {}

/**
 * Validate & normalise `body` against `schema`. Rejects non-objects, unexpected
 * fields, wrong types, and over-length strings. Returns a clean object holding
 * only declared fields.
 */
export function validate(body: unknown, schema: Schema): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("body must be a JSON object");
  }
  const obj = body as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!(key in schema)) throw new ValidationError(`unexpected field: ${key}`);
  }

  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(schema)) {
    const present = obj[name] !== undefined && obj[name] !== null;
    if (!present) {
      if (spec.required) throw new ValidationError(`missing required field: ${name}`);
      continue;
    }
    let val = obj[name];

    if (spec.type === "string") {
      if (typeof val !== "string") throw new ValidationError(`${name} must be a string`);
      if (spec.trim) val = val.trim();
      if ((val as string).length === 0 && spec.required) {
        throw new ValidationError(`${name} must not be empty`);
      }
      if (spec.maxLen !== undefined && (val as string).length > spec.maxLen) {
        throw new ValidationError(`${name} exceeds max length ${spec.maxLen}`);
      }
    } else if (spec.type === "number") {
      if (typeof val !== "number" || Number.isNaN(val)) {
        throw new ValidationError(`${name} must be a number`);
      }
      if (spec.min !== undefined && val < spec.min) throw new ValidationError(`${name} too small`);
      if (spec.max !== undefined && val > spec.max) throw new ValidationError(`${name} too large`);
    } else if (spec.type === "boolean") {
      if (typeof val !== "boolean") throw new ValidationError(`${name} must be a boolean`);
    }

    out[name] = val;
  }
  return out;
}

/** Validation middleware factory: validates req.body, replaces it with the clean object. */
export function validateBody(schema: Schema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = validate(req.body, schema);
      next();
    } catch (err) {
      res.status(422).json({ error: `Invalid input: ${(err as Error).message}` });
    }
  };
}
