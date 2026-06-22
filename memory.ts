/**
 * v4 — long-term memory (toggleable).
 *
 * Off by default. Enable by setting JARVIS_MEMORY=on. When enabled, the brain:
 *   - injects remembered facts into the system prompt every turn, and
 *   - exposes remember / recall / forget tools.
 *
 * Storage is a local JSON file (JARVIS_MEMORY_FILE, default ./jarvis-memory.json)
 * — no extra credentials, so the toggle is frictionless. Real persistence, no
 * mock data: a corrupt file throws rather than silently resetting your memory.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Tool } from "./types.js";

const FILE = process.env.JARVIS_MEMORY_FILE ?? "./jarvis-memory.json";

export interface MemoryItem {
  id: string;
  text: string;
  createdAt: string;
}

function load(): MemoryItem[] {
  if (!existsSync(FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(FILE, "utf8"));
    if (!Array.isArray(data)) throw new Error("expected a JSON array");
    return data as MemoryItem[];
  } catch (err) {
    throw new Error(`Memory file ${FILE} is corrupt: ${(err as Error).message}`);
  }
}

function save(items: MemoryItem[]): void {
  writeFileSync(FILE, JSON.stringify(items, null, 2) + "\n", "utf8");
}

/** Facts to prepend to the system prompt. Empty string when nothing is stored. */
export function memoryPreamble(): string {
  const items = load();
  if (!items.length) return "";
  return (
    "\n\nLong-term memory — things you know about the user and should use:\n" +
    items.map((m) => `- ${m.text}`).join("\n")
  );
}

export const memoryTools: Tool[] = [
  {
    name: "remember",
    description:
      "Save a durable fact about the user for future conversations (preferences, names, " +
      "important dates, recurring context). Use when the user shares something worth keeping.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "The fact to remember, in one sentence." } },
      required: ["text"],
    },
    run: async ({ text }: { text: string }) => {
      const fact = String(text ?? "").trim();
      if (!fact) throw new Error("Nothing to remember — 'text' was empty.");
      const items = load();
      if (items.some((m) => m.text.toLowerCase() === fact.toLowerCase())) {
        return `Already remembered: "${fact}".`;
      }
      items.push({ id: Date.now().toString(36), text: fact, createdAt: new Date().toISOString() });
      save(items);
      return `Got it — I'll remember: "${fact}".`;
    },
  },
  {
    name: "recall",
    description:
      "Look up what you remember about the user. Optionally filter by a keyword. " +
      "Memories are also always available to you in your system prompt.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Optional keyword to filter by." } },
    },
    run: async ({ query }: { query?: string }) => {
      const items = load();
      const q = String(query ?? "").trim().toLowerCase();
      const hits = q ? items.filter((m) => m.text.toLowerCase().includes(q)) : items;
      if (!hits.length) return q ? `Nothing remembered about "${query}".` : "No memories stored yet.";
      return hits.map((m, i) => `${i + 1}. ${m.text}`).join("\n");
    },
  },
  {
    name: "forget",
    description: "Remove remembered facts that match a keyword. Use when info is outdated or wrong.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Keyword; facts containing it are removed." } },
      required: ["query"],
    },
    run: async ({ query }: { query: string }) => {
      const q = String(query ?? "").trim().toLowerCase();
      if (!q) throw new Error("'query' is required to forget something.");
      const items = load();
      const kept = items.filter((m) => !m.text.toLowerCase().includes(q));
      const removed = items.length - kept.length;
      if (!removed) return `Nothing matched "${query}", so nothing was forgotten.`;
      save(kept);
      return `Forgot ${removed} fact${removed === 1 ? "" : "s"} matching "${query}".`;
    },
  },
];
