/**
 * rate-limit — in-memory token-bucket limiter (per IP by default). No deps.
 * Returns 429 + Retry-After when the bucket is empty. Idle buckets are reaped.
 *
 *   app.use(rateLimit({ capacity: 100, refillPerSec: 5 }));            // global
 *   app.post("/login", rateLimit({ capacity: 10, refillPerSec: 0.1 })); // strict
 */
import type { Request, Response, NextFunction } from "express";

export interface RateLimitOptions {
  capacity: number; // max burst
  refillPerSec: number; // sustained rate once the burst is spent
  keyBy?: (req: Request) => string; // default: client IP
}

export function rateLimit(opts: RateLimitOptions) {
  const buckets = new Map<string, { tokens: number; updated: number }>();
  const idleMs = 60 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [k, b] of buckets) if (b.updated < cutoff) buckets.delete(k);
  }, idleMs).unref?.();

  const keyOf = opts.keyBy ?? ((req: Request) => req.ip ?? req.socket.remoteAddress ?? "unknown");

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyOf(req);
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: opts.capacity, updated: now }; buckets.set(key, b); }
    b.tokens = Math.min(opts.capacity, b.tokens + ((now - b.updated) / 1000) * opts.refillPerSec);
    b.updated = now;
    if (b.tokens >= 1) { b.tokens -= 1; return next(); }
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((1 - b.tokens) / opts.refillPerSec))));
    res.status(429).json({ error: "Too many requests — slow down." });
  };
}
