#!/usr/bin/env bash
# Daily content-agent run for cron / launchd.
# Posts the next unused clip from content/clips/ to the configured platforms.
#
# Install (runs every day at 10:00 — match config/api_keys.json "post_time"):
#   ( crontab -l 2>/dev/null; echo "0 10 * * * /Users/arju/JarvisArju/scripts/content_agent_daily.sh" ) | crontab -
# Inspect:  crontab -l        Remove:  crontab -l | grep -v content_agent_daily | crontab -
# Log:      logs/content_agent.log
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

# ffmpeg / brew live outside cron's minimal PATH — add common locations.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

mkdir -p "$ROOT/logs"
cd "$ROOT"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] content agent: starting daily run" >> logs/content_agent.log
"$PY" -m actions.content_agent post >> logs/content_agent.log 2>&1
echo "[$(date '+%Y-%m-%d %H:%M:%S')] content agent: done" >> logs/content_agent.log
