#!/usr/bin/env bash
#
# ARJU JARVIS — live service manager (macOS / launchd).
#
# Keeps Jarvis running in the background and starts it at login. Both the brain
# (dashboard + tools) and the ears (clap / "Hey Jarvis") read settings live from
# .env, so changing a port/voice/wake setting never breaks the service.
#
#   ./jarvis-service.sh install      # set up + start Jarvis, auto-start at login
#   ./jarvis-service.sh status       # is it running? what port?
#   ./jarvis-service.sh restart      # pick up .env / code changes
#   ./jarvis-service.sh stop         # stop now (stays installed)
#   ./jarvis-service.sh start        # start again
#   ./jarvis-service.sh logs         # tail the live logs
#   ./jarvis-service.sh uninstall    # stop + remove (no more auto-start)
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UID_="$(id -u)"
NODE="$(command -v node || echo /usr/local/bin/node)"
PY="$REPO/.venv/bin/python"
LA="$HOME/Library/LaunchAgents"
BRAIN="com.arju.jarvis.brain"
EARS="com.arju.jarvis.ears"
PORT="$(grep -E '^JARVIS_PORT=' "$REPO/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d ' "' || true)"
PORT="${PORT:-3005}"

mkdir -p "$REPO/logs"

_load()   { launchctl bootstrap "gui/$UID_" "$1" 2>/dev/null || launchctl load -w "$1" 2>/dev/null || true; }
_unload() { launchctl bootout "gui/$UID_/$1" 2>/dev/null || launchctl unload -w "$LA/$1.plist" 2>/dev/null || true; }

write_brain() {
  cat > "$LA/$BRAIN.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$BRAIN</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string><string>--import</string><string>tsx</string>
    <string>--env-file=.env</string><string>server.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$REPO/logs/brain.log</string>
  <key>StandardErrorPath</key><string>$REPO/logs/brain.log</string>
</dict></plist>
EOF
}

# Ears source .env at launch, so the port/voice/clap/focus settings stay in sync.
write_ears() {
  cat > "$LA/$EARS.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$EARS</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>-lc</string>
    <string>cd "$REPO" &amp;&amp; set -a &amp;&amp; . ./.env &amp;&amp; set +a &amp;&amp; exec "$PY" jarvis_ears.py</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$REPO/logs/ears.log</string>
  <key>StandardErrorPath</key><string>$REPO/logs/ears.log</string>
</dict></plist>
EOF
}

has_voice() { [ -x "$PY" ] && "$PY" -c "import numpy,sounddevice,torch,faster_whisper,openwakeword,silero_vad" 2>/dev/null; }

cmd_install() {
  echo "→ installing Jarvis service (repo: $REPO, port: $PORT)"
  # Remove any prior/stale agents first so we don't double-bind the port.
  _unload "$BRAIN"; _unload "$EARS"
  pkill -f "arju-jarvis.sh" 2>/dev/null || true
  sleep 1

  write_brain; _load "$LA/$BRAIN.plist"
  echo "  ✓ brain  (dashboard + tools) — auto-starts at login, restarts on crash"

  if has_voice; then
    write_ears; _load "$LA/$EARS.plist"
    echo "  ✓ ears   (clap 3× / 'Hey Jarvis')"
    echo "    NOTE: grant Microphone access so background voice works —"
    echo "          System Settings ▸ Privacy ▸ Microphone (and Input Monitoring)."
  else
    echo "  • ears skipped (voice deps not found in .venv). Dashboard still runs."
  fi
  sleep 2
  cmd_status
}

cmd_uninstall() {
  _unload "$BRAIN"; _unload "$EARS"
  rm -f "$LA/$BRAIN.plist" "$LA/$EARS.plist"
  echo "→ Jarvis uninstalled (no more auto-start). Run with ./arju-jarvis.sh anytime."
}

cmd_start()   { _load "$LA/$BRAIN.plist"; [ -f "$LA/$EARS.plist" ] && _load "$LA/$EARS.plist"; echo "→ started"; cmd_status; }
cmd_stop()    { _unload "$BRAIN"; _unload "$EARS"; echo "→ stopped (still installed; 'start' to run again)"; }
cmd_restart() { cmd_stop; sleep 1; cmd_start; }

cmd_status() {
  echo "── Jarvis status ──"
  launchctl list 2>/dev/null | grep -i jarvis || echo "  (no agents loaded)"
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
    echo "  ✓ dashboard live → http://localhost:$PORT/"
  else
    echo "  … dashboard not answering on :$PORT yet (check: ./jarvis-service.sh logs)"
  fi
}

cmd_logs() { echo "tailing logs (Ctrl-C to stop)…"; tail -n 20 -f "$REPO/logs/brain.log" "$REPO/logs/ears.log" 2>/dev/null; }

case "${1:-install}" in
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      cmd_logs ;;
  *) echo "usage: $0 {install|uninstall|start|stop|restart|status|logs}"; exit 1 ;;
esac
