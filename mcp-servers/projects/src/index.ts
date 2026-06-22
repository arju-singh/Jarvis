/**
 * Projects — a generic, config-driven analytics MCP server.
 *
 * Register a project (a Firestore collection) once, and these tools work for it:
 *   list_projects      — what's registered
 *   register_project   — add a new project (writes config; usable immediately)
 *   list_records       — records for a project on a date / range
 *   project_analytics  — totals, status & category breakdowns, daily trend
 *
 * All data is read live from Firestore. No fallbacks, no mock data: a missing
 * project, bad date, or absent credentials throws a clear error.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  loadRegistry,
  saveRegistry,
  getProject,
  CONFIG_PATH,
  type ProjectConfig,
} from "./config.js";
import { firestore, Timestamp } from "./firestore.js";
import { inferProjectConfig } from "./infer.js";

// --- date helpers ---------------------------------------------------------

function todayRange(): { start: Date; end: Date } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function dayRange(dateStr: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!m) throw new Error(`Invalid date "${dateStr}". Use YYYY-MM-DD, e.g. 2026-06-25.`);
  const [, y, mo, d] = m;
  const start = new Date(Number(y), Number(mo) - 1, Number(d));
  if (Number.isNaN(start.getTime())) throw new Error(`Invalid date "${dateStr}".`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function lastNDays(days: number): { start: Date; end: Date } {
  if (!Number.isFinite(days) || days < 1 || days > 365) {
    throw new Error(`"days" must be between 1 and 365 (got ${days}).`);
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1); // through end of today
  return { start, end };
}

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function asDate(value: unknown): Date | undefined {
  if (value instanceof Timestamp) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const p = new Date(value);
    if (!Number.isNaN(p.getTime())) return p;
  }
  return undefined;
}

function pick(data: Record<string, unknown>, keys: string[] | undefined): string | undefined {
  for (const k of keys ?? []) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

// --- queries --------------------------------------------------------------

async function fetchRange(p: ProjectConfig, start: Date, end: Date) {
  return firestore()
    .collection(p.collection)
    .where(p.dateField, ">=", Timestamp.fromDate(start))
    .where(p.dateField, "<", Timestamp.fromDate(end))
    .orderBy(p.dateField)
    .get();
}

function formatRecord(p: ProjectConfig, id: string, d: Record<string, unknown>, i: number, showDate: boolean): string {
  const dt = asDate(d[p.dateField]);
  const when = dt
    ? showDate
      ? dt.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : "(no time)";
  const title = pick(d, p.titleFields) ?? "(untitled)";
  const subtitle = pick(d, p.subtitleFields);
  const category = p.categoryField ? pick(d, [p.categoryField]) : undefined;
  const status = p.statusField ? pick(d, [p.statusField]) : undefined;
  return [
    `${i + 1}. ${when} — ${title}`,
    subtitle ? `(${subtitle})` : null,
    category ? `· ${category}` : null,
    status ? `· ${status}` : null,
    `[id: ${id}]`, // for follow-up update_record / cancel_record calls
  ]
    .filter(Boolean)
    .join(" ");
}

// --- schema introspection (auto-generate config from real data) -----------

async function listCollections(): Promise<string> {
  const cols = await firestore().listCollections();
  if (!cols.length) return "No top-level collections found in this Firestore database.";
  return "Collections:\n" + cols.map((c) => `- ${c.id}`).join("\n");
}

async function suggestProjectConfig(input: Record<string, unknown>): Promise<string> {
  const collection = String(input.collection ?? "").trim();
  if (!collection) throw new Error("'collection' is required.");
  const id = String(input.id ?? collection).trim();
  const snap = await firestore().collection(collection).limit(25).get();
  if (snap.empty) throw new Error(`Collection "${collection}" is empty — nothing to infer from.`);

  const { config, hasDate, sampled } = inferProjectConfig(id, collection, snap.docs.map((d) => d.data()));
  const json = JSON.stringify(config, null, 2);
  const warn = hasDate
    ? ""
    : `\n\n⚠ No timestamp field detected — set "dateField" manually before registering.`;
  return (
    `Suggested config from ${sampled} sampled document${sampled === 1 ? "" : "s"} of "${collection}":\n\n${json}` +
    `${warn}\n\nReview, then register it with register_project (or paste into projects.config.json).`
  );
}

// --- tool implementations -------------------------------------------------

function listProjects(): string {
  const reg = loadRegistry();
  if (!reg.projects.length) return "No projects registered yet. Use register_project to add one.";
  return reg.projects
    .map((p) => `- ${p.id}${p.label ? ` (${p.label})` : ""}: collection "${p.collection}", date field "${p.dateField}"`)
    .join("\n");
}

function registerProject(input: Record<string, unknown>): string {
  const id = String(input.id ?? "").trim();
  const collection = String(input.collection ?? "").trim();
  const dateField = String(input.dateField ?? "").trim();
  if (!id || !collection || !dateField) {
    throw new Error("register_project needs at least: id, collection, dateField.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Project id "${id}" must be alphanumeric / dash / underscore.`);
  }
  const reg = loadRegistry();
  if (reg.projects.some((p) => p.id === id)) {
    throw new Error(`A project with id "${id}" already exists.`);
  }
  const project: ProjectConfig = {
    id,
    collection,
    dateField,
    ...(typeof input.label === "string" ? { label: input.label } : {}),
    ...(typeof input.statusField === "string" ? { statusField: input.statusField } : {}),
    ...(typeof input.categoryField === "string" ? { categoryField: input.categoryField } : {}),
    ...(typeof input.amountField === "string" ? { amountField: input.amountField } : {}),
    ...(Array.isArray(input.titleFields) ? { titleFields: input.titleFields as string[] } : {}),
    ...(Array.isArray(input.subtitleFields) ? { subtitleFields: input.subtitleFields as string[] } : {}),
  };
  reg.projects.push(project);
  saveRegistry(reg);
  return `Registered project "${id}" → collection "${collection}". It's ready to use now.`;
}

async function listRecords(input: Record<string, unknown>): Promise<string> {
  const p = getProject(String(input.projectId ?? ""));
  let range: { start: Date; end: Date };
  let label: string;
  let showDate = false;
  if (typeof input.date === "string" && input.date.trim()) {
    range = dayRange(input.date);
    label = range.start.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  } else if (typeof input.days === "number") {
    range = lastNDays(input.days);
    label = `the last ${input.days} day${input.days === 1 ? "" : "s"}`;
    showDate = true;
  } else {
    range = todayRange();
    label = "today";
  }
  const snap = await fetchRange(p, range.start, range.end);
  if (snap.empty) return `No records for ${p.label ?? p.id} on ${label}.`;
  const lines = snap.docs.map((doc, i) => formatRecord(p, doc.id, doc.data(), i, showDate));
  return `${snap.size} record${snap.size === 1 ? "" : "s"} for ${p.label ?? p.id} (${label}):\n${lines.join("\n")}`;
}

/** Shared guard: writes refuse unless the brain passes confirm=true after a verbal yes. */
function requireConfirm(input: Record<string, unknown>): void {
  if (input.confirm !== true) {
    throw new Error(
      "Not confirmed. State exactly what will change, get the user's verbal 'yes', " +
        "then call again with confirm=true.",
    );
  }
}

async function updateRecord(input: Record<string, unknown>): Promise<string> {
  const p = getProject(String(input.projectId ?? ""));
  const recordId = String(input.recordId ?? "").trim();
  if (!recordId) throw new Error("'recordId' is required (get it from list_records, shown as [id: ...]).");
  const fields = input.fields;
  if (typeof fields !== "object" || fields === null || Array.isArray(fields) || !Object.keys(fields).length) {
    throw new Error("'fields' must be a non-empty object of fieldName → newValue.");
  }
  requireConfirm(input);

  const ref = firestore().collection(p.collection).doc(recordId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`No record "${recordId}" in project "${p.id}".`);
  await ref.update(fields as Record<string, unknown>);
  const changed = Object.entries(fields as Record<string, unknown>)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return `Updated record ${recordId} in ${p.label ?? p.id}: ${changed}.`;
}

async function cancelRecord(input: Record<string, unknown>): Promise<string> {
  const p = getProject(String(input.projectId ?? ""));
  const recordId = String(input.recordId ?? "").trim();
  if (!recordId) throw new Error("'recordId' is required (get it from list_records, shown as [id: ...]).");
  if (!p.statusField) {
    throw new Error(`Project "${p.id}" has no statusField configured, so it can't be cancelled.`);
  }
  requireConfirm(input);

  const ref = firestore().collection(p.collection).doc(recordId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error(`No record "${recordId}" in project "${p.id}".`);
  await ref.update({ [p.statusField]: "cancelled" });
  return `Cancelled record ${recordId} in ${p.label ?? p.id} (${p.statusField} = "cancelled").`;
}

/** Parse a numeric value from a field (number, or numeric string like "₹1,200"). */
function num(d: Record<string, unknown>, field: string | undefined): number | undefined {
  if (!field) return undefined;
  const v = d[field];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    if (cleaned && cleaned !== "-" && cleaned !== ".") {
      const n = Number(cleaned);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/** Pure aggregation over already-fetched rows — unit-testable without Firestore. */
export function summarize(p: ProjectConfig, rows: Record<string, unknown>[], days: number): string {
  const total = rows.length;
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  let revTotal = 0;
  let revCount = 0;
  const revByCategory: Record<string, number> = {};

  for (const d of rows) {
    if (p.statusField) {
      const s = pick(d, [p.statusField]) ?? "unspecified";
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }
    const cat = p.categoryField ? pick(d, [p.categoryField]) ?? "unspecified" : undefined;
    if (cat !== undefined) byCategory[cat] = (byCategory[cat] ?? 0) + 1;
    const dt = asDate(d[p.dateField]);
    if (dt) {
      const k = dayKey(dt);
      byDay[k] = (byDay[k] ?? 0) + 1;
    }
    const amt = num(d, p.amountField);
    if (amt !== undefined) {
      revTotal += amt;
      revCount += 1;
      if (cat !== undefined) revByCategory[cat] = (revByCategory[cat] ?? 0) + amt;
    }
  }

  const fmtCount = (m: Record<string, number>) =>
    Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(", ");
  const round = (n: number) => (Math.round(n * 100) / 100).toString();

  const parts = [
    `Analytics for ${p.label ?? p.id} — last ${days} day${days === 1 ? "" : "s"}:`,
    `Total records: ${total} (avg ${(total / days).toFixed(1)}/day).`,
  ];
  if (p.statusField && total) parts.push(`By status — ${fmtCount(byStatus)}.`);
  if (p.categoryField && total) parts.push(`By ${p.categoryField} — ${fmtCount(byCategory)}.`);
  if (p.amountField) {
    if (revCount === 0) {
      parts.push(`No numeric values found in "${p.amountField}", so no revenue total.`);
    } else {
      parts.push(`Revenue: ${round(revTotal)} from ${revCount} record${revCount === 1 ? "" : "s"} (avg ${round(revTotal / revCount)}).`);
      if (p.categoryField) {
        const top = Object.entries(revByCategory).sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}: ${round(v)}`).join(", ");
        parts.push(`Revenue by ${p.categoryField} — ${top}.`);
      }
    }
  }
  if (total) {
    const trend = Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}: ${v}`).join(", ");
    parts.push(`Daily — ${trend}.`);
  }
  return parts.join("\n");
}

async function projectAnalytics(input: Record<string, unknown>): Promise<string> {
  const p = getProject(String(input.projectId ?? ""));
  const days = typeof input.days === "number" ? input.days : 7;
  const { start, end } = lastNDays(days);
  const snap = await fetchRange(p, start, end);
  return summarize(p, snap.docs.map((doc) => doc.data()), days);
}

// --- MCP wiring -----------------------------------------------------------

const server = new Server({ name: "projects", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_projects",
      description: "List all registered projects and their Firestore collection mappings.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_collections",
      description:
        "List the Firestore database's top-level collections. Use to discover what's there " +
        "before registering a project.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "suggest_project_config",
      description:
        "Sample real documents from a Firestore collection and auto-generate a project config " +
        "(date/status/category/amount/title fields). Use to onboard a new product without " +
        "knowing its schema by hand. Then register_project with the suggestion.",
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string", description: "Firestore collection to inspect." },
          id: { type: "string", description: "Project id to assign (defaults to the collection name)." },
        },
        required: ["collection"],
      },
    },
    {
      name: "register_project",
      description:
        "Register a new project so its records become queryable. Provide the Firestore " +
        "collection and which field holds the date; optionally status/category/title fields.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Short id, e.g. 'petsacre' (alphanumeric/-/_)." },
          label: { type: "string", description: "Human label, e.g. 'petsacre.club'." },
          collection: { type: "string", description: "Firestore collection name." },
          dateField: { type: "string", description: "Timestamp field for date ranges/ordering." },
          statusField: { type: "string", description: "Field holding a status string." },
          categoryField: { type: "string", description: "Field holding a category/type." },
          amountField: { type: "string", description: "Numeric field for revenue/amount analytics." },
          titleFields: { type: "array", items: { type: "string" }, description: "Candidate title fields." },
          subtitleFields: { type: "array", items: { type: "string" }, description: "Candidate subtitle fields." },
        },
        required: ["id", "collection", "dateField"],
      },
    },
    {
      name: "list_records",
      description:
        "List a project's records for today (default), a specific date (YYYY-MM-DD), or the " +
        "last N days. Use for 'show me today's X' or 'records on the 25th'.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Which registered project." },
          date: { type: "string", description: "Specific date YYYY-MM-DD (optional)." },
          days: { type: "number", description: "Last N days instead of a single date (optional)." },
        },
        required: ["projectId"],
      },
    },
    {
      name: "project_analytics",
      description:
        "Analytics for a project over the last N days (default 7): total, average per day, " +
        "breakdown by status and category, and a daily trend.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Which registered project." },
          days: { type: "number", description: "Lookback window in days (1-365, default 7)." },
        },
        required: ["projectId"],
      },
    },
    {
      name: "update_record",
      description:
        "Update fields on a specific record. WRITE action: first tell the user exactly what " +
        "will change and get their verbal yes, THEN call with confirm=true. Get recordId from " +
        "list_records (shown as [id: ...]).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Which registered project." },
          recordId: { type: "string", description: "Firestore document id of the record." },
          fields: { type: "object", description: "Map of fieldName → new value to set." },
          confirm: { type: "boolean", description: "Must be true; only after the user said yes." },
        },
        required: ["projectId", "recordId", "fields"],
      },
    },
    {
      name: "cancel_record",
      description:
        "Cancel a record (sets its status field to 'cancelled'). WRITE action: confirm with the " +
        "user out loud first, then call with confirm=true. Get recordId from list_records.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Which registered project." },
          recordId: { type: "string", description: "Firestore document id of the record." },
          confirm: { type: "boolean", description: "Must be true; only after the user said yes." },
        },
        required: ["projectId", "recordId"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  let text: string;
  switch (req.params.name) {
    case "list_projects":
      text = listProjects();
      break;
    case "list_collections":
      text = await listCollections();
      break;
    case "suggest_project_config":
      text = await suggestProjectConfig(args);
      break;
    case "register_project":
      text = registerProject(args);
      break;
    case "list_records":
      text = await listRecords(args);
      break;
    case "project_analytics":
      text = await projectAnalytics(args);
      break;
    case "update_record":
      text = await updateRecord(args);
      break;
    case "cancel_record":
      text = await cancelRecord(args);
      break;
    default:
      throw new Error(`Unknown tool: ${req.params.name}`);
  }
  return { content: [{ type: "text", text }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[projects] MCP server ready (config: ${CONFIG_PATH})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
