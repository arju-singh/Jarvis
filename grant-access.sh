#!/usr/bin/env bash
#
# ARJU JARVIS — grant full machine access (macOS).
# Jarvis controls your Mac through the terminal it runs in, so the permissions
# below must be granted to your TERMINAL APP (Terminal.app / iTerm / VS Code),
# NOT to node/python. This opens each System Settings pane; flip the toggle on.
#
set -euo pipefail

open_pane() { echo "  → $1"; open "$2" 2>/dev/null || true; sleep 1; }

cat <<'TXT'
ARJU JARVIS — access setup (macOS)
Grant these to the app you launch Jarvis from (your terminal):

  [ ] Microphone        — hear you (clap / wake word / speech)
  [ ] Screen Recording  — see your screen (screen_process / vision)
  [ ] Accessibility     — control keyboard & mouse (type_text, hotkeys)
  [ ] Automation        — drive apps & System Events (open_app, browser_control)
  [ ] Full Disk Access  — read/write files anywhere (read_file / write_file)

Opening each pane now — toggle your terminal ON in each, then quit & reopen it.
TXT

open_pane "Microphone"        "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
open_pane "Screen Recording"  "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
open_pane "Accessibility"     "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
open_pane "Automation"        "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
open_pane "Full Disk Access"  "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"

echo
echo "Done opening panes. After toggling, QUIT and reopen your terminal so the"
echo "new permissions take effect, then run:  ./arju-jarvis.sh"
