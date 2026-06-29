/**
 * Jarvis Command Center — server.
 *
 * A tiny, dependency-light brain that powers the real-time HUD:
 *   • POST /turn      — run one user turn through the brain (tool-loop) + broadcast
 *   • GET  /events    — Server-Sent Events stream the dashboard subscribes to
 *   • POST /event     — external pushers (e.g. a voice "ears" process) set UI state
 *   • GET  /stats      — live CPU / RAM / uptime + active brain
 *   • GET  /speaking   — is audio playing? (barge-in)   • POST /stop — cut it off
 *
 * The dashboard and the brain are decoupled by the SSE event bus, so a voice
 * pipeline, a CLI, or the web form all drive the same live UI.
 *
 * Run:  npm install && npm run dev   →   http://localhost:3005/
 */
import express, { type Response } from "express";
import { join } from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { makeBrain, type Tool, type ChatMessage } from "./providers.js";

const PORT = Number(process.env.PORT ?? 3005);
const NAME = process.env.AGENT_NAME ?? "JARVIS";

const SYSTEM = `You are ${NAME}, a sharp, efficient assistant. Be brief and direct.
Use a tool when one fits; never invent tool results. Replies are short (1-2 sentences).`;

// ── example tools (add your own here) ───────────────────────────────────────
const tools: Tool[] = [
  {
    name: "get_time",
    description: "Get the current date and time.",
    parameters: { type: "object", properties: {} },
    run: async () =>
      new Date().toLocaleString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }),
  },
  {
    name: "get_weather",
    description: "Get the current weather for a city (no API key — uses Open-Meteo).",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    run: async ({ city }: { city: string }) => {
      const g: any = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`).then((r) => r.json());
      const loc = g.results?.[0];
      if (!loc) return `Couldn't find "${city}".`;
      const w: any = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,wind_speed_10m`).then((r) => r.json());
      const c = w.current;
      return `${loc.name}: ${c.temperature_2m}°C, wind ${c.wind_speed_10m} km/h.`;
    },
  },
];

// ── optional spoken replies (macOS `say`; "off" elsewhere) ──────────────────
const TTS = (process.env.TTS ?? (process.platform === "darwin" ? "say" : "off")).toLowerCase();
let player: ChildProcess | null = null;
const isSpeaking = () => player !== null;
const stopSpeaking = () => { if (player) { player.kill("SIGKILL"); player = null; } };
function speak(text: string): void {
  if (TTS !== "say" || !text.trim()) return;
  stopSpeaking();
  player = spawn("say", [text], { stdio: "ignore" });
  player.on("exit", () => { player = null; });
}

async function main() {
  const brain = makeBrain();
  const history: ChatMessage[] = [];
  console.log(`[brain] ${brain.name} | ${tools.length} tools | TTS=${TTS}`);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  app.use(express.static(join(process.cwd(), "public")));

  // ── SSE event bus ──
  const clients = new Set<Response>();
  const broadcast = (event: Record<string, unknown>) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of clients) { try { c.write(payload); } catch { clients.delete(c); } }
  };
  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: "hello", name: NAME })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
  });
  // External processes (e.g. a voice pipeline) push UI state here.
  app.post("/event", (req, res) => {
    const { type, ...rest } = req.body ?? {};
    if (typeof type === "string") broadcast({ type, ...rest });
    res.json({ ok: true });
  });

  // ── one conversation turn ──
  app.post("/turn", async (req, res) => {
    const text = String(req.body?.text ?? "").slice(0, 8000).trim();
    if (!text) return res.status(400).json({ error: "text required" });
    broadcast({ type: "user", text });
    broadcast({ type: "thinking" });
    try {
      const reply = await brain.reply(text, history, tools, SYSTEM);
      history.push({ role: "user", content: text }, { role: "assistant", content: reply });
      if (history.length > 40) history.splice(0, history.length - 40);
      broadcast({ type: "reply", text: reply });
      broadcast({ type: "speaking" });
      speak(reply);
      res.json({ reply });
    } catch (err) {
      console.error(err);
      broadcast({ type: "error", text: "Something went wrong handling that." });
      res.status(500).json({ error: "Internal error." });
    }
  });

  // ── live stats ──
  const snap = () => { let idle = 0, total = 0; for (const c of os.cpus()) { for (const t of Object.values(c.times)) total += t; idle += c.times.idle; } return { idle, total }; };
  let prev = snap();
  app.get("/stats", (_req, res) => {
    const cur = snap();
    const idle = cur.idle - prev.idle, total = cur.total - prev.total; prev = cur;
    res.json({
      cpu: total > 0 ? Math.round(100 * (1 - idle / total)) : 0,
      mem: Math.round(100 * (1 - os.freemem() / os.totalmem())),
      uptime: Math.floor(process.uptime()),
      brain: brain.name,
      tts: TTS,
    });
  });

  app.get("/speaking", (_req, res) => res.json({ speaking: isSpeaking() }));
  app.post("/stop", (_req, res) => { stopSpeaking(); res.json({ stopped: true }); });

  app.listen(PORT, () => console.log(`[${NAME}] command center → http://localhost:${PORT}/`));
}

main().catch((err) => { console.error(err); process.exit(1); });
