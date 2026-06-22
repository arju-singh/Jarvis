# Offline setup (macOS)

Get Jarvis thinking and speaking with **no internet**. Hearing (wake word +
Whisper) is already offline; this adds the offline **brain** (Ollama / Qwen 2.5)
and **voice** (Piper).

Verify each step with `npm run doctor` (it's mode-aware — set `JARVIS_MODE=offline`
in `.env` first).

---

## 1. Offline brain — Ollama + Qwen 2.5

```bash
brew install ollama          # or download from https://ollama.com
brew services start ollama   # runs the daemon at http://127.0.0.1:11434
ollama pull qwen2.5          # ~4.7 GB (the 7B model; good tool-calling)
```

Quick check:
```bash
ollama list                  # should show qwen2.5
curl http://127.0.0.1:11434/api/tags   # should return JSON with qwen2.5
```

Bigger/smaller variants (optional): `ollama pull qwen2.5:14b` (smarter, slower)
or `qwen2.5:3b` (faster, weaker). Set the choice in `.env` as `JARVIS_OLLAMA_MODEL`.

---

## 2. Offline voice — Piper

Install the CLI:
```bash
pip install piper-tts        # provides the `piper` command (use a venv if you like)
```

Download a voice — you need **both** files, in the same folder:
```bash
mkdir -p voices && cd voices
# en_US-amy-medium (clear US English). Browse more at:
#   https://huggingface.co/rhasspy/piper-voices
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx
curl -L -O https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json
cd ..
```

Test it directly:
```bash
echo "Jarvis online, fully offline." | piper \
  --model voices/en_US-amy-medium.onnx --output_file /tmp/test.wav
ffplay -autoexit -nodisp /tmp/test.wav    # brew install ffmpeg if missing
```

> Hindi/Indic voices exist too (search the voices repo for `hi_IN`). Point
> `PIPER_MODEL` at whichever `.onnx` you prefer.

---

## 3. Point Jarvis at them

In `.env`:
```ini
JARVIS_MODE=offline
JARVIS_OLLAMA_URL=http://127.0.0.1:11434
JARVIS_OLLAMA_MODEL=qwen2.5
PIPER_BIN=piper
PIPER_MODEL=/Users/arju/Desktop/JarvisArju/voices/en_US-amy-medium.onnx
```

(`JARVIS_MODE=auto` instead will use offline only when there's no internet, and
cloud when there is — but `auto` still needs the cloud keys present for the
online case.)

---

## 4. Verify the whole offline chain

```bash
npm run doctor
```
Expect:
```
✓ mode — offline
✓ env: JARVIS_WORKDIR exists
✓ live: Ollama + model — ... has qwen2.5
✓ offline TTS: Piper model — .../en_US-amy-medium.onnx
✓ projects MCP loads
```
No Anthropic/ElevenLabs keys are required in offline mode.

---

## 5. Run it

```bash
npm run dev                                   # brain (offline)
# in another terminal — the ears (Python 3.11 venv recommended):
BRAIN_URL=http://127.0.0.1:8787/turn python jarvis_ptt.py
```

Pull the network cable / turn off Wi-Fi and it still answers.

---

## What still won't work offline (by design)

Tools that fundamentally need the internet — **weather, web search, Firestore
analytics** — fail loud with a clear message instead of faking data. Everything
local (desktop control, memory, datetime) works. And offline tool-calling via
Qwen is solid but not Claude-level: if a complex multi-tool request misbehaves
offline, phrase it more simply or switch back to `JARVIS_MODE=online`.
