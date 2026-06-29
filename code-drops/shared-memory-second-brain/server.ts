/**
 * Second Brain — shared memory service.
 *
 * One HTTP store that any number of agents/processes write to and recall from:
 *   POST   /remember        {text, tags?, type?, source?, importance?}
 *   GET    /recall?q=&limit= → relevance-ranked hits
 *   GET    /memories         → all (newest first)
 *   DELETE /memories/:id     → forget one
 *   GET    /preamble?limit=  → compact block to inject into a prompt
 *   POST   /clear            → wipe (guarded by CLEAR_TOKEN if set)
 *   GET    /stats            → counts + mode
 *
 * Serves a browser at /  to view, search, add, and delete memories.
 *
 * Run:  npm install && npm run dev   →   http://localhost:3008/
 */
import express from "express";
import { join } from "node:path";
import { MemoryStore, embeddingsEnabled } from "./memory.js";

const PORT = Number(process.env.PORT ?? 3008);
const CLEAR_TOKEN = process.env.CLEAR_TOKEN; // optional guard for /clear

async function main() {
  const store = new MemoryStore();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));
  app.use(express.static(join(process.cwd(), "public")));

  app.post("/remember", async (req, res) => {
    try {
      const mem = await store.add({
        text: String(req.body?.text ?? ""),
        tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : undefined,
        type: req.body?.type ? String(req.body.type) : undefined,
        source: req.body?.source ? String(req.body.source) : undefined,
        importance: req.body?.importance != null ? Number(req.body.importance) : undefined,
      });
      res.json({ ok: true, memory: mem });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get("/recall", async (req, res) => {
    try {
      const hits = await store.search(String(req.query.q ?? ""), Number(req.query.limit ?? 5));
      res.json({ hits });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get("/memories", (_req, res) => res.json({ memories: store.all() }));

  app.delete("/memories/:id", (req, res) =>
    res.json({ ok: store.remove(req.params.id) }),
  );

  app.get("/preamble", (req, res) =>
    res.json({ preamble: store.preamble(Number(req.query.limit ?? 12)) }),
  );

  app.post("/clear", (req, res) => {
    if (CLEAR_TOKEN && req.headers["x-clear-token"] !== CLEAR_TOKEN) {
      return res.status(403).json({ error: "bad clear token" });
    }
    store.clear();
    res.json({ ok: true });
  });

  app.get("/stats", (_req, res) =>
    res.json({ count: store.all().length, mode: embeddingsEnabled ? "semantic" : "keyword" }),
  );

  app.listen(PORT, () =>
    console.log(`[second-brain] ${embeddingsEnabled ? "semantic" : "keyword"} recall → http://localhost:${PORT}/`),
  );
}

main().catch((err) => { console.error(err); process.exit(1); });
