"""
content_agent — autonomous content/marketing pipeline for MARK XXXIX-OR.

Pipeline:  source (local folder) → edit (ffmpeg) → caption (OpenRouter) →
post (YouTube / Instagram / X-Twitter) → ledger.

It is built to actually run, every day, on its own — the same shape that grew
the app ~3x. Platform posting uses REAL APIs when credentials are present in
`config/api_keys.json` under the "content_agent" block; with no credentials each
adapter falls back to a clearly-labelled DRY-RUN so the rest of the pipeline
(source/edit/caption/ledger) still works end to end.

Entry points
------------
- content_agent(parameters, ...)             # tool dispatch (Gemini live + executor)
- python -m actions.content_agent post        # one-shot, for cron / Task Scheduler
- python -m actions.content_agent schedule    # blocking daily loop

Sub-actions (parameters["action"]):
    post_now        run the full pipeline once          (params: platforms, topic, clip)
    schedule_daily  start in-process daily scheduler     (params: time="HH:MM", platforms, topic)
    stop_schedule   stop the in-process scheduler
    status          ledger + schedule + pending clips
    list_clips      list available (unposted) clips

Config (config/api_keys.json → "content_agent"):
    {
      "clips_dir": "content/clips",
      "post_time": "10:00",
      "platforms": ["youtube", "instagram", "twitter"],
      "public_base_url": "",                # required for Instagram (must serve edited/ dir)
      "youtube":   {"client_id": "", "client_secret": "", "refresh_token": "",
                    "category_id": "22", "privacy": "public"},
      "instagram": {"ig_user_id": "", "access_token": ""},
      "twitter":   {"api_key": "", "api_secret": "",
                    "access_token": "", "access_secret": ""}
    }
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import quote, urlencode

import requests

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("content_agent")

# ── paths ─────────────────────────────────────────────────────────
BASE_DIR    = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config" / "api_keys.json"

VIDEO_EXTS  = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}
CHUNK_BYTES = 4 * 1024 * 1024   # 4 MB — Twitter chunked upload


# ── config ────────────────────────────────────────────────────────
def _cfg() -> dict:
    """The 'content_agent' block from api_keys.json (empty dict if absent)."""
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f).get("content_agent", {}) or {}
    except FileNotFoundError:
        return {}
    except Exception as e:
        log.warning("could not read content_agent config: %s", e)
        return {}


def _clips_dir() -> Path:
    d = BASE_DIR / _cfg().get("clips_dir", "content/clips")
    d.mkdir(parents=True, exist_ok=True)
    return d


def _edited_dir() -> Path:
    d = BASE_DIR / "content" / "edited"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _ledger_path() -> Path:
    p = BASE_DIR / "content" / "ledger.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


# ── ledger (what was posted, so we never repeat) ──────────────────
def _load_ledger() -> dict:
    try:
        with open(_ledger_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"posted": {}}


def _save_ledger(data: dict) -> None:
    with open(_ledger_path(), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


# ── source: pick the next unposted clip ───────────────────────────
def _available_clips() -> list[Path]:
    posted = set(_load_ledger().get("posted", {}).keys())
    clips = [
        p for p in sorted(_clips_dir().iterdir())
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS and p.name not in posted
    ]
    return clips


def _pick_clip(explicit: str = "") -> Optional[Path]:
    if explicit:
        cand = _clips_dir() / explicit
        return cand if cand.exists() else None
    clips = _available_clips()
    return clips[0] if clips else None


# ── edit: normalise to a 9:16 short via ffmpeg ────────────────────
def _edit_clip(src: Path) -> tuple[Path, str]:
    """Return (output_path, note). Falls back to the original if ffmpeg absent."""
    if not shutil.which("ffmpeg"):
        return src, "ffmpeg not found — posting source clip unedited"

    out = _edited_dir() / f"{src.stem}_short.mp4"
    vf = ("scale=-2:1920:force_original_aspect_ratio=increase,"
          "crop=1080:1920,fps=30,format=yuv420p")
    cmd = [
        "ffmpeg", "-y", "-i", str(src), "-t", "60",
        "-vf", vf, "-c:v", "libx264", "-preset", "veryfast",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
        str(out),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=600)
        return out, "edited to 1080x1920 / ≤60s"
    except Exception as e:
        log.warning("ffmpeg edit failed (%s) — using source", e)
        return src, f"edit failed ({e}) — posting source clip"


# ── caption: generate title/caption/hashtags via OpenRouter ───────
def _generate_copy(clip: Path, topic: str, platform: str) -> dict:
    fallback = {
        "title": clip.stem.replace("_", " ").title()[:90],
        "caption": (topic or clip.stem.replace("_", " ")).strip()[:200],
        "hashtags": ["#build", "#indiehackers", "#ai"],
    }
    try:
        from or_client import client
        prompt = (
            f"You are a growth marketer. Write a high-engagement {platform} post for a "
            f"short vertical video.\nVideo file: {clip.name}\n"
            f"Topic/context: {topic or 'app marketing clip'}\n"
            'Return ONLY JSON: {"title": str (<=90 chars), '
            '"caption": str (<=200 chars, 1 hook line), '
            '"hashtags": [str, ...] (3-6, no spaces)}'
        )
        data = client.chat_json(prompt)
        if isinstance(data, dict) and data.get("caption"):
            data.setdefault("title", fallback["title"])
            data.setdefault("hashtags", fallback["hashtags"])
            return data
    except Exception as e:
        log.warning("copy generation failed (%s) — using fallback", e)
    return fallback


def _full_caption(copy: dict) -> str:
    tags = " ".join(copy.get("hashtags", []))
    return f"{copy.get('caption','').strip()}\n\n{tags}".strip()


# ── adapter: YouTube (Data API v3, resumable upload via requests) ──
def _post_youtube(video: Path, copy: dict) -> tuple[bool, str]:
    c = _cfg().get("youtube", {})
    if not all(c.get(k) for k in ("client_id", "client_secret", "refresh_token")):
        return False, "youtube DRY-RUN (no oauth credentials)"
    try:
        tok = requests.post("https://oauth2.googleapis.com/token", data={
            "client_id": c["client_id"], "client_secret": c["client_secret"],
            "refresh_token": c["refresh_token"], "grant_type": "refresh_token",
        }, timeout=30)
        tok.raise_for_status()
        access = tok.json()["access_token"]

        meta = {
            "snippet": {
                "title": copy.get("title", video.stem)[:100],
                "description": _full_caption(copy)[:4900],
                "tags": [t.lstrip("#") for t in copy.get("hashtags", [])],
                "categoryId": str(c.get("category_id", "22")),
            },
            "status": {"privacyStatus": c.get("privacy", "public"),
                       "selfDeclaredMadeForKids": False},
        }
        size = video.stat().st_size
        init = requests.post(
            "https://www.googleapis.com/upload/youtube/v3/videos"
            "?uploadType=resumable&part=snippet,status",
            headers={"Authorization": f"Bearer {access}",
                     "Content-Type": "application/json; charset=UTF-8",
                     "X-Upload-Content-Type": "video/*",
                     "X-Upload-Content-Length": str(size)},
            data=json.dumps(meta), timeout=30,
        )
        init.raise_for_status()
        upload_url = init.headers["Location"]
        with open(video, "rb") as f:
            up = requests.put(upload_url, headers={"Content-Type": "video/*",
                              "Content-Length": str(size)}, data=f, timeout=1800)
        up.raise_for_status()
        vid = up.json().get("id", "?")
        return True, f"youtube OK → https://youtu.be/{vid}"
    except Exception as e:
        return False, f"youtube FAILED: {e}"


# ── adapter: Instagram Reels (Graph API; needs a public video URL) ─
def _post_instagram(video: Path, copy: dict) -> tuple[bool, str]:
    c = _cfg().get("instagram", {})
    base = _cfg().get("public_base_url", "").rstrip("/")
    if not all(c.get(k) for k in ("ig_user_id", "access_token")):
        return False, "instagram DRY-RUN (no credentials)"
    if not base:
        return False, ("instagram DRY-RUN (set content_agent.public_base_url to a host "
                       "that serves content/edited/ — IG pulls video by URL)")
    try:
        video_url = f"{base}/{video.name}"
        g = "https://graph.facebook.com/v21.0"
        create = requests.post(f"{g}/{c['ig_user_id']}/media", data={
            "media_type": "REELS", "video_url": video_url,
            "caption": _full_caption(copy), "access_token": c["access_token"],
        }, timeout=60)
        create.raise_for_status()
        cid = create.json()["id"]
        # IG must finish ingesting before publish — poll up to ~2.5 min.
        for _ in range(30):
            time.sleep(5)
            st = requests.get(f"{g}/{cid}", params={
                "fields": "status_code", "access_token": c["access_token"]}, timeout=30)
            if st.json().get("status_code") == "FINISHED":
                break
        pub = requests.post(f"{g}/{c['ig_user_id']}/media_publish", data={
            "creation_id": cid, "access_token": c["access_token"]}, timeout=60)
        pub.raise_for_status()
        return True, f"instagram OK → media {pub.json().get('id','?')}"
    except Exception as e:
        return False, f"instagram FAILED: {e}"


# ── adapter: X / Twitter (v1.1 chunked media upload + v2 tweet) ────
def _oauth1_header(method: str, url: str, c: dict, extra: Optional[dict] = None) -> str:
    oauth = {
        "oauth_consumer_key": c["api_key"],
        "oauth_nonce": uuid.uuid4().hex,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": c["access_token"],
        "oauth_version": "1.0",
    }
    sign_params = {**oauth, **(extra or {})}   # form params are signed; multipart/JSON are not
    enc = lambda s: quote(str(s), safe="~")
    pstr = "&".join(f"{enc(k)}={enc(v)}" for k, v in sorted(sign_params.items()))
    base = "&".join([method.upper(), enc(url), enc(pstr)])
    key = f"{enc(c['api_secret'])}&{enc(c['access_secret'])}"
    sig = base64.b64encode(hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()).decode()
    oauth["oauth_signature"] = sig
    return "OAuth " + ", ".join(f'{enc(k)}="{enc(v)}"' for k, v in sorted(oauth.items()))


def _post_twitter(video: Path, copy: dict) -> tuple[bool, str]:
    c = _cfg().get("twitter", {})
    if not all(c.get(k) for k in ("api_key", "api_secret", "access_token", "access_secret")):
        return False, "twitter DRY-RUN (no credentials)"
    try:
        up = "https://upload.twitter.com/1.1/media/upload.json"
        size = video.stat().st_size
        # INIT (form-encoded → params are signed)
        init_p = {"command": "INIT", "total_bytes": str(size),
                  "media_type": "video/mp4", "media_category": "tweet_video"}
        r = requests.post(up, data=init_p, timeout=60,
                          headers={"Authorization": _oauth1_header("POST", up, c, init_p)})
        r.raise_for_status()
        media_id = r.json()["media_id_string"]
        # APPEND (multipart → only oauth params signed)
        with open(video, "rb") as f:
            idx = 0
            while True:
                chunk = f.read(CHUNK_BYTES)
                if not chunk:
                    break
                requests.post(up, timeout=120,
                    headers={"Authorization": _oauth1_header("POST", up, c)},
                    data={"command": "APPEND", "media_id": media_id, "segment_index": str(idx)},
                    files={"media": chunk}).raise_for_status()
                idx += 1
        # FINALIZE (form-encoded)
        fin_p = {"command": "FINALIZE", "media_id": media_id}
        fr = requests.post(up, data=fin_p, timeout=60,
                           headers={"Authorization": _oauth1_header("POST", up, c, fin_p)})
        fr.raise_for_status()
        # STATUS poll while processing
        info = fr.json().get("processing_info")
        while info and info.get("state") in ("pending", "in_progress"):
            time.sleep(info.get("check_after_secs", 5))
            st_p = {"command": "STATUS", "media_id": media_id}
            sr = requests.get(up, params=st_p, timeout=30,
                              headers={"Authorization": _oauth1_header("GET", up, c, st_p)})
            info = sr.json().get("processing_info")
        if info and info.get("state") == "failed":
            return False, f"twitter FAILED: media processing {info}"
        # v2 tweet (JSON body → only oauth params signed)
        tw = "https://api.twitter.com/2/tweets"
        tr = requests.post(tw, timeout=60,
            headers={"Authorization": _oauth1_header("POST", tw, c),
                     "Content-Type": "application/json"},
            data=json.dumps({"text": _full_caption(copy)[:280],
                             "media": {"media_ids": [media_id]}}))
        tr.raise_for_status()
        return True, f"twitter OK → tweet {tr.json().get('data',{}).get('id','?')}"
    except Exception as e:
        return False, f"twitter FAILED: {e}"


_ADAPTERS: dict[str, Callable[[Path, dict], tuple[bool, str]]] = {
    "youtube":   _post_youtube,
    "instagram": _post_instagram,
    "twitter":   _post_twitter,
}


# ── pipeline ──────────────────────────────────────────────────────
def _say(speak: Optional[Callable], msg: str) -> None:
    log.info(msg)
    if speak:
        try:
            speak(msg)
        except Exception:
            pass


def run_pipeline(platforms: Optional[list[str]] = None, topic: str = "",
                 clip: str = "", speak: Optional[Callable] = None) -> str:
    platforms = platforms or _cfg().get("platforms", ["youtube", "instagram", "twitter"])
    platforms = [p.lower().strip() for p in platforms if p.lower().strip() in _ADAPTERS]

    src = _pick_clip(clip)
    if not src:
        return (f"No new clips to post. Drop video files into {_clips_dir()} "
                f"(already-posted clips are skipped).")

    _say(speak, f"Content agent: preparing '{src.name}' for {', '.join(platforms)}.")
    edited, edit_note = _edit_clip(src)

    results: dict[str, str] = {}
    for plat in platforms:
        copy = _generate_copy(src, topic, plat)
        ok, msg = _ADAPTERS[plat](edited, copy)
        results[plat] = msg
        _say(speak, msg)

    # Ledger it (even dry-runs, so the queue advances and you can audit the run).
    ledger = _load_ledger()
    ledger["posted"][src.name] = {
        "at": datetime.now().isoformat(timespec="seconds"),
        "edited": edited.name, "edit_note": edit_note,
        "platforms": results,
    }
    _save_ledger(ledger)

    lines = [f"Content agent ran on '{src.name}' ({edit_note}):"]
    lines += [f"  • {p}: {m}" for p, m in results.items()]
    remaining = len(_available_clips())
    lines.append(f"{remaining} clip(s) left in the queue.")
    return "\n".join(lines)


# ── scheduler (in-process daily loop) ─────────────────────────────
_sched_thread: Optional[threading.Thread] = None
_sched_stop = threading.Event()
_sched_info: dict = {}


def _seconds_until(hhmm: str) -> float:
    now = datetime.now()
    try:
        h, m = (int(x) for x in hhmm.split(":"))
    except Exception:
        h, m = 10, 0
    nxt = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if nxt <= now:
        nxt += timedelta(days=1)
    return (nxt - now).total_seconds()


def start_scheduler(post_time: str = "", platforms: Optional[list[str]] = None,
                    topic: str = "", speak: Optional[Callable] = None) -> str:
    global _sched_thread
    if _sched_thread and _sched_thread.is_alive():
        return f"Scheduler already running (daily at {_sched_info.get('time')})."
    post_time = post_time or _cfg().get("post_time", "10:00")
    _sched_stop.clear()
    _sched_info.update({"time": post_time, "platforms": platforms, "topic": topic})

    def _loop() -> None:
        while not _sched_stop.is_set():
            wait = _seconds_until(post_time)
            log.info("content agent sleeping %.0fs until next run (%s)", wait, post_time)
            if _sched_stop.wait(wait):
                break
            try:
                run_pipeline(platforms, topic, speak=speak)
            except Exception as e:
                log.error("scheduled run failed: %s", e)
            _sched_stop.wait(60)   # avoid double-fire within the same minute

    _sched_thread = threading.Thread(target=_loop, daemon=True, name="content-agent-sched")
    _sched_thread.start()
    return f"Content agent scheduled — daily at {post_time} for {platforms or 'configured platforms'}."


def stop_scheduler() -> str:
    if not (_sched_thread and _sched_thread.is_alive()):
        return "Scheduler is not running."
    _sched_stop.set()
    return "Content agent schedule stopped."


def platform_readiness() -> dict:
    """Which platforms are wired for REAL posting vs dry-run (for the dashboard)."""
    cfg = _cfg()
    yt, ig, tw = cfg.get("youtube", {}), cfg.get("instagram", {}), cfg.get("twitter", {})
    openrouter = False
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            openrouter = bool(json.load(f).get("openrouter_api_key"))
    except Exception:
        pass
    return {
        "youtube":   all(yt.get(k) for k in ("client_id", "client_secret", "refresh_token")),
        "instagram": bool(ig.get("ig_user_id") and ig.get("access_token") and cfg.get("public_base_url")),
        "twitter":   all(tw.get(k) for k in ("api_key", "api_secret", "access_token", "access_secret")),
        "ffmpeg":    bool(shutil.which("ffmpeg")),
        "captions":  openrouter,
    }


def schedule_state() -> dict:
    running = bool(_sched_thread and _sched_thread.is_alive())
    return {"running": running, "time": _sched_info.get("time") if running else None}


def _status() -> str:
    ledger = _load_ledger().get("posted", {})
    sched = (f"daily at {_sched_info.get('time')}"
             if _sched_thread and _sched_thread.is_alive() else "not running")
    return (f"Content agent status:\n"
            f"  schedule: {sched}\n"
            f"  posted:   {len(ledger)} clip(s)\n"
            f"  queue:    {len(_available_clips())} clip(s) waiting in {_clips_dir()}")


# ── tool entry point ──────────────────────────────────────────────
def content_agent(parameters: dict, response=None, player=None,
                  session_memory=None, speak: Optional[Callable] = None) -> str:
    parameters = parameters or {}
    action = (parameters.get("action") or "post_now").lower()
    plats = parameters.get("platforms")
    if isinstance(plats, str):
        plats = [p.strip() for p in plats.replace(",", " ").split() if p.strip()]
    topic = parameters.get("topic", "")
    speak = speak or (getattr(player, "speak", None) if player else None)

    if action in ("post_now", "post", "run"):
        return run_pipeline(plats, topic, parameters.get("clip", ""), speak)
    if action in ("schedule_daily", "schedule"):
        return start_scheduler(parameters.get("time", ""), plats, topic, speak)
    if action in ("stop_schedule", "stop"):
        return stop_scheduler()
    if action in ("dashboard", "open_dashboard", "ui", "hud"):
        try:
            from actions.content_agent_server import serve
            port = int(parameters.get("port", 8799))
            threading.Thread(target=lambda: serve(port, open_browser=True),
                             daemon=True, name="content-agent-hud").start()
            return f"Content agent HUD is live at http://127.0.0.1:{port}"
        except Exception as e:
            return f"Could not start the dashboard: {e}"
    if action in ("auth", "connect", "login"):
        platform = (parameters.get("platform") or parameters.get("platforms") or "")
        if isinstance(platform, (list, tuple)):
            platform = platform[0] if platform else ""
        from actions.content_auth import auth
        # Interactive (opens a browser, waits for redirect) — run off the caller's thread.
        threading.Thread(target=lambda: log.info("auth: %s", auth(str(platform))),
                         daemon=True, name="content-auth").start()
        return f"Opening the {platform or 'platform'} authorization in your browser…"
    if action == "status":
        return _status()
    if action == "list_clips":
        clips = _available_clips()
        return ("Unposted clips:\n" + "\n".join(f"  • {c.name}" for c in clips)
                if clips else f"No unposted clips in {_clips_dir()}.")
    return f"Unknown content_agent action: {action}"


# ── CLI (for cron / Windows Task Scheduler / manual) ──────────────
if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "post"
    plat_arg = sys.argv[2].split(",") if len(sys.argv) > 2 else None
    if cmd == "serve":
        from actions.content_agent_server import serve
        serve(int(sys.argv[2]) if len(sys.argv) > 2 else 8799)
    elif cmd == "auth":
        from actions.content_auth import auth
        print(auth(sys.argv[2] if len(sys.argv) > 2 else ""))
    elif cmd in ("schedule", "schedule_daily"):
        print(start_scheduler(platforms=plat_arg))
        try:
            while _sched_thread and _sched_thread.is_alive():
                time.sleep(3600)
        except KeyboardInterrupt:
            print(stop_scheduler())
    else:
        print(content_agent({"action": cmd, "platforms": plat_arg}))
