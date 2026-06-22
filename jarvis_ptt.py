"""
JARVIS — push-to-talk (v1).

The simplest way to actually talk to Jarvis: no wake word, no VAD.
Press Enter to start speaking, press Enter again to stop. The clip is
transcribed locally (faster-whisper) and POSTed to the brain, which thinks,
acts, and speaks the reply.

This is the "make it talk" milestone. For always-on listening, use jarvis_ears.py.

Rules: no fallbacks. Missing config or a failed request crashes loudly.

Install (shared with the ears):
    pip install -r requirements.txt
Run (brain must be up first):
    BRAIN_URL=http://127.0.0.1:8787/turn python jarvis_ptt.py
"""

from __future__ import annotations  # lazy annotations — `X | None` works on 3.9+

import os
import sys

import numpy as np
import requests
import sounddevice as sd
from faster_whisper import WhisperModel

SAMPLE_RATE = 16_000


def require_env(key: str) -> str:
    value = os.environ.get(key)
    if not value:
        raise RuntimeError(f"Missing required environment variable: {key}")
    return value


BRAIN_URL = require_env("BRAIN_URL")


def record_between_enter() -> np.ndarray | None:
    """Record from the mic until the user presses Enter. Returns float32 mono audio."""
    frames: list[np.ndarray] = []

    def callback(indata, _frames, _time, status):
        if status:
            print(status, file=sys.stderr)
        frames.append(indata.copy())

    input("\nPress Enter to start speaking…")
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16",
                        callback=callback):
        input("🎙  Recording… press Enter to stop.")

    if not frames:
        return None
    audio = np.concatenate(frames)[:, 0]
    return audio.astype(np.float32) / 32768.0


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


def main() -> None:
    stt = WhisperModel(
        os.environ.get("WHISPER_MODEL", "large-v3"),
        device=os.environ.get("WHISPER_DEVICE", "cpu"),      # "cuda" if you have a GPU
        compute_type=os.environ.get("WHISPER_COMPUTE", "int8"),
    )
    print(f"Jarvis push-to-talk ready. Brain: {BRAIN_URL}")
    print("Ctrl-C to quit.")

    while True:
        try:
            audio = record_between_enter()
            if audio is None or audio.size == 0:
                print("  (heard nothing)")
                continue
            text = transcribe(stt, audio)
            if not text:
                print("  (no speech detected)")
                continue
            print(f"  you: {text}")
            reply = post_transcript(text)        # brain speaks the reply itself
            if reply:
                print(f"  jarvis: {reply}")
        except KeyboardInterrupt:
            print("\nBye.")
            return


if __name__ == "__main__":
    main()
