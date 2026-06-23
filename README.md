# Jarvis

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
```
# Jarvis
# Jarvis
