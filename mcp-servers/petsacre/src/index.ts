/**
 * petsacre.club — MCP server.
 *
 * Exposes petsacre.club operations as MCP tools so Jarvis (or any MCP client)
 * can run them by voice. Currently:
 *
 *   list_todays_bookings — real bookings from Firestore for today.
 *
 * Data source: Google Cloud Firestore (firebase-admin).
 * No fallbacks, no mock data: if credentials or the collection are missing,
 * the tool call throws a clear error rather than inventing results.
 *
 * Credentials (provide ONE):
 *   GOOGLE_APPLICATION_CREDENTIALS = /abs/path/to/service-account.json   (preferred)
 *   PETSACRE_SERVICE_ACCOUNT       = /abs/path/to/service-account.json
 *
 * Optional config:
 *   PETSACRE_BOOKINGS_COLLECTION = "bookings"   (Firestore collection name)
 *   PETSACRE_DATE_FIELD          = "startTime"  (Timestamp field that holds the booking time)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { initializeApp, cert, type App } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";

const COLLECTION = process.env.PETSACRE_BOOKINGS_COLLECTION ?? "bookings";
const DATE_FIELD = process.env.PETSACRE_DATE_FIELD ?? "startTime";

// --- Lazy Firestore: only initialized when a tool actually needs it, so the
//     server can advertise its tools even before credentials are configured. ---

let app: App | undefined;
let db: Firestore | undefined;

function firestore(): Firestore {
  if (db) return db;

  const keyPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ?? process.env.PETSACRE_SERVICE_ACCOUNT;
  if (!keyPath) {
    throw new Error(
      "No Firestore credentials. Set GOOGLE_APPLICATION_CREDENTIALS (or " +
        "PETSACRE_SERVICE_ACCOUNT) to your service-account JSON path.",
    );
  }

  let serviceAccount: Record<string, unknown>;
  try {
    serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (err) {
    throw new Error(`Could not read service-account key at ${keyPath}: ${(err as Error).message}`);
  }

  app = initializeApp({ credential: cert(serviceAccount as any) });
  db = getFirestore(app);
  return db;
}

// --- Today's range (in the server's local timezone) -----------------------

function todayRange(): { start: Date; end: Date } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function formatTime(value: unknown): string {
  // Firestore Timestamp, Date, or ISO string — render a readable local time.
  let date: Date | undefined;
  if (value instanceof Timestamp) date = value.toDate();
  else if (value instanceof Date) date = value;
  else if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date) return "(no time)";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function pick(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function formatDate(value: unknown): string {
  let date: Date | undefined;
  if (value instanceof Timestamp) date = value.toDate();
  else if (value instanceof Date) date = value;
  else if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) date = parsed;
  }
  if (!date) return "";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatBooking(
  d: Record<string, unknown>,
  index: number,
  opts: { showDate?: boolean } = {},
): string {
  const when = opts.showDate
    ? `${formatDate(d[DATE_FIELD])} ${formatTime(d[DATE_FIELD])}`.trim()
    : formatTime(d[DATE_FIELD]);
  const pet = pick(d, ["petName", "pet", "petsName"]) ?? "Unknown pet";
  const owner = pick(d, ["ownerName", "customerName", "owner", "name"]);
  const service = pick(d, ["service", "serviceName", "type", "package"]);
  const status = pick(d, ["status"]);
  return [
    `${index + 1}. ${when} — ${pet}`,
    owner ? `(${owner})` : null,
    service ? `· ${service}` : null,
    status ? `· ${status}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/** Fetch bookings whose DATE_FIELD falls in [start, end), ordered by time. */
async function bookingsInRange(start: Date, end: Date) {
  return firestore()
    .collection(COLLECTION)
    .where(DATE_FIELD, ">=", Timestamp.fromDate(start))
    .where(DATE_FIELD, "<", Timestamp.fromDate(end))
    .orderBy(DATE_FIELD)
    .get();
}

/** Parse a YYYY-MM-DD string into local-midnight start/end-of-day. Throws on bad input. */
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

async function listTodaysBookings(): Promise<string> {
  const { start, end } = todayRange();
  const snap = await bookingsInRange(start, end);
  if (snap.empty) return "No bookings for today.";
  const lines = snap.docs.map((doc, i) => formatBooking(doc.data(), i));
  return `${snap.size} booking${snap.size === 1 ? "" : "s"} today:\n${lines.join("\n")}`;
}

async function listBookingsForDate(dateStr: string): Promise<string> {
  const { start, end } = dayRange(dateStr);
  const snap = await bookingsInRange(start, end);
  const label = start.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  });
  if (snap.empty) return `No bookings for ${label}.`;
  const lines = snap.docs.map((doc, i) => formatBooking(doc.data(), i));
  return `${snap.size} booking${snap.size === 1 ? "" : "s"} on ${label}:\n${lines.join("\n")}`;
}

async function getUpcomingBookings(days: number): Promise<string> {
  if (!Number.isFinite(days) || days < 1 || days > 90) {
    throw new Error(`"days" must be between 1 and 90 (got ${days}).`);
  }
  const start = new Date(); // from this moment forward
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + days);
  const snap = await bookingsInRange(start, end);
  if (snap.empty) return `No bookings in the next ${days} day${days === 1 ? "" : "s"}.`;
  const lines = snap.docs.map((doc, i) => formatBooking(doc.data(), i, { showDate: true }));
  return `${snap.size} upcoming booking${snap.size === 1 ? "" : "s"} (next ${days} day${days === 1 ? "" : "s"}):\n${lines.join("\n")}`;
}

// --- MCP wiring -----------------------------------------------------------

const server = new Server(
  { name: "petsacre", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_todays_bookings",
      description:
        "List petsacre.club bookings scheduled for today, ordered by time. " +
        "Returns each booking's time, pet name, owner, service and status.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "list_bookings_for_date",
      description:
        "List petsacre.club bookings on a specific calendar date, ordered by time. " +
        "Use for questions like 'what's booked on the 25th' or 'bookings for next Monday' " +
        "(resolve the date to YYYY-MM-DD first).",
      inputSchema: {
        type: "object",
        properties: { date: { type: "string", description: "Calendar date as YYYY-MM-DD." } },
        required: ["date"],
      },
    },
    {
      name: "get_upcoming_bookings",
      description:
        "List petsacre.club bookings coming up in the next N days (from now), with dates. " +
        "Use for 'what's coming up this week' or 'upcoming bookings'.",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "number", description: "How many days ahead to look (1-90). Default 7." },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  let text: string;
  switch (req.params.name) {
    case "list_todays_bookings":
      text = await listTodaysBookings();
      break;
    case "list_bookings_for_date":
      if (typeof args.date !== "string") throw new Error("'date' (YYYY-MM-DD) is required.");
      text = await listBookingsForDate(args.date);
      break;
    case "get_upcoming_bookings":
      text = await getUpcomingBookings(typeof args.days === "number" ? args.days : 7);
      break;
    default:
      throw new Error(`Unknown tool: ${req.params.name}`);
  }
  return { content: [{ type: "text", text }] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only — stdout is the MCP protocol channel.
  console.error(`[petsacre] MCP server ready (collection="${COLLECTION}", dateField="${DATE_FIELD}")`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
