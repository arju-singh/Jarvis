/**
 * Pluggable LLM "brain" with automatic failover.
 *
 *   DemoBrain    — no API key, works offline. Lets the UI run instantly.
 *   OpenAIBrain  — any OpenAI-compatible endpoint (OpenAI / Groq / OpenRouter /
 *                  Together / local Ollama). Full tool-calling loop.
 *   makeBrain()  — builds a failover chain: real provider first (if a key is set),
 *                  demo as the safety net. On error it falls to the next.
 *
 * Swap or add providers without touching server.ts.
 */

/** A capability the agent can call. `parameters` is a JSON Schema object. */
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (args: any) => Promise<string>;
}

/** Neutral conversation turn shared across providers. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Brain {
  readonly name: string;
  reply(userText: string, history: ChatMessage[], tools: Tool[], system: string): Promise<string>;
}

const MAX_TOOL_ITERS = 6;

// ── Demo brain: zero-config, so the command center runs out of the box ──────
class DemoBrain implements Brain {
  readonly name = "demo";

  async reply(userText: string, _history: ChatMessage[], tools: Tool[], _system: string): Promise<string> {
    const text = userText.toLowerCase();
    const call = async (name: string, args: any) => {
      const tool = tools.find((t) => t.name === name);
      return tool ? tool.run(args) : "";
    };
    if (/\b(time|date|day|clock)\b/.test(text)) return call("get_time", {});
    if (/\bweather|temperature|forecast\b/.test(text)) {
      const m = /(?:in|for|at)\s+([a-z\s]+)$/i.exec(userText.trim());
      const city = (m ? m[1] : "London").trim();
      return call("get_weather", { city });
    }
    if (/what can you do|help|capabilit/.test(text)) {
      return "I'm the demo brain — I can tell the time and the weather, and the whole command-center UI works. Add an LLM key in .env (Groq is free) to make me fully conversational.";
    }
    return `Demo brain here (no LLM key set). You said: "${userText}". Add LLM_API_KEY in .env to upgrade me.`;
  }
}

// ── OpenAI-compatible brain: OpenAI / Groq / OpenRouter / Ollama / etc. ──────
class OpenAIBrain implements Brain {
  readonly name: string;
  constructor(
    private baseURL: string,
    private apiKey: string,
    private model: string,
  ) {
    this.name = `llm(${model})`;
  }

  async reply(userText: string, history: ChatMessage[], tools: Tool[], system: string): Promise<string> {
    const messages: any[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: userText },
    ];
    const toolDefs = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));

    for (let i = 0; i < MAX_TOOL_ITERS; i++) {
      const res = await fetch(`${this.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, messages, tools: toolDefs.length ? toolDefs : undefined }),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data: any = await res.json();
      const msg = data.choices?.[0]?.message;
      if (!msg) throw new Error("LLM returned no message.");
      messages.push(msg);

      if (!msg.tool_calls?.length) return (msg.content ?? "").trim();

      for (const call of msg.tool_calls) {
        const tool = tools.find((t) => t.name === call.function?.name);
        let result: string;
        try {
          const args = JSON.parse(call.function?.arguments || "{}");
          result = tool ? await tool.run(args) : `ERROR: unknown tool ${call.function?.name}`;
        } catch (err) {
          result = `ERROR: ${(err as Error).message}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }
    throw new Error(`Tool loop exceeded ${MAX_TOOL_ITERS} iterations.`);
  }
}

// ── Failover wrapper ────────────────────────────────────────────────────────
class FailoverBrain implements Brain {
  readonly name: string;
  constructor(private providers: Brain[]) {
    this.name = `failover(${providers.map((p) => p.name).join("→")})`;
  }
  async reply(userText: string, history: ChatMessage[], tools: Tool[], system: string): Promise<string> {
    const errors: string[] = [];
    for (let i = 0; i < this.providers.length; i++) {
      try {
        const out = await this.providers[i].reply(userText, history, tools, system);
        if (i > 0) console.error(`[brain] recovered via "${this.providers[i].name}"`);
        return out;
      } catch (err) {
        errors.push(`${this.providers[i].name}: ${(err as Error).message}`);
        const next = this.providers[i + 1];
        console.error(`[brain] "${this.providers[i].name}" failed` + (next ? ` — falling back to "${next.name}"` : ""));
      }
    }
    throw new Error(`All brains failed:\n  ${errors.join("\n  ")}`);
  }
}

export function makeBrain(): Brain {
  const key = process.env.LLM_API_KEY;
  const base = process.env.LLM_BASE_URL;
  const model = process.env.LLM_MODEL;
  const chain: Brain[] = [];
  // A real LLM is the primary when configured (Ollama needs no key, just a base URL).
  if (base && model) chain.push(new OpenAIBrain(base, key ?? "", model));
  chain.push(new DemoBrain()); // always-available safety net
  return chain.length === 1 ? chain[0] : new FailoverBrain(chain);
}
