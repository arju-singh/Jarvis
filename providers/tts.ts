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

export function makeTts(mode: Mode): TtsProvider {
  // Explicit provider override (e.g. JARVIS_TTS=say) takes precedence over mode.
  switch (process.env.JARVIS_TTS?.toLowerCase()) {
    case "say": return new SayTts();
    case "piper": return new PiperTts();
    case "elevenlabs": return new ElevenLabsTts();
  }
  return mode === "offline" ? new PiperTts() : new ElevenLabsTts();
}
