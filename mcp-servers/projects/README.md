# Projects MCP — generic, config-driven analytics

Register any product (a Firestore collection) once; get listing + analytics with
zero new code. This generalizes the standalone petsacre server — **add a project
instead of writing a server.**

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Show registered projects |
| `list_collections` | Discover the database's Firestore collections |
| `suggest_project_config` | **Auto-generate** a config by sampling a collection's real docs |
| `register_project` | Add a project (writes config; usable immediately) |
| `list_records` | A project's records for today / a date / last N days (each tagged `[id: ...]`) |
| `project_analytics` | Total, avg/day, status & category breakdown, **revenue** (if `amountField` set), daily trend |
| `update_record` | Set fields on one record — **write, confirm-guarded** |
| `cancel_record` | Set a record's status to `cancelled` — **write, confirm-guarded** |

All data is read live from Firestore. No mock data: unknown project, bad date,
or missing credentials all throw clearly.

### Write safety

`update_record` and `cancel_record` mutate data, so they refuse unless called
with `confirm: true`. Their descriptions instruct the brain to state the exact
change and get the user's verbal "yes" first — mirroring the desktop
`run_shell_confirmed` pattern. The guard fires *before* any Firestore call.
Record ids come from `list_records` output (`[id: ...]`).

## Setup

```bash
npm install
npm run build
cp projects.config.example.json projects.config.json   # seeded with petsacre
```

Provide Firestore credentials (one of):
- `GOOGLE_APPLICATION_CREDENTIALS=/abs/path/service-account.json`
- `PROJECTS_SERVICE_ACCOUNT=/abs/path/service-account.json`

(The brain passes `PROJECTS_SA_KEY` from its `.env` through as
`GOOGLE_APPLICATION_CREDENTIALS`.)

## Onboard a product automatically (recommended)

**Fastest — standalone CLI (no brain needed)**, run from the repo root:
```bash
npm run introspect                          # list your Firestore collections
npm run introspect -- bookings              # suggest a config from real docs
npm run introspect -- bookings --register   # ...and save it to projects.config.json
```
It samples ~25 real documents and auto-detects date/status/category/amount/title
fields. Needs Firestore credentials (`PROJECTS_SA_KEY` in the brain's `.env`, or
`GOOGLE_APPLICATION_CREDENTIALS`).

**Or by voice / MCP tools** while the brain runs:

1. `list_collections` → see what's in the database
2. `suggest_project_config` with a collection name → it samples ~25 real
   documents and returns a ready config (date/status/category/amount/title
   fields auto-detected). By voice: *"Jarvis, suggest a config for the orders
   collection."*
3. Review it, then `register_project` with the suggestion.

Nothing is invented — detection runs on your actual documents, and if no
timestamp field is found it says so rather than guessing.

## Add a project (manually)

**By editing `projects.config.json`:**
```json
{
  "id": "zetsgeo",
  "label": "ZetsGeo",
  "collection": "orders",
  "dateField": "createdAt",
  "statusField": "status",
  "categoryField": "plan",
  "amountField": "total",
  "titleFields": ["customerName", "title"],
  "subtitleFields": ["email"]
}
```

`amountField` powers revenue analytics — it parses numbers and numeric strings
like `"₹1,200"`. If the field is missing on records, analytics says so honestly
rather than reporting a misleading zero.

**Or by voice / tool:** *"Jarvis, register a project called zetsgeo, collection
orders, date field createdAt."* → `register_project`. The config is re-read on
every call, so it works immediately — no restart.

Only `id`, `collection`, `dateField` are required. The status/category/title
fields just make analytics and listings richer; missing ones degrade gracefully.

> **Firestore index:** the range + `orderBy` on `dateField` uses an automatic
> single-field index. Adding more `where` filters later may prompt Firestore to
> create a composite index (it prints a console link).

## Config location

Default: `mcp-servers/projects/projects.config.json`. Override with the
`PROJECTS_CONFIG` env var. The file is git-ignored (it's runtime state that
`register_project` mutates); the `.example` is tracked.
