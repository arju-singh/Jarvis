#!/usr/bin/env bash
#
# One-command setup for Jarvis: install + build the brain and both MCP servers,
# then seed config files. Run from the project root:  ./setup.sh
#
set -euo pipefail
cd "$(dirname "$0")"

echo "→ Installing dependencies (brain + MCP servers)…"
npm install
npm --prefix mcp-servers/projects install
npm --prefix mcp-servers/petsacre install

echo "→ Building everything…"
npm run build:all

echo "→ Seeding config (won't overwrite existing files)…"
[ -f .env ] || { cp .env.example .env; echo "  created .env — fill in your keys"; }
[ -f mcp-servers/projects/projects.config.json ] \
  || cp mcp-servers/projects/projects.config.example.json mcp-servers/projects/projects.config.json

cat <<'DONE'

✓ Setup complete.

Next:
  1. Edit .env  (keys for online mode, or JARVIS_MODE=offline)
  2. npm run doctor      # verify the chain
  3. npm run dev         # start the brain
  4. python jarvis_ptt.py    # talk to it (push-to-talk)

Offline mode? See setup-offline.md.
DONE
