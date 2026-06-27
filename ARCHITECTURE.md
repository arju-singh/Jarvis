# Jarvis — Architecture

This repo holds **two coexisting Jarvis systems** plus three MCP tool servers:

1. **TypeScript brain** (`server.ts`) — the running voice-assistant loop on `:8787`
2. **Python "Mark XXXIX-OR"** (`main.py`) — a standalone PyQt6 + Gemini desktop app
3. **MCP tool servers** (`mcp-servers/`) — projects, petsacre (Firestore), pytools

```mermaid
flowchart TB
    %% ---------- INPUTS ----------
    subgraph IN["🗣️  User Inputs"]
        EARS["jarvis_ears.py<br/>openWakeWord → silero-VAD<br/>→ faster-whisper (STT)"]
        PTT["jarvis_ptt.py<br/>push-to-talk → Whisper"]
        WEBUI["public/index.html<br/>vanilla HTML/JS chat"]
    end

    %% ---------- TS BRAIN ----------
    subgraph BRAIN["🧠  TypeScript Brain — server.ts (Express 5, :8787)"]
        SEC["security.ts<br/>rate-limit · headers · loopback Host · body-validate"]
        LOOP["tool-calling loop<br/>(systemPrompt + history)"]
        MEM["memory.ts<br/>jarvis-memory.json"]

        subgraph BP["providers/brain.ts (swappable)"]
            CLAUDE["Claude<br/>@anthropic-ai/sdk"]
            OLLAMA["Ollama<br/>cloud/local"]
            GEMINI["Gemini<br/>REST"]
        end
        subgraph TP["providers/tts.ts (swappable)"]
            EL["ElevenLabs"]
            PIPER["Piper (offline)"]
            SAY["macOS say"]
        end
        subgraph LT["Local tools/*"]
            T1["desktop · computer · browser"]
            T2["games · vision · flights · assistant"]
        end
    end

    %% ---------- MCP ----------
    subgraph MCP["🔌  MCP servers (mcp-bridge.ts → stdio)"]
        PROJ["projects<br/>Node + firebase-admin"]
        PETS["petsacre<br/>Node + firebase-admin"]
        PYT["pytools<br/>Python FastMCP"]
    end

    %% ---------- PYTHON APP ----------
    subgraph PYAPP["🖥️  Python Mark XXXIX-OR — main.py (separate app)"]
        UI["ui.py (PyQt6)"]
        AGENT["agent/ planner · executor<br/>task_queue · error_handler"]
        ACTS["actions/ computer · browser<br/>content · dev · desktop"]
        ORC["or_client.py (OpenRouter)"]
    end

    %% ---------- EXTERNALS ----------
    subgraph EXT["☁️  External services"]
        ANTH["Anthropic API"]
        OLL["Ollama Cloud"]
        GAPI["Google Gemini API"]
        ELAPI["ElevenLabs API"]
        FS[("Firestore<br/>pets-3c1d5")]
        OR["OpenRouter"]
        PW["Playwright / Chromium"]
        DDG["DuckDuckGo · YouTube · web"]
    end

    %% ---------- EDGES ----------
    EARS -->|POST /turn| SEC
    PTT  -->|POST /turn| SEC
    WEBUI -->|POST /turn| SEC
    SEC --> LOOP
    LOOP <--> MEM
    LOOP --> BP
    LOOP --> LT
    LOOP --> MCP
    LOOP -->|reply text| TP

    CLAUDE --> ANTH
    OLLAMA --> OLL
    GEMINI --> GAPI
    EL --> ELAPI
    PIPER -->|afplay| SPK["🔊 speaker"]
    SAY --> SPK
    EL --> SPK

    PROJ --> FS
    PETS --> FS

    UI --> AGENT --> ACTS
    AGENT --> ORC --> OR
    UI --> GAPI
    ACTS --> PW
    ACTS --> DDG
    PYT --> DDG
```

## How a turn flows (TS brain)

1. **Input** — ears/PTT (voice→Whisper) or the web chat UI `POST /turn`.
2. **Security** — `security.ts` rate-limits, validates, enforces loopback.
3. **Think** — the loop calls the active brain provider (Claude / Ollama / Gemini) with the system prompt + memory preamble + tool schemas.
4. **Act** — tool calls dispatch to local `tools/*` or to an MCP server over stdio; `projects`/`petsacre` hit **Firestore**, `pytools` does web/clipboard/system.
5. **Remember** — useful facts persist to `jarvis-memory.json`.
6. **Speak** — reply text → TTS provider (ElevenLabs / Piper / say) → `afplay`/speaker; text returned to the caller.

The **Python Mark XXXIX-OR app** (`main.py`) is independent: its own PyQt6 UI, Gemini/OpenRouter brains, and `actions/` for browser (Playwright), desktop control, and content — it does **not** route through `server.ts`.
