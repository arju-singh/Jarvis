/**
 * JARVIS — brain.
 *
 * Receives a transcript from the ears, runs a tool-calling loop, and speaks the
 * reply. The thinking + speaking layers are swappable by mode:
 *   online  → Claude + ElevenLabs
 *   offline → Ollama (Qwen 2.5) + Piper
 * Mode is chosen by JARVIS_MODE (online | offline | auto).
 *
 * Run:  npm run dev
 */

import express, { type Response } from "express";
import { join } from "node:path";
import { existsSync } from "node:fs";
import os from "node:os";
import { exec } from "node:child_process";

import type { Tool } from "./types.js";
import { desktopTools } from "./tools/desktop.js";
import { assistantTools } from "./tools/assistant.js";
import { computerTools } from "./tools/computer.js";
import { browserTools } from "./tools/browser.js";
import { gameTools } from "./tools/games.js";
import { visionTools } from "./tools/vision.js";
import { flightTools } from "./tools/flights.js";
import { memoryTools, memoryPreamble } from "./memory.js";
import { loadMcpTools, type McpServerSpec } from "./mcp-bridge.js";
import { resolveMode } from "./mode.js";
import { makeBrain, type Turn } from "./providers/brain.js";
import { makeTts, isSpeaking, stopSpeaking } from "./providers/tts.js";
import {
  rateLimit,
  securityHeaders,
  requireLoopbackHost,
  validateBody,
} from "./security.js";

const PORT = Number(process.env.JARVIS_PORT ?? 8787);

// Assistant identity — branded "Arju Jarvis" by default, overridable.
const ASSISTANT_NAME = process.env.JARVIS_NAME ?? "Arju Jarvis";

// Longest transcript we'll accept in one turn — guards the LLM + memory.
const MAX_TURN_CHARS = 8000;

// v4 — long-term memory, off unless explicitly enabled.
const MEMORY_ON = /^(1|true|on|yes)$/i.test(process.env.JARVIS_MEMORY ?? "");

const SYSTEM = `You are ${ASSISTANT_NAME}, ${process.env.JARVIS_USER ?? "the user"}'s sharp, efficient personal assistant. Calm, direct, professional. If asked your name, you are "${ASSISTANT_NAME}".

RULES:
- Always use the correct tool. Never simulate, guess, or invent results.
- Call each tool EXACTLY ONCE. Never retry a successful action.
- Don't narrate a quick action before doing it — just call the tool, then report the result briefly.
- Don't repeat yourself. Say something once and stop.
- Replies are SPOKEN aloud: keep them to 1-2 short sentences (no markdown, no lists, no code), unless reporting data.
- Never ask unnecessary questions — make a reasonable assumption and proceed.
- Save useful facts about the user with the memory tools for a better experience.
- Before any destructive shell command, state exactly what it will do, get a clear "yes", then run it via run_shell_confirmed.
- If a tool fails, say plainly what failed.

LANGUAGE:
- Reply in the same language the user spoke.
- Always extract tool parameters in English. Example: "İstanbul hava durumu?" → get_weather city:"Istanbul", reply in Turkish.

YOUR TOOLS (use only these; if there's no tool for a request, say so briefly):
- computer_settings — ONE single computer action: volume, brightness, wifi, screenshot, lock, display sleep, dark mode. Use this for any single computer control command.
- notify — show a desktop notification.
- browser_control — open URLs, web-search in the browser, read/close the current tab.
- game_updater — ANY Steam or Epic request (install/update/list/launch). Call this DIRECTLY; never web_search first.
- screen_process — look at what's on the screen and answer about it (read an error, describe the page).
- flight_finder — search real flights between two IATA codes on a date.
- open_app — open an app or file. run_shell / run_shell_confirmed — other shell commands (confirm destructive ones first).
- list_dir / read_file / write_file — files in the workspace.
- get_weather, web_search, get_datetime — look things up.
- remember / recall / forget — long-term memory about the user.
- projects__* — query/manage the user's own products (bookings/orders: list, analytics, register, update).
- pytools__* — extra abilities: ddg_search (keyless web search), web_scrape (read a page), youtube_transcript, clipboard_get/clipboard_set, type_text/press_hotkey (control keyboard), move_to_trash (delete a file safely), system_status (CPU/RAM/battery).
- shutdown_jarvis — stop the assistant. Call this ONLY when the user explicitly names Jarvis/the assistant, e.g. "shut down Jarvis", "stop the assistant". A bare "shut down" / "shutdown" means their COMPUTER, not you — never quit on that; treat it as a normal computer request (and never run a destructive shell command without confirmation). Casual goodbyes ("bye", "thanks") are NOT shutdown.`.trim();

/** System prompt, recomputed each turn so freshly-remembered facts apply immediately. */
function systemPrompt(): string {
  return MEMORY_ON ? SYSTEM + memoryPreamble() : SYSTEM;
}

async function main() {
  const mode = await resolveMode();
  const brain = makeBrain(mode);   // validates its own backend/credentials
  const tts = makeTts(mode);

  // Register your own product MCP servers here.
  // The generic `projects` server handles ALL your products via config
  // (mcp-servers/projects/projects.config.json) — add a project there or via
  // the register_project tool, no new server needed.
  const mcpServers: McpServerSpec[] = [
    {
      name: "projects",
      command: "node",
      args: ["./mcp-servers/projects/dist/index.js"],
      env: { GOOGLE_APPLICATION_CREDENTIALS: process.env.PROJECTS_SA_KEY ?? "" },
    },
    // The standalone petsacre server, wired with its own service-account key.
    {
      name: "petsacre",
      command: "node",
      args: ["./mcp-servers/petsacre/dist/index.js"],
      env: { GOOGLE_APPLICATION_CREDENTIALS: process.env.PETSACRE_SA_KEY ?? "" },
    },
  ];

  // Python tools (ddg search, scrape, youtube transcript, clipboard, input,
  // system status) — only if the venv exists, so a fresh clone still boots.
  const pyPython = join(process.cwd(), ".venv/bin/python");
  if (existsSync(pyPython)) {
    mcpServers.push({
      name: "pytools",
      command: pyPython,
      args: [join(process.cwd(), "mcp-servers/pytools/server.py")],
    });
  }

  const mcpTools = mcpServers.length ? await loadMcpTools(mcpServers) : [];
  const tools: Tool[] = [
    ...desktopTools,
    ...assistantTools,
    ...computerTools,
    ...browserTools,
    ...gameTools,
    ...visionTools,
    ...flightTools,
    ...(MEMORY_ON ? memoryTools : []),
    ...mcpTools,
  ];
  console.log(
    `[brain] mode=${mode} (${brain.name} + ${tts.name}) | memory ${MEMORY_ON ? "ON" : "off"} | ` +
      `${tools.length} tools:`,
    tools.map((t) => t.name).join(", "),
  );

  // Neutral cross-turn history shared by whichever brain provider is active.
  const history: Turn[] = [];

  const app = express();
  app.disable("x-powered-by");          // don't advertise Express
  app.set("trust proxy", false);        // we bind loopback; trust the real socket IP

  // ── security middleware (applied to every request) ──────────────
  app.use(securityHeaders);
  app.use(requireLoopbackHost);         // Host allow-list — anti DNS-rebinding
  // Generous global limiter (the ears poll /speaking during playback).
  app.use(rateLimit({ capacity: 240, refillPerSec: 8 }));
  // Small JSON bodies only — caps payload size (OWASP: limit request size).
  app.use(express.json({ limit: "32kb" }));

  // Browser dashboard at http://127.0.0.1:PORT/
  app.use(express.static(join(process.cwd(), "public")));
  // Silence Chrome DevTools' background probe so it doesn't log as a 404.
  app.get(/^\/\.well-known\//, (_req, res) => res.status(204).end());

  // ── live event stream (SSE) — pushes voice/brain state to the dashboard ──
  const sseClients = new Set<Response>();
  const broadcast = (event: Record<string, unknown>) => {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  };
  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ type: "hello", name: ASSISTANT_NAME })}\n\n`);
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* client gone; cleaned up on close */
      }
    }, 25_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });
  // The ears push UI state here — e.g. "listening" the instant you clap.
  app.post(
    "/event",
    validateBody({
      type: { type: "string", required: true, maxLen: 32, trim: true },
      via: { type: "string", maxLen: 32, trim: true },
    }),
    (req, res) => {
      broadcast({ type: req.body.type, via: req.body.via });
      res.json({ ok: true });
    },
  );

  // Stricter limiter + strict schema for the expensive LLM turn endpoint.
  const turnLimiter = rateLimit({ capacity: 12, refillPerSec: 0.5 }); // ~30/min
  app.post(
    "/turn",
    turnLimiter,
    validateBody({ text: { type: "string", required: true, trim: true, maxLen: MAX_TURN_CHARS } }),
    async (req, res) => {
      const text = req.body.text as string;
      // Push the question + a "thinking" state to the dashboard right away.
      broadcast({ type: "user", text });
      broadcast({ type: "thinking" });
      try {
        const reply = await brain.reply(text, history, tools, systemPrompt());
        history.push({ role: "user", text }, { role: "assistant", text: reply });
        broadcast({ type: "reply", text: reply });
        broadcast({ type: "speaking" });
        // Non-blocking: start speaking, return text right away so the ears can
        // monitor for barge-in while playback happens.
        tts.speak(reply).catch((err) => console.error("[tts]", err));
        res.json({ reply });
      } catch (err) {
        // Log full detail server-side; return a generic message to the client.
        console.error(err);
        broadcast({ type: "error", text: "Something went wrong handling that." });
        res.status(500).json({ error: "Internal error handling the turn." });
      }
    },
  );

  // ── live system stats for the dashboard ────────────────────────
  // CPU% is computed as the busy fraction since the previous /stats call.
  const cpuSnapshot = () => {
    let idle = 0, total = 0;
    for (const c of os.cpus()) {
      for (const t of Object.values(c.times)) total += t;
      idle += c.times.idle;
    }
    return { idle, total };
  };
  let prevCpu = cpuSnapshot();
  const cpuPct = () => {
    const cur = cpuSnapshot();
    const idle = cur.idle - prevCpu.idle, total = cur.total - prevCpu.total;
    prevCpu = cur;
    return total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
  };
  // Battery via `pmset`, cached 15s so we don't spawn it on every poll.
  let battCache: { pct: number | null; at: number } = { pct: null, at: 0 };
  const battery = () =>
    new Promise<number | null>((resolve) => {
      if (Date.now() - battCache.at < 15_000) return resolve(battCache.pct);
      exec("pmset -g batt", { timeout: 2000 }, (err, out) => {
        const m = err ? null : /(\d+)%/.exec(out);
        battCache = { pct: m ? Number(m[1]) : null, at: Date.now() };
        resolve(battCache.pct);
      });
    });
  app.get("/stats", async (_req, res) => {
    res.json({
      cpu: cpuPct(),
      mem: Math.round(100 * (1 - os.freemem() / os.totalmem())),
      battery: await battery(),
    });
  });

  // Barge-in support for the always-on ears.
  app.get("/speaking", (_req, res) => res.json({ speaking: isSpeaking() }));
  app.post("/stop", (_req, res) => {
    stopSpeaking();
    res.json({ stopped: true });
  });

  app.listen(PORT, "127.0.0.1", () =>
    console.log(`[brain] listening on http://127.0.0.1:${PORT}/turn`),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
