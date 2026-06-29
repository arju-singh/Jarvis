/**
 * Second Brain — drop-in client + agent tools.
 *
 * Point any agent at a running Second Brain service and it gains shared,
 * persistent memory. The exported `memoryTools` match the Tool shape used by
 * the Jarvis Command Center drop — paste them into that agent's `tools` array
 * and it can remember + recall across sessions AND across other agents hitting
 * the same brain.
 *
 *   const brain = new SecondBrain("http://localhost:3008", "command-center");
 *   await brain.remember("User prefers metric units");
 *   await brain.recall("what units does the user like?");
 */
export class SecondBrain {
  constructor(
    private baseURL = process.env.MEMORY_URL ?? "http://localhost:3008",
    private source = "agent",
  ) {
    this.baseURL = this.baseURL.replace(/\/$/, "");
  }

  async remember(text: string, opts: { tags?: string[]; type?: string; importance?: number } = {}) {
    const res = await fetch(`${this.baseURL}/remember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...opts, text, source: this.source }),
    });
    if (!res.ok) throw new Error(`remember failed: ${res.status}`);
    return (await res.json()).memory;
  }

  async recall(query: string, limit = 5): Promise<{ text: string; score: number }[]> {
    const res = await fetch(`${this.baseURL}/recall?q=${encodeURIComponent(query)}&limit=${limit}`);
    if (!res.ok) throw new Error(`recall failed: ${res.status}`);
    return (await res.json()).hits;
  }

  async preamble(limit = 12): Promise<string> {
    const res = await fetch(`${this.baseURL}/preamble?limit=${limit}`);
    return res.ok ? (await res.json()).preamble : "";
  }
}

/** Agent tools — compatible with the Jarvis Command Center `tools` array. */
export function memoryTools(brain = new SecondBrain()) {
  return [
    {
      name: "remember",
      description: "Save a durable fact about the user/world to shared long-term memory.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "The fact, in one sentence." },
          tags: { type: "array", items: { type: "string" } },
          importance: { type: "number", description: "1–5" },
        },
        required: ["text"],
      },
      run: async (a: { text: string; tags?: string[]; importance?: number }) => {
        const m = await brain.remember(a.text, { tags: a.tags, importance: a.importance });
        return `Remembered (#${m.id}).`;
      },
    },
    {
      name: "recall",
      description: "Search shared long-term memory for relevant facts before answering.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" }, limit: { type: "number" } },
        required: ["query"],
      },
      run: async (a: { query: string; limit?: number }) => {
        const hits = await brain.recall(a.query, a.limit ?? 5);
        return hits.length ? hits.map((h) => `- ${h.text}`).join("\n") : "No relevant memories.";
      },
    },
  ];
}
