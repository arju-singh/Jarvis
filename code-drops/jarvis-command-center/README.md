# Jarvis Agent Command Center

A real-time **AI agent command center** — a holographic web HUD wired to a tiny brain
server over a **Server-Sent-Events bus**. Type or speak, watch it think and respond
live, with a reactive core, themes, and live system stats.

It runs **with zero API keys** (a built-in demo brain), then upgrades to any real LLM
by pasting one key into `.env`. The UI, server, and brain are fully decoupled, so a
voice pipeline, a CLI, or the web form all drive the same live screen.

![states: idle · listening · thinking · speaking](./public/index.html)

---

## Quick start

```bash
npm install
npm run dev
# → open http://localhost:3005/
```

That's it — no key required. Try the command chips, switch **themes** (top-right dots),
or type "weather in Tokyo".

## Make it smart (optional, ~1 min)

The demo brain only knows time + weather. To make it fully conversational, drop in a
free **OpenAI-compatible** key (Groq is fast and free):

```bash
cp .env.example .env
```
```ini
LLM_API_KEY=gsk_your_groq_key          # console.groq.com  (free)
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.3-70b-versatile
```

Restart. The same `LLM_*` vars also work for **OpenRouter**, **OpenAI**, **Together**,
or a **local Ollama** (`LLM_BASE_URL=http://127.0.0.1:11434/v1`, no key). If the real
LLM ever errors (quota, network), it **automatically fails over** to the demo brain so
the UI never goes dark.

---

## What's inside

| File | Role |
|---|---|
| `server.ts` | Express brain: `/turn` (tool-loop), SSE `/events`, `/event`, `/stats`, `/speaking`, `/stop` |
| `providers.ts` | Pluggable brain: **DemoBrain** + **OpenAIBrain** + automatic **failover** |
| `public/index.html` | The HUD — reactive core, audio visualizer, themes, history, shortcuts (no build step, no external deps) |

### The event bus (the key pattern)
Everything the UI shows comes from one SSE stream, so any source can drive it:

```
POST /event {"type":"listening"}   ─┐
POST /turn  {"text":"..."}          ├─►  broadcast()  ──SSE──►  the HUD
(your voice pipeline / CLI / cron) ─┘     user→thinking→reply→speaking
```

Point a voice "ears" process (or anything) at `POST /event` and `POST /turn`, and the
dashboard lights up in real time — clap-to-listen, live transcript, spoken reply.

### Add a tool (30 seconds)
In `server.ts`, append to the `tools` array:

```ts
{
  name: "get_news",
  description: "Latest headlines.",
  parameters: { type: "object", properties: { topic: { type: "string" } } },
  run: async ({ topic }) => `…fetch headlines for ${topic}…`,
}
```
It's instantly available to any LLM brain via the tool-calling loop.

---

## Keyboard shortcuts
`/` focus input · `Space` talk (browser mic) · `Esc` stop speaking · `F` fullscreen

## Endpoints
`GET /` HUD · `GET /events` SSE · `POST /event` push UI state · `POST /turn` one turn ·
`GET /stats` cpu/ram/uptime · `GET /speaking` · `POST /stop`

## Config (all optional — see `.env.example`)
`AGENT_NAME` · `PORT` · `TTS` (`say`/`off`) · `LLM_API_KEY` · `LLM_BASE_URL` · `LLM_MODEL`

---

### Next action
1. `npm install && npm run dev` → open the HUD.
2. Paste a free Groq key into `.env` to make it conversational.
3. Add one tool of your own, or wire a voice pipeline to `/event` + `/turn`.
