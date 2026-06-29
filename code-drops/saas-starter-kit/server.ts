/**
 * SaaS Starter Kit — demo server.
 *
 * Wires every building block into a runnable mini-app:
 *   • POST /api/signup, /api/login  — auth (scrypt + signed token + lockout)
 *   • GET  /api/me                  — protected route (requireAuth)
 *   • GET  /api/events              — live SSE feed
 *   • POST /api/broadcast           — push a message to all clients (auth'd)
 *   • global rate limiting + strict per-route limit on /login
 *   • security headers + body validation
 *
 * Run:  npm install && npm run dev   →   http://localhost:3009/
 */
import express from "express";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { UserStore, LoginLimiter, signToken, requireAuth } from "./auth.js";
import { rateLimit } from "./rate-limit.js";
import { securityHeaders, validateBody } from "./security.js";
import { SSEHub } from "./sse.js";

const PORT = Number(process.env.PORT ?? 3009);
const AUTH_SECRET = process.env.AUTH_SECRET ?? randomBytes(32).toString("hex");
if (!process.env.AUTH_SECRET)
  console.warn("[auth] AUTH_SECRET not set — using an ephemeral secret (sessions reset on restart). Set AUTH_SECRET in .env.");

const users = new UserStore();
const lockout = new LoginLimiter(5, 15 * 60 * 1000); // 5 tries → 15 min lock
const hub = new SSEHub();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);
app.use(securityHeaders());
app.use(rateLimit({ capacity: 120, refillPerSec: 4 })); // generous global limit
app.use(express.json({ limit: "16kb" }));
app.use(express.static(join(process.cwd(), "public")));

const credSchema = { username: { type: "string", required: true, trim: true, maxLen: 40 }, password: { type: "string", required: true, maxLen: 200 } } as const;

app.post("/api/signup", validateBody(credSchema as any), (req, res) => {
  try {
    const u = users.create(req.body.username, req.body.password);
    res.json({ token: signToken({ sub: u.username }, AUTH_SECRET, 3600), username: u.username });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Strict limiter + brute-force lockout on login.
app.post("/api/login", rateLimit({ capacity: 10, refillPerSec: 0.1 }), validateBody(credSchema as any), (req, res) => {
  const { username, password } = req.body as { username: string; password: string };
  const key = `${username.toLowerCase()}|${req.ip}`;
  const wait = lockout.lockedFor(key);
  if (wait) return res.status(429).json({ error: `Too many attempts — locked for ${wait}s.` });
  const u = users.verify(username, password);
  if (!u) { lockout.fail(key); return res.status(401).json({ error: "invalid credentials" }); }
  lockout.reset(key);
  res.json({ token: signToken({ sub: u.username }, AUTH_SECRET, 3600), username: u.username });
});

app.get("/api/me", requireAuth(AUTH_SECRET), (req, res) => res.json({ username: (req as any).user.sub }));

app.get("/api/events", hub.handler);
app.post("/api/broadcast", requireAuth(AUTH_SECRET), validateBody({ text: { type: "string", required: true, trim: true, maxLen: 500 } } as any), (req, res) => {
  hub.broadcast({ type: "message", user: (req as any).user.sub, text: req.body.text, at: new Date().toISOString() });
  res.json({ ok: true, clients: hub.size });
});

app.listen(PORT, () => console.log(`[saas-kit] → http://localhost:${PORT}/  (auth + rate-limit + SSE demo)`));
