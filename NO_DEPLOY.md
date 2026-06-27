# NO_DEPLOY

**Do not deploy this project to serverless platforms (Vercel, Netlify, Cloudflare
Workers, AWS Lambda, etc.) or wire it to Neon/serverless Postgres.** This is a
**local, machine-controlling desktop assistant**, not a stateless web app.

## Why it can't go serverless

| What Jarvis needs | Serverless reality |
|---|---|
| Long-running process holding in-memory `history` (conversation state) | Functions are stateless and die after each request |
| Spawns child processes — MCP servers (Node + Python FastMCP) over stdio | No persistent child processes allowed |
| **Controls the local machine** — screenshots, `afplay`/`say`, keyboard/mouse, app launch | No "your machine" exists in a cloud sandbox |
| Voice pipeline + PyTorch / Whisper / Piper, mic & speaker hardware | No audio devices, no heavy ML runtime |
| PyQt6 desktop GUI (`main.py`) | A GUI app cannot run on a server |
| Tool loops that may run minutes | 10–60s execution cap |

## Why NOT Neon

The data layer is **Firestore** (`pets-3c1d5`) + a local JSON memory file
(`jarvis-memory.json`). There is **no Postgres** anywhere. Neon is only relevant
if the data layer is rewritten — which is unnecessary. **Keep Firestore.**

## How to actually run / "deploy" it

### Full assistant (controls the computer it runs on)
It is NOT a cloud deploy — it is a **service install on the target machine**:
- macOS: `launchd` agent · Linux: `systemd` service
- or wrap as a **Tauri / Electron** app
- optionally run 24/7 on a **Mac mini / mini-PC / Raspberry Pi** ("Jarvis box")

The device-control + voice + PyQt parts MUST run where the user physically is.

### Hosted chat-brain only (drop local-control tools)
If hosting just `server.ts` + Firestore tools, use a **persistent container host**,
never serverless:
- **Railway** or **Render** — easiest (persistent Node + Python, child procs ok)
- **Fly.io** — containers, always-on
- **DigitalOcean / Hetzner VPS** — full control, cheapest at scale
- **Google Cloud Run** — pairs naturally with Firestore

Database stays **Firestore** (already wired). Use Neon/Supabase only if you
deliberately migrate to Postgres.

---
_See `ARCHITECTURE.md` for the full system diagram._
