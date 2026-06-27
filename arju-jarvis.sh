#!/usr/bin/env bash
#
# ARJU JARVIS — one-command launch.
# Starts the brain (Claude/Ollama/Gemini + TTS + tools + MCP) AND the ears
# (clap 3x or "Hey Jarvis" to wake). Ctrl-C stops both cleanly.
#
#   ./arju-jarvis.sh           # brain + voice ears
#   ./arju-jarvis.sh brain     # brain only (use the web UI at :8787)
#
set -euo pipefail
cd "$(dirname "$0")"

# Load .env so BRAIN_URL / JARVIS_NAME / clap knobs reach the Python ears too.
set -a; [ -f .env ] && . ./.env; set +a
: "${JARVIS_NAME:=Arju Jarvis}"
: "${BRAIN_URL:=http://127.0.0.1:8787/turn}"
PORT="${JARVIS_PORT:-8787}"

pids=()
cleanup() { echo; echo "→ stopping $JARVIS_NAME…"; kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "→ starting $JARVIS_NAME brain on http://127.0.0.1:$PORT …"
npm run dev & pids+=($!)

# Wait for the brain to answer before bringing the ears online.
for _ in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then break; fi
  sleep 1
done

if [ "${1:-all}" = "brain" ]; then
  echo "→ brain only. Open http://127.0.0.1:$PORT/  (Ctrl-C to stop)"
  wait
  exit 0
fi

if [ ! -x .venv/bin/python ] || ! .venv/bin/python -c "import numpy, sounddevice, torch, faster_whisper, openwakeword, silero_vad" 2>/dev/null; then
  echo "✗ voice deps not installed. Enable clap/voice with:"
  echo "      python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  echo "  Brain is running anyway — open http://127.0.0.1:$PORT/ to chat/type."
  wait
  exit 0
fi

echo "→ starting ears — clap ${CLAP_COUNT:-3}x or say 'Hey Jarvis' …"
BRAIN_URL="$BRAIN_URL" .venv/bin/python jarvis_ears.py & pids+=($!)

wait
