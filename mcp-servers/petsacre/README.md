# petsacre.club MCP server

Exposes petsacre.club operations as MCP tools for Jarvis. Reads **real** data
from Firestore — no mock data, fails loud if misconfigured.

## Tools

| Tool | What it does |
|---|---|
| `list_todays_bookings` | Today's bookings from Firestore, ordered by time |
| `list_bookings_for_date` | Bookings on a specific date (`YYYY-MM-DD`) |
| `get_upcoming_bookings` | Bookings in the next N days (default 7), with dates |

All three share one range query (`DATE_FIELD` in `[start, end)`, ordered by time)
and the same best-effort field mapping.

## Setup

```bash
npm install
npm run build        # → dist/index.js
```

Provide a Firestore service-account key (one of):
- `GOOGLE_APPLICATION_CREDENTIALS=/abs/path/service-account.json`  (preferred)
- `PETSACRE_SERVICE_ACCOUNT=/abs/path/service-account.json`

Get the key from Firebase Console → Project Settings → Service accounts →
Generate new private key. Keep it out of git (the repo's `.gitignore` excludes `secrets/`).

## Config (optional)

| Env var | Default | Meaning |
|---|---|---|
| `PETSACRE_BOOKINGS_COLLECTION` | `bookings` | Firestore collection name |
| `PETSACRE_DATE_FIELD` | `startTime` | Timestamp field holding the booking time |

The query is `where(DATE_FIELD >= startOfToday) AND (< startOfTomorrow)`,
ordered by `DATE_FIELD`. "Today" uses the server's local timezone — run it
in the relevant timezone (e.g. Asia/Kolkata).

> **Firestore index:** the range + `orderBy` on the same field works on a
> single-field index (automatic). If you later add another `where` filter,
> Firestore will print a console link to create the composite index.

## How Jarvis uses it

Registered in the brain's `server.ts` `mcpServers` list. The bridge namespaces
the tool as `petsacre__list_todays_bookings`. Ask: *"Jarvis, what are today's
bookings?"* and the brain routes the call here.

## Test standalone

```bash
GOOGLE_APPLICATION_CREDENTIALS=/abs/path/key.json npm run dev
# then speak MCP over stdio, or let the brain connect to it.
```

Expected fields per booking doc (all optional, best-effort):
`startTime` (Timestamp), `petName`, `ownerName`/`customerName`, `service`, `status`.
Missing fields degrade gracefully in the summary; they are never faked.
