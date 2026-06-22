/**
 * JARVIS — preflight doctor.
 *
 * One command to verify the whole chain before (or after) you add real keys:
 *   npm run doctor
 *
 * Checks config, then live connectivity to Anthropic, ElevenLabs, and Firestore
 * (via the projects MCP). Each check runs independently and reports ✓/✗ — a
 * failure never hides the others. Exits non-zero if any required check fails.
 *
 * No mock data: every "live" check makes a real request and reports the real
 * result. With placeholder keys you'll see real auth failures — that's correct.
 */

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync, statSync } from "node:fs";
import { loadMcpTools } from "./mcp-bridge.js";
import { resolveMode } from "./mode.js";

const MODEL = process.env.JARVIS_MODEL ?? "claude-sonnet-4-6";

type Result = { ok: boolean; detail: string; required: boolean };
const results: Array<{ name: string } & Result> = [];

async function check(name: string, required: boolean, fn: () => Promise<string> | string) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, required });
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message, required });
  }
}

function need(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`not set`);
  return v;
}

async function main() {
  // Resolve mode FIRST — it decides which credentials are actually required.
  const mode = await resolveMode();
  results.push({ name: "mode", ok: true, detail: `${mode} (JARVIS_MODE=${process.env.JARVIS_MODE ?? "auto"})`, required: false });

  // --- config common to both modes ---
  await check("env: JARVIS_WORKDIR exists", true, () => {
    const dir = need("JARVIS_WORKDIR");
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
    return dir;
  });
  await check("config: PROJECTS_SA_KEY", false, () => {
    const p = process.env.PROJECTS_SA_KEY;
    if (!p) throw new Error("not set (Firestore tools will fail until you add it)");
    if (!existsSync(p)) throw new Error(`file not found: ${p}`);
    JSON.parse(readFileSync(p, "utf8")); // throws if not valid JSON
    return "valid service-account JSON";
  });

  // --- which providers are actually active (override > mode default) ---
  const brain = process.env.JARVIS_BRAIN?.toLowerCase() ?? (mode === "offline" ? "ollama" : "claude");
  const tts = process.env.JARVIS_TTS?.toLowerCase() ?? (mode === "offline" ? "piper" : "elevenlabs");
  results.push({ name: "providers", ok: true, detail: `brain=${brain}, tts=${tts}`, required: false });

  // --- brain check ---
  if (brain === "claude") {
    await check("live: Anthropic API", true, async () => {
      const anthropic = new Anthropic({ apiKey: need("ANTHROPIC_API_KEY") });
      await anthropic.messages.create({ model: MODEL, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
      return `reachable (${MODEL})`;
    });
  } else if (brain === "gemini") {
    await check("live: Gemini API", true, async () => {
      const model = process.env.JARVIS_GEMINI_MODEL ?? "gemini-2.0-flash";
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${need("GEMINI_API_KEY")}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] }) },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      return `reachable (${model})`;
    });
  } else if (brain === "ollama") {
    const ollamaHost = (process.env.JARVIS_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    const ollamaModel = process.env.JARVIS_OLLAMA_MODEL ?? "qwen2.5";
    const ollamaKey = process.env.OLLAMA_API_KEY || process.env.JARVIS_OLLAMA_API_KEY;
    await check("live: Ollama + model", true, async () => {
      const res = await fetch(`${ollamaHost}/api/tags`, {
        headers: ollamaKey ? { Authorization: `Bearer ${ollamaKey}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${ollamaHost}`);
      const names = (((await res.json()) as { models?: Array<{ name: string }> }).models ?? []).map((m) => m.name);
      if (!names.some((n) => n === ollamaModel || n.startsWith(`${ollamaModel}:`))) {
        throw new Error(`model "${ollamaModel}" not pulled. Run: ollama pull ${ollamaModel}`);
      }
      return `${ollamaHost} has ${ollamaModel}`;
    });
  }

  // --- tts check ---
  if (tts === "elevenlabs") {
    await check("live: ElevenLabs key", true, async () => {
      const res = await fetch("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": need("ELEVENLABS_API_KEY") } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      return "key valid";
    });
    await check("live: ElevenLabs voice", true, async () => {
      const id = need("ELEVENLABS_VOICE_ID");
      const res = await fetch(`https://api.elevenlabs.io/v1/voices/${id}`, { headers: { "xi-api-key": need("ELEVENLABS_API_KEY") } });
      if (!res.ok) throw new Error(`voice ${id}: HTTP ${res.status}`);
      return `voice ${id} found`;
    });
  } else if (tts === "piper") {
    await check("offline TTS: Piper model", true, () => {
      const m = process.env.PIPER_MODEL;
      if (!m) throw new Error("PIPER_MODEL not set (path to a .onnx voice).");
      if (!existsSync(m)) throw new Error(`Piper model not found: ${m}`);
      return m;
    });
  } else if (tts === "say") {
    await check("TTS: macOS say", true, () => {
      if (process.platform !== "darwin") throw new Error("`say` is macOS-only.");
      return "built-in";
    });
  }

  // --- live: projects MCP + Firestore ---
  await check("projects MCP loads", true, async () => {
    const tools = await loadMcpTools([{
      name: "projects",
      command: "node",
      args: ["./mcp-servers/projects/dist/index.js"],
      env: { GOOGLE_APPLICATION_CREDENTIALS: process.env.PROJECTS_SA_KEY ?? "" },
    }]);
    const list = tools.find((t) => t.name.endsWith("list_projects"));
    if (!list) throw new Error("list_projects tool missing");
    const out = await list.run({});

    // If creds + a project exist, prove Firestore connectivity with a 1-day query.
    const firstId = /^-\s+(\S+)/m.exec(out)?.[1];
    if (process.env.PROJECTS_SA_KEY && firstId) {
      const analytics = tools.find((t) => t.name.endsWith("project_analytics"))!;
      await analytics.run({ projectId: firstId, days: 1 });
      return `Firestore reachable (queried "${firstId}")`;
    }
    return process.env.PROJECTS_SA_KEY
      ? "loaded (no projects registered yet)"
      : "loaded (Firestore not tested — PROJECTS_SA_KEY unset)";
  });

  // --- report ---
  console.log("\nJarvis preflight:\n");
  for (const r of results) {
    const mark = r.ok ? "✓" : r.required ? "✗" : "○";
    console.log(`  ${mark} ${r.name} — ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok && r.required);
  console.log(
    failed.length
      ? `\n${failed.length} required check(s) failed. Fix the ✗ items above.\n`
      : `\nAll required checks passed. Jarvis is ready.\n`,
  );
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
