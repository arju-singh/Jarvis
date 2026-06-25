"""
content_auth — one-command OAuth bootstrap for the content agent.

Turns a freshly-configured app (client id/secret only) into a posting-ready one
by running the interactive consent flow locally and writing the resulting
long-lived tokens back into config/api_keys.json (hardened to 0600).

    python -m actions.content_agent auth youtube
    python -m actions.content_agent auth twitter
    python -m actions.content_agent auth instagram

Each flow opens your browser, captures the redirect on a loopback server, and
persists ONLY the long-lived credential (refresh_token / access tokens). No
secret is printed. Stdlib + requests only.

Prerequisites you create once at the provider (cannot be automated):
  • YouTube   — a Google Cloud OAuth *Desktop* client → client_id + client_secret.
  • Twitter   — an X app with OAuth1 enabled → api_key + api_secret (consumer).
  • Instagram — a Meta app + a short-lived user access_token + the app secret.
Put those in config/api_keys.json (content_agent block) first; this fills in the rest.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlparse

import requests

BASE_DIR    = Path(__file__).resolve().parent.parent
CONFIG_PATH = BASE_DIR / "config" / "api_keys.json"

_DONE_HTML = (b"<!doctype html><meta charset=utf-8>"
              b"<body style='background:#00060a;color:#00d4ff;font-family:monospace;"
              b"text-align:center;padding-top:18%'>"
              b"<h2>\xe2\x9c\x94 MARK XXXIX-OR \xe2\x80\x94 authorized.</h2>"
              b"<p>You can close this tab and return to the terminal.</p>")


# ── config read/merge/write (preserves structure, hardens perms) ──
def _load_cfg() -> dict:
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def _save_creds(platform: str, creds: dict) -> None:
    """Merge creds into config_agent[platform] and write 0600."""
    cfg = _load_cfg()
    ca = cfg.setdefault("content_agent", {})
    block = ca.setdefault(platform, {})
    block.update(creds)
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    try:
        CONFIG_PATH.chmod(0o600)
    except Exception:
        pass


def _platform_cfg(platform: str) -> dict:
    return _load_cfg().get("content_agent", {}).get(platform, {})


# ── loopback redirect capture ─────────────────────────────────────
def _capture_redirect(expect_path: str = "/") -> tuple[int, dict]:
    """Start a one-shot loopback server; return (port, captured_query_params).

    Blocks until the provider redirects back with the auth code (or up to 5 min).
    """
    captured: dict = {}
    done = threading.Event()

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path != expect_path:
                self.send_response(404); self.end_headers(); return
            captured.update({k: v[0] for k, v in parse_qs(parsed.query).items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(_DONE_HTML)
            done.set()

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)   # port 0 → OS picks free port
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    def _wait():
        done.wait(timeout=300)
        httpd.shutdown()

    return port, {"_httpd_wait": _wait, "_captured": captured, "_done": done}


# ── YouTube (OAuth2 desktop, offline → refresh_token) ─────────────
_YT_SCOPE = "https://www.googleapis.com/auth/youtube.upload"


def auth_youtube() -> str:
    c = _platform_cfg("youtube")
    cid, csec = c.get("client_id"), c.get("client_secret")
    if not (cid and csec):
        return ("YouTube needs client_id + client_secret first. Create a Google Cloud "
                "OAuth *Desktop* client and add them to config/api_keys.json "
                "(content_agent.youtube).")

    port, ctl = _capture_redirect("/")
    redirect_uri = f"http://127.0.0.1:{port}/"
    state = secrets.token_urlsafe(16)
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({
        "client_id": cid, "redirect_uri": redirect_uri, "response_type": "code",
        "scope": _YT_SCOPE, "access_type": "offline", "prompt": "consent",
        "state": state,
    })
    print("\n[auth:youtube] Opening browser to authorize…")
    webbrowser.open(url)
    ctl["_httpd_wait"]()
    got = ctl["_captured"]
    if got.get("state") != state:
        return "YouTube auth failed: state mismatch (possible CSRF) — try again."
    if "code" not in got:
        return f"YouTube auth failed: {got.get('error', 'no code returned')}."

    tok = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": cid, "client_secret": csec, "code": got["code"],
        "grant_type": "authorization_code", "redirect_uri": redirect_uri,
    }, timeout=30)
    if not tok.ok:
        return f"YouTube token exchange failed: {tok.status_code} {tok.text[:160]}"
    refresh = tok.json().get("refresh_token")
    if not refresh:
        return ("YouTube returned no refresh_token (already granted?). Revoke this app's "
                "access in your Google account and re-run to force a fresh consent.")
    _save_creds("youtube", {"refresh_token": refresh})
    return "✓ YouTube connected — refresh_token saved. Posts will now upload for real."


# ── Twitter / X (OAuth1 3-legged → access token + secret) ─────────
def _oauth1(method: str, url: str, consumer_key: str, consumer_secret: str,
            token: str = "", token_secret: str = "", extra: dict | None = None) -> str:
    oauth = {
        "oauth_consumer_key": consumer_key,
        "oauth_nonce": uuid.uuid4().hex,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_version": "1.0",
    }
    if token:
        oauth["oauth_token"] = token
    params = {**oauth, **(extra or {})}
    enc = lambda s: quote(str(s), safe="~")
    pstr = "&".join(f"{enc(k)}={enc(v)}" for k, v in sorted(params.items()))
    base = "&".join([method.upper(), enc(url), enc(pstr)])
    key = f"{enc(consumer_secret)}&{enc(token_secret)}"
    oauth["oauth_signature"] = base64.b64encode(
        hmac.new(key.encode(), base.encode(), hashlib.sha1).digest()).decode()
    return "OAuth " + ", ".join(f'{enc(k)}="{enc(v)}"' for k, v in sorted(oauth.items()))


def auth_twitter() -> str:
    c = _platform_cfg("twitter")
    ck, cs = c.get("api_key"), c.get("api_secret")
    if not (ck and cs):
        return ("Twitter needs api_key + api_secret (consumer keys) first — add them to "
                "config/api_keys.json (content_agent.twitter).")

    port, ctl = _capture_redirect("/")
    callback = f"http://127.0.0.1:{port}/"
    # 1) request token
    rt_url = "https://api.twitter.com/oauth/request_token"
    hdr = _oauth1("POST", rt_url, ck, cs, extra={"oauth_callback": callback})
    r = requests.post(rt_url, headers={"Authorization": hdr}, timeout=30)
    if not r.ok:
        return f"Twitter request_token failed: {r.status_code} {r.text[:160]}"
    rtok = parse_qs(r.text)
    oauth_token = rtok["oauth_token"][0]
    oauth_token_secret = rtok["oauth_token_secret"][0]
    # 2) authorize
    print("\n[auth:twitter] Opening browser to authorize…")
    webbrowser.open(f"https://api.twitter.com/oauth/authorize?oauth_token={oauth_token}")
    ctl["_httpd_wait"]()
    got = ctl["_captured"]
    if "oauth_verifier" not in got:
        return f"Twitter auth failed: {got.get('denied', 'no verifier returned')}."
    # 3) access token
    at_url = "https://api.twitter.com/oauth/access_token"
    hdr = _oauth1("POST", at_url, ck, cs, token=oauth_token, token_secret=oauth_token_secret,
                  extra={"oauth_verifier": got["oauth_verifier"]})
    a = requests.post(at_url, headers={"Authorization": hdr},
                      data={"oauth_verifier": got["oauth_verifier"]}, timeout=30)
    if not a.ok:
        return f"Twitter access_token failed: {a.status_code} {a.text[:160]}"
    at = parse_qs(a.text)
    _save_creds("twitter", {"access_token": at["oauth_token"][0],
                            "access_secret": at["oauth_token_secret"][0]})
    return f"✓ Twitter connected as @{at.get('screen_name', ['?'])[0]} — access tokens saved."


# ── Instagram (short-lived → long-lived token, ~60 days) ──────────
def auth_instagram() -> str:
    c = _platform_cfg("instagram")
    short, app_secret = c.get("access_token"), c.get("app_secret")
    if not short:
        return ("Instagram: put a short-lived user access_token (from Meta Graph API "
                "Explorer) in content_agent.instagram.access_token, plus the app secret "
                "in content_agent.instagram.app_secret, then re-run.")
    if not app_secret:
        return "Instagram needs content_agent.instagram.app_secret to exchange for a long-lived token."
    r = requests.get("https://graph.facebook.com/v21.0/oauth/access_token", params={
        "grant_type": "fb_exchange_token", "client_secret": app_secret,
        "fb_exchange_token": short,
        "client_id": c.get("app_id", ""),
    }, timeout=30)
    if not r.ok:
        return f"Instagram token exchange failed: {r.status_code} {r.text[:160]}"
    long = r.json().get("access_token")
    if not long:
        return "Instagram exchange returned no token — check app_id/app_secret."
    _save_creds("instagram", {"access_token": long})
    return ("✓ Instagram long-lived token saved (~60 days). Remember to set "
            "content_agent.public_base_url so Reels can be pulled by URL.")


_FLOWS = {"youtube": auth_youtube, "twitter": auth_twitter, "instagram": auth_instagram}


def auth(platform: str = "") -> str:
    platform = (platform or "").lower().strip()
    if platform not in _FLOWS:
        return f"Usage: auth <{ ' | '.join(_FLOWS) }>"
    try:
        return _FLOWS[platform]()
    except Exception as e:
        return f"{platform} auth error: {e}"
