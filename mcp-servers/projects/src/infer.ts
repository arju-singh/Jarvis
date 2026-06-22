/**
 * Schema inference — auto-generate a project config by sampling real documents.
 *
 * Pure (no Firestore, no side effects) so it can be reused by the MCP server,
 * the standalone introspect CLI, and unit tests alike. Detection runs on actual
 * document shapes; it never invents fields.
 */

import type { ProjectConfig } from "./config.js";
import { Timestamp } from "./firestore.js";

const NAME_DATE = /(date|time|created|updated|start|begin|when|timestamp|_at$|At$)/;
const NAME_STATUS = /(status|state|stage)/i;
const NAME_CATEGORY = /(service|type|category|plan|kind|tier|package)/i;
const NAME_AMOUNT = /(amount|price|total|cost|fee|revenue|paid|charge|value)/i;
const NAME_TITLE = /(name|title|pet|customer|client|owner|email|label|subject)/i;

export function looksLikeTimestamp(v: unknown): boolean {
  if (v instanceof Timestamp || v instanceof Date) return true;
  if (typeof v === "object" && v !== null && typeof (v as { toDate?: unknown }).toDate === "function") return true;
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/.test(v);
  return false;
}

export interface Inference {
  config: ProjectConfig;
  hasDate: boolean;
  sampled: number;
}

/** Infer a project config by sampling documents. */
export function inferProjectConfig(id: string, collection: string, docs: Record<string, unknown>[]): Inference {
  const ts = new Set<string>();
  const nums = new Set<string>();
  const strs = new Set<string>();
  for (const d of docs) {
    for (const [k, v] of Object.entries(d)) {
      if (looksLikeTimestamp(v)) ts.add(k);
      else if (typeof v === "number") nums.add(k);
      else if (typeof v === "string") strs.add(k);
    }
  }
  const tsFields = [...ts];
  const find = (cands: string[], re: RegExp) => cands.find((f) => re.test(f));

  const dateField = find(tsFields, NAME_DATE) ?? tsFields[0];
  const statusField = find([...strs], NAME_STATUS);
  const categoryField = find([...strs], NAME_CATEGORY);
  const amountField = find([...nums], NAME_AMOUNT);
  const titleFields = [...strs].filter((f) => NAME_TITLE.test(f) && f !== statusField && f !== categoryField).slice(0, 4);

  const config: ProjectConfig = {
    id,
    label: id,
    collection,
    dateField: dateField ?? "",
    ...(statusField ? { statusField } : {}),
    ...(categoryField ? { categoryField } : {}),
    ...(amountField ? { amountField } : {}),
    ...(titleFields.length ? { titleFields } : {}),
  };
  return { config, hasDate: Boolean(dateField), sampled: docs.length };
}
