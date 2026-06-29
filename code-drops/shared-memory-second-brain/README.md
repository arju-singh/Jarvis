# Shared Memory — "Second Brain"

A persistent, searchable **memory any number of agents share**. One small HTTP
service: agents (and you) write facts to it and recall the relevant ones by
search. File-backed (no database). Recall ranks by relevance — **keyword scoring
with zero keys**, or **semantic embeddings** if you wire up an API.

Includes a browser to view/search/add/forget memories, and a drop-in client +
agent tools so any agent gains long-term memory in two lines.

---

## Quick start

```bash
npm install
npm run dev
# → open http://localhost:3008/   (view, search, add, delete memories)
```

No keys needed — recall works out of the box with keyword ranking.

## Give an agent shared memory (2 lines)

```ts
import { SecondBrain, memoryTools } from "./client.ts";

const brain = new SecondBrain("http://localhost:3008", "my-agent");
await brain.remember("User prefers metric units", { tags: ["preference"], importance: 4 });
const hits = await brain.recall("what units does the user like?"); // → relevant facts
```

Drop `memoryTools(brain)` into the **Jarvis Command Center** drop's `tools` array
and that agent can now `remember` + `recall` on its own. Point a *second* agent at
the same URL and they **share one brain** — what one learns, the other recalls.

## Inject memory into a prompt

```ts
const system = BASE_PROMPT + "\n\n" + await brain.preamble(); // top facts, ranked by importance
```

---

## Semantic recall (optional)

Keyword recall is solid for exact-ish matches. For meaning-based recall ("their
app" → finds "building a SaaS"), set an OpenAI-compatible embeddings endpoint in
`.env`:

```ini
EMBED_BASE_URL=https://api.openai.com/v1
EMBED_MODEL=text-embedding-3-small
EMBED_API_KEY=sk-...
# or local, no key:  EMBED_BASE_URL=http://127.0.0.1:11434/v1  EMBED_MODEL=nomic-embed-text
```

Embeddings are computed on `remember` and cosine-ranked on `recall`. Restart and
re-add memories so they get vectors.

---

## What's inside

| File | Role |
|---|---|
| `memory.ts` | `MemoryStore` — add / search / preamble / delete; keyword + optional embeddings; JSON-file backed |
| `server.ts` | HTTP service: `/remember`, `/recall`, `/memories`, `/preamble`, `/stats`, serves the UI |
| `client.ts` | `SecondBrain` client + `memoryTools()` for agents (matches the Command Center Tool shape) |
| `public/index.html` | Browser to view, search, add, and forget memories |

## API

| Method | Route | |
|---|---|---|
| POST | `/remember` | `{text, tags?, type?, source?, importance?}` |
| GET | `/recall?q=&limit=` | relevance-ranked hits |
| GET | `/memories` | all, newest first |
| DELETE | `/memories/:id` | forget one |
| GET | `/preamble?limit=` | compact block for prompt injection |
| POST | `/clear` | wipe (guard with `CLEAR_TOKEN`) |
| GET | `/stats` | count + recall mode |

A memory: `{ id, text, tags[], type, source, importance(1–5), createdAt }`.

---

### Next action
1. `npm install && npm run dev` → add a few memories in the browser.
2. Wire `memoryTools()` into an agent (e.g. the Command Center drop).
3. Optionally add `EMBED_*` for semantic recall, and point a second agent at the
   same URL to see them share one brain.
