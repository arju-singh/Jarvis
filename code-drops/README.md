# Code Drops

Standalone, runnable, copy-paste-friendly mini-projects extracted from the Jarvis
build. Each folder has its own `package.json`, runs on its own, ships with a
README (what it is · setup · next action), and works **with zero API keys** —
then upgrades with one `.env` line.

| # | Drop | What it is | Runs with no keys |
|---|---|---|---|
| 1 | [**Jarvis Command Center**](./jarvis-command-center) | Real-time agent HUD + SSE event bus + pluggable brain | ✅ demo brain |
| 2 | [**Shared Memory / Second Brain**](./shared-memory-second-brain) | Persistent memory many agents share; relevance recall | ✅ keyword recall |
| 3 | [**Agent Skeleton**](./agent-skeleton) | Minimal tool-calling agent (REPL or library), MCP-ready | ✅ zero deps |
| 4 | [**SaaS Starter Kit**](./saas-starter-kit) | Auth + rate-limit + security + SSE building blocks | ✅ no crypto deps |

## They compose
```
            ┌──────────────────────────┐
            │  #1 Command Center (UI)  │   live HUD / event bus
            └────────────┬─────────────┘
                         │ /turn → agent.run()
            ┌────────────▼─────────────┐
            │   #3 Agent Skeleton      │   the tool-calling loop
            └────────────┬─────────────┘
                         │ memoryTools()
            ┌────────────▼─────────────┐
            │  #2 Second Brain (memory)│   shared, persistent recall
            └──────────────────────────┘
   #4 SaaS Starter Kit  →  wrap any of them with auth + rate-limit + SSE
```

## Each drop, same recipe
```bash
cd <drop-folder>
npm install
npm run dev    # (or: npm start)
```
Then read that folder's README for the "make it smart" key and next action.
