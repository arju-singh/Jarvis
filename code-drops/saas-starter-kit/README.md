# SaaS Starter Kit

Drop-in **building blocks for a small SaaS**, extracted and hardened from a real
app. Each module is standalone Express middleware with **no crypto dependencies**
(Node's built-in `crypto` does the work). Copy the file you need, or run the demo
to see them work together.

- **Auth** — scrypt password hashing, signed (HMAC) session tokens, brute-force lockout
- **Rate limiting** — token-bucket, per-IP, `429 + Retry-After`
- **Security** — headers + strict allow-list body validation
- **SSE hub** — live server→client push, no WebSockets

Only runtime dep: `express`.

---

## Quick start

```bash
npm install
npm run dev
# → open http://localhost:3009/   (sign up, then broadcast a live message)
```

Open a second tab to watch broadcasts sync in real time. Set a strong
`AUTH_SECRET` in `.env` so sessions survive restarts.

---

## The modules

### `auth.ts`
```ts
import { UserStore, LoginLimiter, signToken, requireAuth } from "./auth.js";

const users = new UserStore();              // file-backed; swap for your DB
const u = users.create("ada", "s3cretpw!"); // scrypt-hashed, never plaintext
const token = signToken({ sub: u.username }, SECRET, 3600);

app.get("/me", requireAuth(SECRET), (req, res) => res.json({ user: req.user }));
```
Passwords are scrypt + per-password salt, compared timing-safely. Tokens are
HMAC-signed with an `exp`; tampering or expiry → rejected. `LoginLimiter` locks an
identity after N failed logins.

### `rate-limit.ts`
```ts
app.use(rateLimit({ capacity: 120, refillPerSec: 4 }));               // global
app.post("/login", rateLimit({ capacity: 10, refillPerSec: 0.1 }));    // strict
```

### `security.ts`
```ts
app.use(securityHeaders({ csp: "default-src 'self'" }));
app.post("/signup", validateBody({
  username: { type: "string", required: true, trim: true, maxLen: 40 },
  password: { type: "string", required: true, maxLen: 200 },
}), handler); // rejects unexpected fields, wrong types, over-length
```

### `sse.ts`
```ts
const hub = new SSEHub();
app.get("/events", hub.handler);   // clients subscribe
hub.broadcast({ type: "ping" });   // push to everyone
```

---

## Demo endpoints (`server.ts`)
`POST /api/signup` · `POST /api/login` (rate-limited + lockout) · `GET /api/me`
(protected) · `GET /api/events` (SSE) · `POST /api/broadcast` (auth'd).

## Verified behaviour
- Signup issues a signed token; `/api/me` is 401 without it, 200 with it.
- Weak passwords rejected; unexpected body fields rejected.
- 5 wrong logins → 6th returns **429**, and the correct password stays locked.
- A tampered token → **401** (HMAC check).
- Auth'd broadcast reaches all SSE subscribers live.

## Before production
- Serve over **HTTPS**; set a long, persistent **`AUTH_SECRET`**.
- Replace the JSON `UserStore` with a real **database**.
- Consider refresh tokens / httpOnly cookies for browser sessions.

---

### Next action
1. `npm install && npm run dev` → sign up and broadcast.
2. Lift just the file you need (`auth.ts`, `rate-limit.ts`, …) into your app.
3. Swap the `UserStore` for your database and set `AUTH_SECRET`.
