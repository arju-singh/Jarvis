# Jarvis

> Most "AI agents" you see online are fancy UI with very little behind them —
> impressive for ten seconds, useless the moment you ask for real work.
>
> Mine is different. My **content agent** has been pulling footage, editing, and
> posting across platforms on its own, every day, for over a month. The month I
> pointed Jarvis at my app's marketing, the app grew about **3x**.
>
> That's the proof: a real system doing real work. And if you're willing to
> tinker, you can build one too.

A personal voice assistant that runs **online or fully offline.**

```
mic → wake word → VAD → Whisper          (Python — always offline)
        → HTTP localhost →
   brain tool-loop + MCP + TTS            (Node)
        online  → Claude   + ElevenLabs
        offline → Ollama   + Piper   (Qwen 2.5, no internet)
```

The ears just produce text. The brain does everything intelligent — thinks,
calls tools (desktop control, your MCP product servers), and speaks the reply.

## Modes

Set `JARVIS_MODE`:

| Mode | Brain | Voice | Needs internet? |
|---|---|---|---|
| `online` | Claude | ElevenLabs | yes |
| `offline` | Ollama (Qwen 2.5) | Piper | **no** |
| `auto` (default) | probes connectivity at boot, then picks | | — |

Hearing (wake word + Whisper STT) is offline in **every** mode. Cloud-only tools
(weather, web search, Firestore analytics) need internet; offline they fail loud
rather than faking data. Brain and TTS are behind interfaces, so the mode switch
is a one-line change — no rewrites.

**Offline setup:** see [setup-offline.md](setup-offline.md) for exact macOS steps
(Ollama + Qwen 2.5, Piper voice), then `npm run doctor` to verify.

## Files

| File               | What it is                                               |
|--------------------|---------------------------------------------------------|
| `server.ts`        | Brain: HTTP endpoint, wires mode → providers + tools    |
| `mode.ts`          | Resolves online / offline / auto                        |
| `providers/brain.ts`| Claude (online) + Ollama/Qwen (offline) tool-loops     |
| `providers/tts.ts` | ElevenLabs (online) + Piper (offline), with barge-in    |
| `tools/desktop.ts` | Desktop tools: shell, open app, file read/write         |
| `tools/assistant.ts`| Weather, web search, datetime                          |
| `memory.ts`        | v4 long-term memory (toggle `JARVIS_MEMORY=on`)         |
| `mcp-bridge.ts`    | Connects MCP servers (the `projects` server) as tools   |
| `preflight.ts`     | `npm run doctor` — mode-aware health checks             |
| `jarvis_ears.py`   | Ears: wake word + VAD + Whisper + barge-in (always-on)  |
| `jarvis_ptt.py`    | Ears: push-to-talk (press Enter)                        |

## Run

**0. One-time setup** — installs + builds the brain and both MCP servers:
```bash
./setup.sh                # then edit the .env it creates
```

**1. Brain** (terminal 1)
```bash
npm run doctor            # verify keys + Firestore + connectivity (do this first)
npm run dev               # → listening on http://127.0.0.1:8787/turn
```

`npm run doctor` checks every key and live service in one shot — run it whenever
something isn't working.

> **Startup error `ERR_MODULE_NOT_FOUND` for `@modelcontextprotocol/sdk` or
> `zod-to-json-schema`?** That's a corrupt npm install (incomplete extraction),
> not a code bug. Fix with a clean reinstall:
> `npm cache clean --force && rm -rf node_modules package-lock.json && npm install`

**2. Voice** (terminal 2) — needs `ffmpeg` for TTS playback (`brew install ffmpeg`)
```bash
pip install -r requirements.txt   # use Python 3.10+ (a venv is cleanest)
```

Two ways to talk — start with push-to-talk:

```bash
# v1 — push-to-talk (recommended first): press Enter to speak, Enter to stop
BRAIN_URL=http://127.0.0.1:8787/turn python jarvis_ptt.py

# always-on — say "Hey Jarvis", then your command
BRAIN_URL=http://127.0.0.1:8787/turn python jarvis_ears.py
```

First Whisper run downloads the model.

### Test the brain without a mic
```bash
curl -X POST http://127.0.0.1:8787/turn \
  -H 'Content-Type: application/json' \
  -d '{"text":"what files are in my workspace?"}'
```

## Roadmap

- **v0 — runs** ✅ scaffolding, brain boots, desktop tools live
- **v1 — talks** ✅ push-to-talk loop (`jarvis_ptt.py`)
- **v2 — acts** ✅ assistant tools (weather, search, datetime)
- **v2 — your products** ✅ generic projects MCP (list / analytics / register / write)
- **v3 — always-on** ✅ wake word (`jarvis_ears.py`) + barge-in*
- **v4 — remembers** ✅ long-term memory, toggle with `JARVIS_MEMORY=on`

\* Barge-in (interrupt-while-speaking) is implemented but needs real-audio
tuning — without echo cancellation, open speakers can self-trigger. Use a headset.

---

# 🤖 MARK XXXIX-OR — Python / Gemini-Live app

> 📺 **[Watch the full setup video on YouTube](https://youtu.be/ldvDNzwnM8k)**

A second, **standalone** assistant living in this repo: a real-time voice AI that can
hear, see, understand, and control your computer — on Windows, macOS, or Linux.
Local execution, zero subscriptions. It is independent of the Node brain above:
run it with **`python main.py`**. Real-time voice + tool-calling go through
**Gemini Live**, while heavier action modules (web search, memory, flight finder,
desktop control, and more) route their LLM calls through **OpenRouter** free-tier
models for a much higher effective request limit at no cost.

## ✨ Overview

MARK XXXIX-OR is the pinnacle of the Jarvis series, bridging the operating system
and human intent. Through natural dialogue it analyzes your screen, processes
uploaded documents, and executes complex workflows with an adaptive interface.

## 🚀 Capabilities

| Feature | Description |
|---|---|
| 🎙️ Real-time Voice | Ultra-low latency conversation in any language |
| 🖥️ System Control | Launch apps, manage files, execute terminal commands |
| 🧩 Autonomous Tasks | High-level planning for complex, multi-step goals |
| 👁️ Visual Awareness | Real-time screen processing and webcam vision |
| 🧠 Persistent Memory | Remembers your projects, preferences, and personal context |
| ⌨️ Hybrid Input | Switch between keyboard typing and voice commands |

## 🆕 What's New in XXXIX-OR

- 📂 **Advanced File Handling** — drop PDFs, source code, or images in to have them analyzed, summarized, or edited.
- 🎨 **Adaptive & Flexible UI** — resizable, responsive interface with transparency controls and customizable layouts.
- 🐧🍎 **Refined Cross-Platform Stability** — core system actions are consistent across Windows, macOS, and Linux (Windows-only modules load behind `try/except`).
- ⚡ **Optimized Core Engine** — faster tool-calling logic and response generation.
- 🔀 **OpenRouter Integration** — selected action modules route through OpenRouter's free models; Gemini Live continues to handle real-time voice and tool-calling.

## ⚡ Quick Start

```bash
# from the repo root
pip install -r requirements-mark.txt   # Mark app deps (NOT requirements.txt — that's the ears)
playwright install                     # browser engines for browse_web

# add your keys (see Requirements below)
cp config/api_keys.json.example config/api_keys.json
$EDITOR config/api_keys.json           # paste your Gemini + OpenRouter keys, set "os_system"

python main.py
```

Or run `python setup.py`, which installs the requirements, runs `playwright install`,
and creates `config/api_keys.json` from the example for you.

> ⚠️ **Installation note:** to keep the repo lightweight, some OS-specific deps are
> not bundled. On a `ModuleNotFoundError`, install the missing package with
> `pip install <module_name>`. Windows users also: `pip install comtypes pycaw pywinauto win10toast`.

## 📋 Requirements

| Requirement | Details |
|---|---|
| **OS** | Windows 10/11, macOS, or Linux |
| **Python** | 3.11 or 3.12 |
| **Microphone** | Required for voice interaction |
| **API keys** | Free Gemini key + free OpenRouter key, placed in `config/api_keys.json` |

`config/api_keys.json` is **git-ignored** (it holds secrets) — every checkout must
create its own from `config/api_keys.json.example`:

```json
{
  "gemini_api_key": "AIza...",
  "openrouter_api_key": "sk-or-...",
  "os_system": "mac"
}
```

- **Gemini** (free): https://aistudio.google.com/apikey
- **OpenRouter** (free): https://openrouter.ai/keys
- `os_system`: `"windows"` | `"mac"` | `"linux"` — drives the platform-specific control paths.

## 🎬 Content Agent (the autonomous marketer)

The system from the pitch above lives in [`actions/content_agent.py`](actions/content_agent.py).
It runs an end-to-end pipeline — **source → edit → caption → post → ledger** — and can
run itself on a daily schedule:

1. **Source** — picks the next unused clip from `content/clips/` (a JSON ledger tracks
   what's posted, so nothing repeats).
2. **Edit** — `ffmpeg` normalises it to a 1080×1920 ≤60s vertical short (needs
   `brew install ffmpeg` / `apt install ffmpeg`; without it, the source clip is posted as-is).
3. **Caption** — generates title + caption + hashtags via OpenRouter (`or_client`).
4. **Post** — real API uploads to **YouTube** (Data API v3), **Instagram** (Graph API Reels),
   and **X/Twitter** (chunked media + v2 tweet). Each adapter posts for real when its keys are
   set in `config/api_keys.json → content_agent`, and otherwise logs a clear **DRY-RUN**.
5. **Ledger** — records every run to `content/ledger.json` for auditing.

Drive it by voice ("post my latest clip", "schedule daily posting at 10am", "open the content
dashboard"), as an autonomous `agent_task`, from the **Jarvis HUD dashboard**, or from the shell
for cron / Windows Task Scheduler:

```bash
python -m actions.content_agent serve             # 🖥️  Jarvis HUD control panel → http://127.0.0.1:8799
python -m actions.content_agent auth youtube      # 🔑 one-command browser OAuth → saves tokens (also: twitter, instagram)
python -m actions.content_agent post              # run the pipeline once
python -m actions.content_agent post youtube,twitter
python -m actions.content_agent schedule          # blocking daily loop
python -m actions.content_agent status
```

### 🔑 Going live (DRY → LIVE)

Each platform shows a **DRY** badge until connected. Add the one-time app credentials you
create at the provider to `config/api_keys.json`, then run the bootstrap — it opens your
browser, captures the redirect on a loopback server, and writes the long-lived token back
(file auto-hardened to `0600`). Nothing is printed; see [`actions/content_auth.py`](actions/content_auth.py).

| Platform | You provide once | `auth` captures |
|---|---|---|
| **YouTube** | OAuth *Desktop* client → `client_id`, `client_secret` | `refresh_token` |
| **X/Twitter** | App with OAuth1 → `api_key`, `api_secret` | `access_token`, `access_secret` |
| **Instagram** | Short-lived user token + `app_secret` (+ `app_id`) | long-lived `access_token` (~60d) |

```bash
python -m actions.content_agent auth youtube      # → ✓ YouTube connected — posts upload for real
```

### 🖥️ The HUD

`python -m actions.content_agent serve` (or saying "open the content dashboard") launches a
Jarvis-style control panel — the same cyan-on-black HUD as the main UI — that drives the real
pipeline: live SOURCE→EDIT→CAPTION→POST→LEDGER flow, platform chips badged **LIVE/DRY** by
credential state, a **Post Next Clip** trigger, daily-schedule controls, the clip queue, recent
posts (color-coded OK / dry-run / failed), and a live telemetry log. Served by a stdlib HTTP
control server ([`actions/content_agent_server.py`](actions/content_agent_server.py)) — no extra deps.

In-process scheduling (`action: "schedule_daily"`) runs while Jarvis is on; for posting that
survives reboots, point cron / Task Scheduler at the `post` command above.

> **Instagram note:** the Graph API ingests Reels by URL, not file upload — set
> `content_agent.public_base_url` to a host that serves `content/edited/`, or IG stays in dry-run.

**Posting credentials** (all optional; missing ones just dry-run) go under the `content_agent`
block in `config/api_keys.json` — see `config/api_keys.json.example` for the full shape.

---

# 🔒 Security

Both HTTP surfaces bind to `127.0.0.1` only and are hardened per OWASP guidance for a
local single-user control plane. Shared, dependency-free security layers:
[`actions/security.py`](actions/security.py) (Python) and [`security.ts`](security.ts) (Node).

**Rate limiting** — every endpoint is token-bucket limited per client (IP + session token),
with graceful **429 + `Retry-After`**. Reads get generous headroom (the HUD polls ~40/min);
expensive writes are strict (content posting ~6/min, the LLM `/turn` ~30/min).

**Input validation & sanitization** — all request bodies are schema-validated: type checks,
length caps, value allow-lists (e.g. `platforms ⊆ {youtube,instagram,twitter}`, `time` must match
`HH:MM`), and **unexpected fields are rejected** (no mass-assignment). Bodies are size-capped
(**413** over limit); invalid input returns **422** with a clear reason.

**CSRF / origin protection (HUD)** — the content-agent server mints a random per-process token,
injects it into the served page, and requires it on every `/api` call. A malicious web page in
your browser cannot read that token, so it cannot forge posts/schedules. Reinforced by a **Host
header allow-list** (anti DNS-rebinding) and an **Origin/Referer** check on mutations.

**Brute-force lockout** — the session token is 256-bit, but guessing is also throttled directly:
failed-token attempts are counted **per IP** (the request limiter alone can't help here — each
wrong token is a different key), and **10 bad tokens within 60s triggers a 5-minute lockout**
(graceful 429 + `Retry-After`). A *valid* token always bypasses the lockout, so the real page is
never affected, and an engaged lockout runs its full duration regardless of other traffic.

**Secure key handling** — no secrets in source or sent to any client. Keys resolve **env-first,
then file**:

```bash
# preferred: environment variables (nothing on disk)
export GEMINI_API_KEY=AIza...
export OPENROUTER_API_KEY=sk-or-...
python main.py
```

If unset, they fall back to `config/api_keys.json`, which is **git-ignored** and auto-hardened to
`chmod 600`. All readers route through [`config.get_secret()`](config/__init__.py) — one audited path.

**Rotating a key:** mint a new one at the provider → update the env var (or `config/api_keys.json`)
→ restart → revoke the old key at the provider. Because keys live only in the environment or a
git-ignored 0600 file (never in git history or the client), exposure on rotation is minimal.

**Response hardening** — both servers send `X-Content-Type-Options: nosniff`, `X-Frame-Options:
DENY`, a strict `Content-Security-Policy`, and `no-store`; server errors return a generic message
(details stay in the server log).
