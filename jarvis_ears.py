"""
JARVIS — offline ears.

Pipeline:  mic -> wake word ("Hey Jarvis") -> VAD (end of speech)
           -> faster-whisper transcription -> POST to brain.

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


def wait_for_wake(wake: WakeModel, audio_q: "queue.Queue[np.ndarray]") -> None:
    wake.reset()
    while True:
        samples = audio_q.get()[:, 0]                    # int16 mono
        scores = wake.predict(samples)
        if scores.get("hey_jarvis", 0.0) >= WAKE_THRESHOLD:
            return


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
        print("Jarvis ears online. Say 'Hey Jarvis'.")
        while True:
            wait_for_wake(wake, audio_q)
            print("  [wake] listening...")
            audio = record_until_silence(vad_model, audio_q)
            if audio is None:
                print("  [vad] heard nothing.")
                continue
            text = transcribe(stt, audio)
            if not text:
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
