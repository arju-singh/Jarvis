"""
ARJU JARVIS — offline ears.

Pipeline:  mic -> trigger (3 claps  OR  wake word "Hey Jarvis")
           -> VAD (end of speech) -> faster-whisper transcription -> POST to brain.

Trigger: clap THREE times (default) and Jarvis starts listening, or say the
wake word. Both run at once — use whichever is convenient.

Rules: no fallbacks. If a model/config is missing, this crashes immediately
rather than degrading silently.

Install:
    pip install -r requirements.txt
Run:
    BRAIN_URL=http://127.0.0.1:8787/turn python jarvis_ears.py
"""

from __future__ import annotations  # lazy annotations — `X | None` works on 3.9+

import os
import queue
import subprocess
import sys

import numpy as np
import requests
import sounddevice as sd
import torch
from faster_whisper import WhisperModel
from openwakeword.model import Model as WakeModel
from silero_vad import VADIterator, load_silero_vad

SAMPLE_RATE = 16_000
FRAME = 512                      # 32 ms @ 16 kHz — Silero VAD's required chunk
START_TIMEOUT_FRAMES = int(4.0 * SAMPLE_RATE / FRAME)    # give up if no speech in 4s
MAX_UTTERANCE_FRAMES = int(15.0 * SAMPLE_RATE / FRAME)   # hard cap 15s

# Tunable knobs (set in the environment — no code edits needed):
#   WAKE_THRESHOLD          wake-word confidence to trigger (0-1, default 0.5)
#   BARGEIN_VAD_THRESHOLD   speech confidence to interrupt while Jarvis talks.
#                           Raise toward 0.8 if open speakers self-trigger off
#                           Jarvis's own voice (no echo cancellation); lower if
#                           it's slow to notice you. Default 0.6.
WAKE_THRESHOLD = float(os.environ.get("WAKE_THRESHOLD", "0.5"))
BARGEIN_VAD_THRESHOLD = float(os.environ.get("BARGEIN_VAD_THRESHOLD", "0.6"))

# Assistant name shown in the banner (the brain owns its own identity prompt).
ASSISTANT_NAME = os.environ.get("JARVIS_NAME", "Arju Jarvis")

# Clap-to-wake knobs (all env-tunable, no code edits):
#   CLAP_COUNT          claps needed to trigger (default 3)
#   CLAP_THRESHOLD      peak loudness 0-1 of full scale that counts as a clap
#                       (default 0.45). Lower if your claps don't register;
#                       raise if normal speech/noise false-triggers.
#   CLAP_WINDOW         seconds the N claps must fall within (default 2.5)
#   CLAP_REFRACTORY_MS  dead time after a clap so one clap isn't double-counted
CLAP_COUNT = int(os.environ.get("CLAP_COUNT", "3"))
CLAP_THRESHOLD = int(float(os.environ.get("CLAP_THRESHOLD", "0.45")) * 32767)
CLAP_WINDOW_FRAMES = int(float(os.environ.get("CLAP_WINDOW", "2.5")) * SAMPLE_RATE / FRAME)
CLAP_REFRACTORY_FRAMES = max(
    1, int(float(os.environ.get("CLAP_REFRACTORY_MS", "150")) / 1000 * SAMPLE_RATE / FRAME)
)


class ClapDetector:
    """Detect CLAP_COUNT sharp claps within CLAP_WINDOW from int16 mic frames.

    A clap is a frame whose peak amplitude crosses the threshold after a brief
    quiet gap (refractory) — counted by onset, not duration. Claps older than
    the window roll off, so only a quick burst of N triggers."""

    def __init__(self) -> None:
        self.frame_idx = 0
        self.cooldown = 0
        self.claps: list[int] = []

    def reset(self) -> None:
        self.claps.clear()
        self.cooldown = 0

    def feed(self, i16: np.ndarray) -> bool:
        self.frame_idx += 1
        if self.cooldown > 0:
            self.cooldown -= 1
            return False
        if int(np.abs(i16).max()) >= CLAP_THRESHOLD:
            self.cooldown = CLAP_REFRACTORY_FRAMES
            self.claps.append(self.frame_idx)
            self.claps = [f for f in self.claps if self.frame_idx - f <= CLAP_WINDOW_FRAMES]
            if len(self.claps) >= CLAP_COUNT:
                self.claps.clear()
                return True
        return False


def require_env(key: str) -> str:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {key}")
    return value


BRAIN_URL = require_env("BRAIN_URL")
BASE_URL = BRAIN_URL.rsplit("/turn", 1)[0]    # e.g. http://127.0.0.1:8787


def brain_speaking() -> bool:
    resp = requests.get(f"{BASE_URL}/speaking", timeout=5)
    resp.raise_for_status()
    return bool(resp.json().get("speaking", False))


def stop_brain() -> None:
    requests.post(f"{BASE_URL}/stop", timeout=5).raise_for_status()


def notify_ui(event_type: str, via: str = "") -> None:
    """Best-effort ping so the dashboard lights up in real time (e.g. on clap).
    Never blocks or crashes the ears if the dashboard/brain isn't reachable."""
    try:
        body = {"type": event_type}
        if via:
            body["via"] = via
        requests.post(f"{BASE_URL}/event", json=body, timeout=2)
    except Exception:
        pass


# Bring the dashboard app to the front when you wake Jarvis ("open his screen").
# Set JARVIS_FOCUS_APP="" to disable, or to another app (e.g. "Safari").
FOCUS_APP = os.environ.get("JARVIS_FOCUS_APP", "Google Chrome")


def bring_dashboard_to_front() -> None:
    """Raise the browser window on wake so the HUD is visible. Best-effort, macOS."""
    if not FOCUS_APP:
        return
    try:
        subprocess.run(
            ["osascript", "-e", f'tell application "{FOCUS_APP}" to activate'],
            timeout=3, check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception:
        pass


def wait_for_trigger(
    wake: WakeModel, clap: ClapDetector, audio_q: "queue.Queue[np.ndarray]"
) -> str:
    """Block until the user either claps CLAP_COUNT times or says the wake word.
    Returns which trigger fired ("clap" or "wake")."""
    wake.reset()
    clap.reset()
    debug = os.environ.get("WAKE_DEBUG", "") not in ("", "0", "false")
    # openWakeWord is calibrated for 1280-sample (80 ms @ 16 kHz) chunks. Our mic
    # frames are 512 samples (Silero VAD's required size), which scores ~0 if fed
    # directly — so accumulate frames and predict on full 1280-sample windows.
    WAKE_CHUNK = 1280
    pending = np.empty(0, dtype=np.int16)
    win_max = 0.0       # running max for periodic debug reporting
    win_n = 0
    while True:
        samples = audio_q.get()[:, 0]                    # int16 mono
        if clap.feed(samples):
            return "clap"
        pending = np.concatenate((pending, samples))
        while pending.size >= WAKE_CHUNK:
            chunk, pending = pending[:WAKE_CHUNK], pending[WAKE_CHUNK:]
            score = wake.predict(chunk).get("hey_jarvis", 0.0)
            if debug:
                win_max = max(win_max, score)
                win_n += 1
                if win_n >= 12:   # ~1s of 80ms chunks → report the peak we saw
                    print(f"  [wake?] peak hey_jarvis={win_max:.3f} (threshold {WAKE_THRESHOLD})")
                    win_max, win_n = 0.0, 0
            if score >= WAKE_THRESHOLD:
                return "wake"


def record_until_silence(
    vad_model, audio_q: "queue.Queue[np.ndarray]"
) -> np.ndarray | None:
    vad = VADIterator(vad_model, sampling_rate=SAMPLE_RATE,
                      min_silence_duration_ms=900, speech_pad_ms=200)
    collected: list[np.ndarray] = []
    speech_started = False
    frames_seen = 0

    while True:
        i16 = audio_q.get()[:, 0]
        collected.append(i16)
        f32 = i16.astype(np.float32) / 32768.0
        event = vad(torch.from_numpy(f32))

        if event:
            if "start" in event:
                speech_started = True
            if "end" in event and speech_started:
                break

        frames_seen += 1
        if not speech_started and frames_seen >= START_TIMEOUT_FRAMES:
            vad.reset_states()
            return None                                  # nothing was said
        if frames_seen >= MAX_UTTERANCE_FRAMES:
            break

    vad.reset_states()
    return np.concatenate(collected).astype(np.float32) / 32768.0


def transcribe(stt: WhisperModel, audio: np.ndarray) -> str:
    segments, _ = stt.transcribe(
        audio,
        language=os.environ.get("WHISPER_LANG") or None,   # None = auto (handles Hinglish)
        beam_size=5,
    )
    return " ".join(seg.text for seg in segments).strip()


def post_transcript(text: str) -> str:
    resp = requests.post(BRAIN_URL, json={"text": text}, timeout=180)
    resp.raise_for_status()
    return resp.json().get("reply", "")


def monitor_for_bargein(
    vad_model, audio_q: "queue.Queue[np.ndarray]"
) -> np.ndarray | None:
    """While the brain is speaking, watch for the user cutting in. If they start
    talking, stop the brain's playback and capture what they say. Returns the
    interrupting audio, or None if the brain finished speaking uninterrupted.

    NOTE: without acoustic echo cancellation the mic also hears the speaker, so
    on open speakers this can self-trigger. Use a headset, or tune the VAD /
    add AEC, for reliable barge-in. (Needs real-audio testing to tune.)
    """
    # Drop frames buffered during the POST so we don't react to stale audio.
    while not audio_q.empty():
        try:
            audio_q.get_nowait()
        except queue.Empty:
            break

    vad = VADIterator(vad_model, threshold=BARGEIN_VAD_THRESHOLD,
                      sampling_rate=SAMPLE_RATE,
                      min_silence_duration_ms=900, speech_pad_ms=200)
    while brain_speaking():
        try:
            i16 = audio_q.get(timeout=0.2)[:, 0]
        except queue.Empty:
            continue
        f32 = i16.astype(np.float32) / 32768.0
        event = vad(torch.from_numpy(f32))
        if event and "start" in event:
            stop_brain()                       # cut off Jarvis mid-sentence
            vad.reset_states()
            print("  [barge-in] you interrupted.")
            return record_until_silence(vad_model, audio_q)
    vad.reset_states()
    return None


def main() -> None:
    wake = WakeModel(wakeword_models=["hey_jarvis"], inference_framework="onnx")
    clap = ClapDetector()
    vad_model = load_silero_vad()
    stt = WhisperModel(
        os.environ.get("WHISPER_MODEL", "large-v3"),
        device=os.environ.get("WHISPER_DEVICE", "cpu"),       # set "cuda" if you have a GPU
        compute_type=os.environ.get("WHISPER_COMPUTE", "int8"),
    )

    audio_q: "queue.Queue[np.ndarray]" = queue.Queue()

    def callback(indata, _frames, _time, status):
        if status:
            print(status, file=sys.stderr)
        audio_q.put(indata.copy())

    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                        blocksize=FRAME, callback=callback):
        print(
            f"{ASSISTANT_NAME} ears online. "
            f"Clap {CLAP_COUNT}x or say 'Hey Jarvis'."
        )
        while True:
            trigger = wait_for_trigger(wake, clap, audio_q)
            print(f"  [{trigger}] listening...")
            notify_ui("listening", via=trigger)   # dashboard lights up instantly
            bring_dashboard_to_front()            # "open his screen" on wake
            audio = record_until_silence(vad_model, audio_q)
            if audio is None:
                print("  [vad] heard nothing.")
                notify_ui("idle")
                continue
            notify_ui("transcribing")
            text = transcribe(stt, audio)
            if not text:
                notify_ui("idle")
                continue
            print(f"  you: {text}")
            reply = post_transcript(text)
            if reply:
                print(f"  jarvis: {reply}")

            # While Jarvis speaks, allow the user to cut in. Each interruption
            # continues the conversation; silence-through-playback returns us
            # to waiting for the wake word.
            while True:
                bargein = monitor_for_bargein(vad_model, audio_q)
                if bargein is None or bargein.size == 0:
                    break
                text = transcribe(stt, bargein)
                if not text:
                    break
                print(f"  you: {text}")
                reply = post_transcript(text)
                if reply:
                    print(f"  jarvis: {reply}")


if __name__ == "__main__":
    main()
