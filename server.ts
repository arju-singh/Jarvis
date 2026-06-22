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

import express from "express";

import type { Tool } from "./types.js";
import { desktopTools } from "./tools/desktop.js";
import { assistantTools } from "./tools/assistant.js";
import { memoryTools, memoryPreamble } from "./memory.js";
import { loadMcpTools, type McpServerSpec } from "./mcp-bridge.js";
import { resolveMode } from "./mode.js";
import { makeBrain, type Turn } from "./providers/brain.js";
import { makeTts, isSpeaking, stopSpeaking } from "./providers/tts.js";

const PORT = Number(process.env.JARVIS_PORT ?? 8787);

// v4 — long-term memory, off unless explicitly enabled.
const MEMORY_ON = /^(1|true|on|yes)$/i.test(process.env.JARVIS_MEMORY ?? "");

const SYSTEM = `You are Jarvis, ${process.env.JARVIS_USER ?? "the user"}'s personal voice assistant.
Your replies are SPOKEN aloud, so keep them short, natural and conversational — no markdown, no lists, no code blocks. You may answer in Hinglish if the user speaks that way.
You can control the desktop, manage assistant tasks, and operate the user's own products through tools.
Before any destructive shell command, state exactly what it will do and ask the user to confirm out loud; only run it via run_shell_confirmed after they say yes.
If a tool fails, tell the user plainly what failed. Never invent results.`.trim();

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
    // The standalone petsacre server still works if you prefer it:
    // { name: "petsacre", command: "node", args: ["./mcp-servers/petsacre/dist/index.js"],
    //   env: { GOOGLE_APPLICATION_CREDENTIALS: process.env.PETSACRE_SA_KEY ?? "" } },
  ];

  const mcpTools = mcpServers.length ? await loadMcpTools(mcpServers) : [];
  const tools: Tool[] = [
    ...desktopTools,
    ...assistantTools,
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
  app.use(express.json());

  app.post("/turn", async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) {
      res.status(400).json({ error: "Field 'text' is required." });
      return;
    }
    try {
      const reply = await brain.reply(text, history, tools, systemPrompt());
      history.push({ role: "user", text }, { role: "assistant", text: reply });
      // Non-blocking: start speaking, return text right away so the ears can
      // monitor for barge-in while playback happens.
      tts.speak(reply).catch((err) => console.error("[tts]", err));
      res.json({ reply });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: (err as Error).message });
    }
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
