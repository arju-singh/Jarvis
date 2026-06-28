/**
 * TTS providers — the "speaking" layer, swappable by mode.
 *
 *   online  → ElevenLabsTts (cloud, the "butler" voice)
 *   offline → PiperTts      (local neural voice, no internet)
 *
 * Playback is shared: audio plays as a tracked child process so it can be cut
 * off for barge-in. Only one utterance plays at a time, so the player is a
 * module-level singleton used by both providers.
 *
 * No fallbacks: missing keys (online) or a missing Piper model (offline) throw.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mode } from "../mode.js";

// --- shared, interruptible playback ---------------------------------------

let currentPlayer: ChildProcess | null = null;
const AUDIO_PLAYER = process.env.JARVIS_AUDIO_PLAYER ?? "ffplay -autoexit -nodisp -loglevel quiet";

export function isSpeaking(): boolean {
  return currentPlayer !== null;
}

export function stopSpeaking(): void {
  if (currentPlayer) {
    currentPlayer.kill("SIGKILL");
    currentPlayer = null;
  }
}

function trackPlayer(player: ChildProcess): void {
  stopSpeaking(); // cut off anything still playing
  currentPlayer = player;
  player.on("exit", () => {
    if (currentPlayer === player) currentPlayer = null;
  });
}

function playFile(file: string): void {
  const [cmd, ...args] = AUDIO_PLAYER.split(/\s+/);
  trackPlayer(spawn(cmd, [...args, file], { stdio: "ignore" }));
}

export interface TtsProvider {
  readonly name: string;
  /** Synthesize and start playing (non-blocking). */
  speak(text: string): Promise<void>;
}

// --- ElevenLabs (online) --------------------------------------------------

class ElevenLabsTts implements TtsProvider {
  readonly name = "elevenlabs";
  private key: string;
  private voice: string;

  constructor() {
    const key = process.env.ELEVENLABS_API_KEY;
    const voice = process.env.ELEVENLABS_VOICE_ID;
    if (!key) throw new Error("Online TTS needs ELEVENLABS_API_KEY.");
    if (!voice) throw new Error("Online TTS needs ELEVENLABS_VOICE_ID.");
    this.key = key;
    this.voice = voice;
  }

  async speak(text: string): Promise<void> {
    if (!text.trim()) return;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this.voice}`, {
      method: "POST",
      headers: { "xi-api-key": this.key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
    });
    if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`);
    const file = join(tmpdir(), `jarvis-${Date.now()}.mp3`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    playFile(file);
  }
}

// --- Piper (offline) ------------------------------------------------------

class PiperTts implements TtsProvider {
  readonly name = "piper";
  private bin: string;
  private model: string;

  constructor() {
    const model = process.env.PIPER_MODEL;
    if (!model) {
      throw new Error(
        "Offline TTS needs PIPER_MODEL (path to a .onnx voice). " +
          "Download one from https://github.com/rhasspy/piper/releases and set PIPER_MODEL.",
      );
    }
    this.bin = process.env.PIPER_BIN ?? "piper";
    this.model = model;
  }

  async speak(text: string): Promise<void> {
    if (!text.trim()) return;
    const file = join(tmpdir(), `jarvis-${Date.now()}.wav`);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(this.bin, ["--model", this.model, "--output_file", file], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (d) => (stderr += d));
      proc.on("error", (err) =>
        reject(new Error(`Cannot run Piper ("${this.bin}"): ${err.message}. Install piper or set PIPER_BIN.`)),
      );
      proc.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`Piper exited ${code}: ${stderr.trim()}`)),
      );
      proc.stdin.write(text);
      proc.stdin.end();
    });
    playFile(file);
  }
}

// --- macOS `say` (offline, zero-install) ----------------------------------

class SayTts implements TtsProvider {
  readonly name = "say";
  async speak(text: string): Promise<void> {
    if (!text.trim()) return;
    const voice = process.env.JARVIS_SAY_VOICE; // optional, e.g. "Daniel", "Rishi"
    const args = voice ? ["-v", voice, text] : [text];
    trackPlayer(spawn("say", args, { stdio: "ignore" }));
  }
}

// --- Automatic failover across the user's own voices -----------------------

/** Tries each voice in order; on error (quota, missing model, spawn fail) falls to the next. */
class FailoverTts implements TtsProvider {
  readonly name: string;
  constructor(private readonly providers: TtsProvider[]) {
    this.name = `failover(${providers.map((p) => p.name).join("→")})`;
  }

  async speak(text: string): Promise<void> {
    if (!text.trim()) return;
    const errors: string[] = [];
    for (let i = 0; i < this.providers.length; i++) {
      const p = this.providers[i];
      try {
        await p.speak(text);
        if (i > 0) console.error(`[tts] spoke via fallback "${p.name}"`);
        return;
      } catch (err) {
        const msg = (err as Error).message;
        errors.push(`${p.name}: ${msg}`);
        const next = this.providers[i + 1];
        console.error(`[tts] "${p.name}" failed: ${msg}` + (next ? ` — falling back to "${next.name}"` : ""));
      }
    }
    throw new Error(`All TTS providers failed: ${errors.join("; ")}`);
  }
}

/** Construct a voice by name, returning null (with a log) if its config is missing. */
function buildTts(name: string): TtsProvider | null {
  try {
    switch (name) {
      case "elevenlabs": return new ElevenLabsTts();
      case "piper": return new PiperTts();
      case "say": return new SayTts();
      default: return null;
    }
  } catch (err) {
    console.error(`[tts] "${name}" unavailable: ${(err as Error).message}`);
    return null;
  }
}

export function makeTts(mode: Mode): TtsProvider {
  // Primary: explicit JARVIS_TTS override, else the mode default.
  const primary = process.env.JARVIS_TTS?.toLowerCase() || (mode === "offline" ? "piper" : "elevenlabs");
  const failoverOff = /^(off|0|false|no)$/i.test(process.env.JARVIS_FAILOVER ?? "");

  // Primary first, then the rest. "say" is the always-available last resort on macOS.
  const order = [primary, ...["elevenlabs", "piper", "say"].filter((n) => n !== primary)];
  const providers = (failoverOff ? [primary] : order)
    .map(buildTts)
    .filter((p): p is TtsProvider => p !== null);

  if (providers.length === 0) {
    throw new Error(
      "No TTS provider configured. Set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID, " +
        "or PIPER_MODEL, or use macOS 'say' (JARVIS_TTS=say).",
    );
  }
  if (providers.length === 1) return providers[0];
  console.log(`[tts] failover chain: ${providers.map((p) => p.name).join(" → ")}`);
  return new FailoverTts(providers);
}
