/**
 * Second Brain — the memory store.
 *
 * A persistent, searchable memory any agent can write to and recall from.
 * File-backed JSON (no database to run). Recall ranks by relevance:
 *   • default  → keyword scoring (zero config, zero keys)
 *   • optional → semantic similarity, if you set EMBED_* for an embeddings API
 *
 * Each memory is structured (text + tags + type + source + importance), so a
 * shared brain stays organised across many agents.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface Memory {
  id: string;
  text: string;
  tags: string[];
  type: string; // fact | preference | task | note | reference | ...
  source: string; // which agent/user wrote it
  importance: number; // 1–5
  createdAt: string;
  embedding?: number[]; // only when embeddings are enabled
}
export interface SearchHit extends Memory {
  score: number;
}
export interface AddInput {
  text: string;
  tags?: string[];
  type?: string;
  source?: string;
  importance?: number;
}

const FILE = process.env.MEMORY_FILE ?? "./second-brain.json";
const EMBED_BASE = process.env.EMBED_BASE_URL?.replace(/\/$/, "");
const EMBED_MODEL = process.env.EMBED_MODEL;
const EMBED_KEY = process.env.EMBED_API_KEY ?? "";
export const embeddingsEnabled = Boolean(EMBED_BASE && EMBED_MODEL);

// ── text utilities (keyword search) ─────────────────────────────────────────
const STOP = new Set("a an and are as at be by for from has have i in is it its of on or that the to was were will with you your my me we our".split(" "));
function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));
}

async function embed(text: string): Promise<number[] | null> {
  if (!embeddingsEnabled) return null;
  const res = await fetch(`${EMBED_BASE}/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(EMBED_KEY ? { Authorization: `Bearer ${EMBED_KEY}` } : {}) },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Embeddings ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data: any = await res.json();
  return data.data?.[0]?.embedding ?? null;
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export class MemoryStore {
  private items: Memory[] = [];

  constructor(private file = FILE) {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(data)) throw new Error(`${file} is corrupt: expected a JSON array`);
      this.items = data;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file) || ".", { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.items, null, 2) + "\n", "utf8");
  }

  async add(input: AddInput): Promise<Memory> {
    const text = input.text.trim();
    if (!text) throw new Error("memory text is required");
    const mem: Memory = {
      id: randomUUID().slice(0, 8),
      text,
      tags: (input.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean),
      type: input.type ?? "fact",
      source: input.source ?? "unknown",
      importance: Math.min(5, Math.max(1, input.importance ?? 3)),
      createdAt: new Date().toISOString(),
    };
    const vec = await embed(text);
    if (vec) mem.embedding = vec;
    this.items.push(mem);
    this.persist();
    return mem;
  }

  /** Relevance-ranked recall. Semantic if embeddings are on, else keyword. */
  async search(query: string, limit = 5): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    let hits: SearchHit[];

    if (embeddingsEnabled) {
      const qv = await embed(q);
      hits = this.items
        .filter((m) => m.embedding)
        .map((m) => ({ ...m, score: qv ? cosine(qv, m.embedding!) : 0 }))
        .filter((h) => h.score > 0.15);
    } else {
      const qt = tokens(q);
      hits = this.items
        .map((m) => {
          const mt = new Set(tokens(m.text));
          const tagset = new Set(m.tags);
          let s = 0;
          for (const t of qt) { if (mt.has(t)) s += 1; if (tagset.has(t)) s += 2; }
          // light boosts for importance and recency
          s += (m.importance - 3) * 0.1;
          return { ...m, score: s };
        })
        .filter((h) => h.score > 0);
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  all(): Memory[] {
    return [...this.items].reverse(); // newest first
  }
  get(id: string): Memory | undefined {
    return this.items.find((m) => m.id === id);
  }
  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((m) => m.id !== id);
    if (this.items.length !== before) { this.persist(); return true; }
    return false;
  }
  clear(): void {
    this.items = [];
    this.persist();
  }

  /** Compact block of the most important memories, for injecting into a prompt. */
  preamble(limit = 12): string {
    if (!this.items.length) return "";
    const top = [...this.items]
      .sort((a, b) => b.importance - a.importance || b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return "Things you remember:\n" + top.map((m) => `- ${m.text}`).join("\n");
  }
}
