/**
 * Brain providers — the "thinking" layer, swappable by mode.
 *
 *   online  → ClaudeBrain  (Anthropic, best tool-calling)
 *   offline → OllamaBrain  (local Qwen 2.5 via Ollama, no internet)
 *
 * Both run the same tool-calling loop and share a neutral conversation history
 * (plain user/assistant text turns), so the active provider can change between
 * turns without losing context. Credentials/reachability are validated inside
 * each provider — offline mode needs no cloud keys, online needs no Ollama.
 *
 * No fallbacks: a provider that can't reach its backend throws a clear error.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "../types.js";
import type { Mode } from "../mode.js";

/** Neutral cross-turn history shared by all providers. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface BrainProvider {
  readonly name: string;
  /** Run one user turn through a tool-calling loop; return the spoken reply text. */
  reply(userText: string, history: Turn[], tools: Tool[], system: string): Promise<string>;
}

const MAX_TOOL_ITERS = 8; // guard against runaway tool loops

async function runTool(tools: Tool[], name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { text: `ERROR: unknown tool "${name}"`, isError: true };
  try {
    return { text: await tool.run(input), isError: false };
  } catch (err) {
    return { text: `ERROR: ${(err as Error).message}`, isError: true }; // surfaced, never hidden
  }
}

// --- Claude (online) ------------------------------------------------------

class ClaudeBrain implements BrainProvider {
  readonly name = "claude";
  private client: Anthropic;
  private model: string;

  constructor() {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("Online brain needs ANTHROPIC_API_KEY.");
    this.client = new Anthropic({ apiKey: key });
    this.model = process.env.JARVIS_MODEL ?? "claude-sonnet-4-6";
  }

  async reply(userText: string, history: Turn[], tools: Tool[], system: string): Promise<string> {
    const messages: Anthropic.MessageParam[] = history.map((t) => ({ role: t.role, content: t.text }));
    messages.push({ role: "user", content: userText });
    const toolDefs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    for (let i = 0; i < MAX_TOOL_ITERS; i++) {
      const resp = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system,
        tools: toolDefs,
        messages,
      });
      messages.push({ role: "assistant", content: resp.content });

      if (resp.stop_reason !== "tool_use") {
        return resp.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type !== "tool_use") continue;
        const { text, isError } = await runTool(tools, block.name, block.input);
        results.push({ type: "tool_result", tool_use_id: block.id, content: text, is_error: isError });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error(`Claude tool loop exceeded ${MAX_TOOL_ITERS} iterations.`);
  }
}

// --- Ollama / Qwen 2.5 (offline) ------------------------------------------

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}
interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

class OllamaBrain implements BrainProvider {
  readonly name = "ollama";
  private host: string;
  private model: string;
  private apiKey?: string;

  constructor() {
    this.host = (process.env.JARVIS_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.model = process.env.JARVIS_OLLAMA_MODEL ?? "qwen2.5";
    // Set for Ollama Cloud (https://ollama.com); leave unset for a local daemon.
    this.apiKey = process.env.OLLAMA_API_KEY || process.env.JARVIS_OLLAMA_API_KEY;
  }

  private async chat(messages: OllamaMessage[], tools: Tool[]): Promise<OllamaMessage> {
    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          })),
          stream: false,
        }),
      });
    } catch (err) {
      throw new Error(
        `Cannot reach Ollama at ${this.host}: ${(err as Error).message}. ` +
          `Is it running? (ollama serve, then 'ollama pull ${this.model}')`,
      );
    }
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { message?: OllamaMessage };
    if (!data.message) throw new Error("Ollama returned no message.");
    return data.message;
  }

  async reply(userText: string, history: Turn[], tools: Tool[], system: string): Promise<string> {
    const messages: OllamaMessage[] = [
      { role: "system", content: system },
      ...history.map((t) => ({ role: t.role, content: t.text })),
      { role: "user", content: userText },
    ];

    for (let i = 0; i < MAX_TOOL_ITERS; i++) {
      const msg = await this.chat(messages, tools);
      messages.push(msg);
      if (!msg.tool_calls?.length) return (msg.content ?? "").trim();

      for (const call of msg.tool_calls) {
        const { text } = await runTool(tools, call.function.name, call.function.arguments);
        messages.push({ role: "tool", content: text });
      }
    }
    throw new Error(`Ollama tool loop exceeded ${MAX_TOOL_ITERS} iterations.`);
  }
}

// --- Gemini (online, free tier) -------------------------------------------

/** Convert our JSON Schema to Gemini's schema format (uppercase type enums). */
function toGeminiSchema(s: any): any {
  if (!s || typeof s !== "object") return undefined;
  const TYPES: Record<string, string> = {
    string: "STRING", number: "NUMBER", integer: "INTEGER",
    boolean: "BOOLEAN", array: "ARRAY", object: "OBJECT",
  };
  const out: any = {};
  if (s.type && TYPES[s.type]) out.type = TYPES[s.type];
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.type === "array" && s.items) out.items = toGeminiSchema(s.items);
  if (s.type === "object" && s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = toGeminiSchema(v);
    if (Array.isArray(s.required)) out.required = s.required;
  }
  return out;
}

class GeminiBrain implements BrainProvider {
  readonly name = "gemini";
  private key: string;
  private model: string;

  constructor() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Gemini brain needs GEMINI_API_KEY.");
    this.key = key;
    this.model = process.env.JARVIS_GEMINI_MODEL ?? "gemini-2.0-flash";
  }

  private declarations(tools: Tool[]) {
    return tools.map((t) => {
      const schema = t.input_schema as { properties?: Record<string, unknown> };
      const decl: Record<string, unknown> = { name: t.name, description: t.description };
      if (schema?.properties && Object.keys(schema.properties).length > 0) {
        decl.parameters = toGeminiSchema(schema);
      }
      return decl;
    });
  }

  async reply(userText: string, history: Turn[], tools: Tool[], system: string): Promise<string> {
    const contents: any[] = history.map((t) => ({
      role: t.role === "assistant" ? "model" : "user",
      parts: [{ text: t.text }],
    }));
    contents.push({ role: "user", parts: [{ text: userText }] });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    for (let i = 0; i < MAX_TOOL_ITERS; i++) {
      let res: Response;
      try {
        res = await fetch(`${url}?key=${this.key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents,
            tools: [{ functionDeclarations: this.declarations(tools) }],
          }),
        });
      } catch (err) {
        throw new Error(`Cannot reach Gemini: ${(err as Error).message}`);
      }
      if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);

      const data: any = await res.json();
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const calls = parts.filter((p: any) => p.functionCall);
      if (!calls.length) {
        return parts.filter((p: any) => typeof p.text === "string").map((p: any) => p.text).join(" ").trim();
      }

      contents.push({ role: "model", parts });
      const responseParts: any[] = [];
      for (const c of calls) {
        const { text } = await runTool(tools, c.functionCall.name, c.functionCall.args ?? {});
        responseParts.push({ functionResponse: { name: c.functionCall.name, response: { result: text } } });
      }
      contents.push({ role: "user", parts: responseParts });
    }
    throw new Error(`Gemini tool loop exceeded ${MAX_TOOL_ITERS} iterations.`);
  }
}

export function makeBrain(mode: Mode): BrainProvider {
  // Explicit provider override (e.g. JARVIS_BRAIN=gemini) takes precedence over mode.
  switch (process.env.JARVIS_BRAIN?.toLowerCase()) {
    case "gemini": return new GeminiBrain();
    case "claude": return new ClaudeBrain();
    case "ollama": return new OllamaBrain();
  }
  return mode === "offline" ? new OllamaBrain() : new ClaudeBrain();
}
