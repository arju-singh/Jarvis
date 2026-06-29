# Agent Skeleton

A **minimal, zero-dependency tool-calling AI agent** — the clean core you fork to
build your own. Run it as a terminal REPL or import it as a library. The hard part
(a correct multi-step tool loop) is done; you just add tools and pick a model.

- **Zero runtime dependencies** — just Node 18+.
- **Runs with no API keys** (built-in demo brain), upgrades to any OpenAI-compatible LLM.
- **Provider-swappable** with automatic failover.
- **MCP-ready** — load tools from MCP servers when you want them.

---

## Quick start

```bash
npm install
npm start
```
```
Agent ready — brain: demo, tools: get_time, get_weather, calculator, http_get
you › weather in Paris
  ↳ get_weather({"city":"Paris"})
agent › Paris: 18.6°C, wind 9.2 km/h.
you › what is (3+4)*5?
agent › 35
you › exit
```

No keys needed. Add a free **Groq** key in `.env` to make it fully conversational:

```ini
LLM_API_KEY=gsk_...                       # console.groq.com (free)
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_MODEL=llama-3.3-70b-versatile
```
(Also works with OpenAI, OpenRouter, Together, or local Ollama — same `LLM_*` vars.)

## Use as a library

```ts
import { Agent, makeBrain, defaultTools } from "./index.ts";

const agent = new Agent({ brain: makeBrain(), tools: defaultTools });
console.log(await agent.run("weather in Tokyo"));
```

## Add a tool (the whole point)

```ts
import { Agent, makeBrain } from "./index.ts";
import type { Tool } from "./tools.ts";

const flipCoin: Tool = {
  name: "flip_coin",
  description: "Flip a coin.",
  parameters: { type: "object", properties: {} },
  run: async () => (Math.random() < 0.5 ? "heads" : "tails"),
};

const agent = new Agent({ brain: makeBrain(), tools: [flipCoin] });
```

That tool is now available to any LLM through the loop — no other wiring.

---

## What's inside

| File | Role |
|---|---|
| `agent.ts` | **The loop** — user → brain → run tool calls → feed results back → answer. With `events` hooks for full observability. |
| `providers.ts` | Swappable brain: DemoBrain + OpenAIBrain + failover. Each does one chat round. |
| `tools.ts` | `Tool` type + examples (time, weather, calculator, http_get). |
| `mcp.ts` | Optional MCP tool loader (`npm i @modelcontextprotocol/sdk` to enable). |
| `cli.ts` | Terminal REPL. |
| `index.ts` | Library exports. |

## Observability
The `events` hooks let you watch the agent reason:
```ts
new Agent({ brain, tools, events: {
  onToolCall: (name, args) => log(name, args),
  onToolResult: (name, out) => log(out),
}});
```

## MCP tools (optional)
```bash
npm i @modelcontextprotocol/sdk
MCP_SERVERS='[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}]' npm start
```
Each MCP tool appears as `<server>__<tool>` in the same `tools` array.

## Fits the rest of the stack
- Give it **memory** → add `memoryTools()` from the **Shared Memory / Second Brain** drop.
- Give it a **face** → point the **Jarvis Command Center** drop's `/turn` at an `agent.run()`.

---

### Next action
1. `npm install && npm start` → chat with it.
2. Add one tool of your own (copy the `flip_coin` example).
3. Drop in a free Groq key, or wire it to the Memory + Command Center drops.
