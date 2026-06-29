/**
 * LLM providers — each does ONE chat round and returns the assistant message
 * plus any parsed tool calls. The multi-step loop lives in agent.ts, so the
 * brain stays a thin, swappable layer.
 *
 *   DemoBrain    — no key, rule-based; lets the agent run instantly.
 *   OpenAIBrain  — any OpenAI-compatible API (OpenAI / Groq / OpenRouter / Ollama).
 *   makeBrain()  — real provider first (if configured), demo as failover.
 */
import type { ToolDef } from "./tools.js";

export interface ParsedCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export interface BrainResult {
  message: any; // raw assistant message, appended to history verbatim
  content: string;
  calls: ParsedCall[];
}
export interface Brain {
  readonly name: string;
  chat(messages: any[], tools: ToolDef[]): Promise<BrainResult>;
}

function safeJSON(s: string): Record<string, unknown> {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}
const toOpenAITool = (t: ToolDef) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } });

// ── Demo brain: zero-config, so the skeleton runs out of the box ────────────
class DemoBrain implements Brain {
  readonly name = "demo";
  async chat(messages: any[], tools: ToolDef[]): Promise<BrainResult> {
    const last = messages[messages.length - 1];
    // After a tool ran, summarise its result as the answer.
    if (last?.role === "tool") {
      return { message: { role: "assistant", content: String(last.content) }, content: String(last.content), calls: [] };
    }
    const userText = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const t = String(userText).toLowerCase();
    const has = (n: string) => tools.some((td) => td.name === n);
    let want: [string, Record<string, unknown>] | null = null;
    if (/\b(time|date|day|clock)\b/.test(t) && has("get_time")) want = ["get_time", {}];
    else if (/\bweather|temperature|forecast\b/.test(t) && has("get_weather")) {
      const m = /(?:in|for|at)\s+([a-z\s]+)$/i.exec(String(userText).trim());
      want = ["get_weather", { city: (m ? m[1] : "London").trim() }];
    } else if (/[-+*/]\s*\d/.test(t) && has("calculator")) {
      const expr = String(userText).replace(/[^-+*/().\d\s]/g, "").trim(); // pull just the math
      if (/\d/.test(expr) && /[-+*/]/.test(expr)) want = ["calculator", { expression: expr }];
    }

    if (want) {
      const id = "demo-" + Math.round(performance.now());
      return {
        message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: want[0], arguments: JSON.stringify(want[1]) } }] },
        content: "",
        calls: [{ id, name: want[0], args: want[1] }],
      };
    }
    const reply = /what can you|help|capabilit/.test(t)
      ? "Demo brain here — I can call tools (time, weather, calculator). Set LLM_API_KEY in .env to make me fully conversational."
      : `Demo brain (no LLM key). You said: "${userText}". Add LLM_API_KEY to upgrade me.`;
    return { message: { role: "assistant", content: reply }, content: reply, calls: [] };
  }
}

// ── OpenAI-compatible brain ─────────────────────────────────────────────────
class OpenAIBrain implements Brain {
  readonly name: string;
  constructor(private baseURL: string, private apiKey: string, private model: string) {
    this.name = `llm(${model})`;
  }
  async chat(messages: any[], tools: ToolDef[]): Promise<BrainResult> {
    const res = await fetch(`${this.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, messages, tools: tools.length ? tools.map(toOpenAITool) : undefined }),
    });
    if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data: any = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error("LLM returned no message.");
    const calls: ParsedCall[] = (msg.tool_calls ?? []).map((tc: any) => ({ id: tc.id, name: tc.function?.name, args: safeJSON(tc.function?.arguments) }));
    return { message: msg, content: msg.content ?? "", calls };
  }
}

// ── failover ────────────────────────────────────────────────────────────────
class FailoverBrain implements Brain {
  readonly name: string;
  constructor(private providers: Brain[]) { this.name = `failover(${providers.map((p) => p.name).join("→")})`; }
  async chat(messages: any[], tools: ToolDef[]): Promise<BrainResult> {
    const errors: string[] = [];
    for (let i = 0; i < this.providers.length; i++) {
      try { return await this.providers[i].chat(messages, tools); }
      catch (err) { errors.push(`${this.providers[i].name}: ${(err as Error).message}`); console.error(`[brain] "${this.providers[i].name}" failed — falling back`); }
    }
    throw new Error(`All brains failed: ${errors.join("; ")}`);
  }
}

export function makeBrain(): Brain {
  const key = process.env.LLM_API_KEY, base = process.env.LLM_BASE_URL, model = process.env.LLM_MODEL;
  const chain: Brain[] = [];
  if (base && model) chain.push(new OpenAIBrain(base, key ?? "", model));
  chain.push(new DemoBrain());
  return chain.length === 1 ? chain[0] : new FailoverBrain(chain);
}
