"""
content_agent_server — local Jarvis HUD control panel for the content agent.

Serves a single-page dashboard (public/content_agent.html) and a small JSON API
that drives the real pipeline in actions/content_agent.py. Stdlib only.

Security posture (localhost single-user control plane, OWASP-aligned):
  • Binds to 127.0.0.1 only — never exposed off-host.
  • Host header allow-list — blocks DNS-rebinding.
  • Per-process CSRF token injected into the HUD and required on every /api call —
    a malicious web page in the browser cannot read it, so it cannot forge
    state-changing requests (post/schedule/stop).
  • Origin/Referer checked on mutating requests.
  • Token-bucket rate limiting per (IP + token), graceful 429 + Retry-After.
  • Strict schema validation on all request bodies (type/length/choices, no
    unexpected fields).
  • Request-body size cap (413) and hardening response headers.

Run:   python -m actions.content_agent serve [port]
       (or: python -m actions.content_agent_server [port])
Then open http://127.0.0.1:8799
"""
from __future__ import annotations

import json
import logging
import threading
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from actions import content_agent as ca
from actions import security as sec
from actions.security import Field, ValidationError

BASE_DIR  = Path(__file__).resolve().parent.parent
HTML_PATH = BASE_DIR / "public" / "content_agent.html"

# ── limits ────────────────────────────────────────────────────────
MAX_BODY_BYTES = 16 * 1024            # 16 KB — request bodies are tiny JSON
_PLATFORMS     = ("youtube", "instagram", "twitter")
_HHMM          = r"([01]?\d|2[0-3]):[0-5]\d"

# Read-heavy: the HUD polls /api/state ~every 1.5s (40/min). Allow comfortable
# burst + sustained headroom. Writes are deliberately strict.
_LIMITS = {
    "read":     sec.RateLimiter(capacity=80,  refill_per_sec=2.0),    # ~120/min
    "post":     sec.RateLimiter(capacity=6,   refill_per_sec=0.1),    # ~6/min
    "schedule": sec.RateLimiter(capacity=12,  refill_per_sec=0.2),    # ~12/min
    "auth":     sec.RateLimiter(capacity=6,   refill_per_sec=0.1),    # ~6/min
}

# Which limiter bucket each mutating endpoint draws from.
_BUCKET = {"/api/post": "post", "/api/schedule": "schedule",
           "/api/stop": "schedule", "/api/auth": "auth"}

# Brute-force lockout for the session token, keyed by client IP: 10 bad tokens
# within 60s -> 5-minute lockout. A correct token always passes (see
# _require_session), so a legitimate user is never locked out by an attacker.
_BRUTE = sec.BruteForceGuard(max_failures=10, window_sec=60.0, lockout_sec=300.0)

# Per-endpoint request schemas (strict allow-list; unknown fields rejected).
_SCHEMAS = {
    "/api/post": {
        "platforms": Field(list, max_len=3, item_choices=_PLATFORMS),
        "topic":     Field(str,  max_len=300),
    },
    "/api/schedule": {
        "time":      Field(str,  regex=_HHMM),
        "platforms": Field(list, max_len=3, item_choices=_PLATFORMS),
        "topic":     Field(str,  max_len=300),
    },
    "/api/stop": {},
    "/api/auth": {
        "platform": Field(str, required=True, choices=_PLATFORMS),
    },
}

# ── live log ring buffer (feeds the HUD's log stream) ─────────────
_LOG: "deque[dict]" = deque(maxlen=200)


class _RingHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        _LOG.append({"level": record.levelname, "msg": record.getMessage(),
                     "t": int(record.created)})


ca.log.addHandler(_RingHandler())
ca.log.setLevel(logging.INFO)

# ── run state (so the HUD can show a post in progress) ────────────
_run = {"active": False, "last": "", "stage": "idle"}
# auth state (so the HUD can show a browser OAuth connect in progress)
_auth = {"active": False, "platform": "", "last": ""}


def _do_post(platforms, topic):
    _run.update(active=True, stage="running", last="")
    try:
        _run["last"] = ca.run_pipeline(platforms or None, topic or "")
    except Exception as e:
        _run["last"] = f"Run failed: {e}"
        ca.log.error("dashboard run failed: %s", e)
    finally:
        _run.update(active=False, stage="idle")


def _do_auth(platform):
    _auth.update(active=True, platform=platform, last="")
    try:
        from actions.content_auth import auth
        msg = auth(platform)
        _auth["last"] = msg
        ca.log.info("auth(%s): %s", platform, msg)
    except Exception as e:
        _auth["last"] = f"{platform} auth error: {e}"
        ca.log.error("auth(%s) failed: %s", platform, e)
    finally:
        _auth.update(active=False)


def _state() -> dict:
    ledger = ca._load_ledger().get("posted", {})
    recent = [{"clip": k, **v} for k, v in sorted(
        ledger.items(), key=lambda kv: kv[1].get("at", ""), reverse=True)][:8]
    return {
        "schedule":  ca.schedule_state(),
        "readiness": ca.platform_readiness(),     # booleans only — never secrets
        "queue":     [p.name for p in ca._available_clips()],
        "posted":    len(ledger),
        "recent":    recent,
        "clips_dir": str(ca._clips_dir()),
        "run":       dict(_run),
        "auth":      dict(_auth),
        "logs":      list(_LOG)[-60:],
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "JarvisHUD"      # don't advertise Python/version
    sys_version = ""
    port: int = 8799                  # set by serve()

    def log_message(self, *a):        # silence default stderr spam
        pass

    # ── low-level response helpers ────────────────────────────────
    def _headers(self, code, ctype, length):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        # Hardening headers — this is a local tool, lock the browser down.
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy",
                         "default-src 'none'; style-src 'unsafe-inline'; "
                         "script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:")

    def _send(self, code, body, ctype="application/json", retry_after=None):
        data = body.encode() if isinstance(body, str) else body
        self._headers(code, ctype, len(data))
        if retry_after is not None:
            self.send_header("Retry-After", str(retry_after))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _json(self, obj, code=200, retry_after=None):
        self._send(code, json.dumps(obj), "application/json", retry_after)

    def _err(self, code, msg, retry_after=None):
        self._json({"ok": False, "error": msg}, code, retry_after)

    # ── shared guards ─────────────────────────────────────────────
    def _client_ip(self) -> str:
        return self.client_address[0] if self.client_address else "?"

    def _client_key(self) -> str:
        tok = self.headers.get("X-CSRF-Token", "")[:64]
        return f"{self._client_ip()}:{tok}"

    def _host_ok(self) -> bool:
        return sec.host_allowed(self.headers.get("Host", ""), self.port)

    def _csrf_ok(self) -> bool:
        return sec.constant_time_eq(self.headers.get("X-CSRF-Token", ""), sec.SESSION_TOKEN)

    def _require_session(self) -> bool:
        """Validate the session token with brute-force lockout.

        A valid token always passes and clears the IP's failure history. An
        invalid token is counted; once the IP trips the threshold it gets a
        graceful 429 lockout — so token guessing is throttled, while the real
        page (which holds the token) is never affected."""
        ip = self._client_ip()
        if self._csrf_ok():
            _BRUTE.register_success(ip)
            return True
        locked, retry = _BRUTE.is_locked(ip)
        _BRUTE.register_failure(ip)
        if locked:
            self._err(429, "Too many invalid attempts — temporarily locked out.",
                      retry_after=retry)
        else:
            self._err(403, "Missing or invalid session token.")
        return False

    def _rate_ok(self, bucket: str) -> bool:
        ok, retry = _LIMITS[bucket].check(self._client_key())
        if not ok:
            self._err(429, "Too many requests — slow down.", retry_after=retry)
        return ok

    def _read_body(self) -> dict | None:
        """Length-capped JSON body read. Returns None after sending an error."""
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n > MAX_BODY_BYTES:
            self._err(413, "Request body too large.")
            return None
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except Exception:
            self._err(400, "Body must be valid JSON.")
            return None

    # ── GET ───────────────────────────────────────────────────────
    def do_GET(self):
        if not self._host_ok():
            return self._err(403, "Forbidden host.")
        path = urlparse(self.path).path

        if path in ("/", "/index.html"):
            # The dashboard is the one origin that legitimately receives the
            # CSRF token — injected here so same-origin JS can echo it back.
            try:
                html = HTML_PATH.read_text(encoding="utf-8")
            except FileNotFoundError:
                return self._err(404, "dashboard html not found")
            html = html.replace("__CSRF_TOKEN__", sec.SESSION_TOKEN)
            return self._send(200, html, "text/html; charset=utf-8")

        if path == "/api/state":
            if not self._require_session():
                return
            if not self._rate_ok("read"):
                return
            return self._json(_state())

        return self._err(404, "not found")

    # ── POST ──────────────────────────────────────────────────────
    def do_POST(self):
        if not self._host_ok():
            return self._err(403, "Forbidden host.")
        path = urlparse(self.path).path
        if path not in _SCHEMAS:
            return self._err(404, "unknown endpoint")

        # CSRF + brute-force: valid same-origin token required for every mutation.
        if not self._require_session():
            return
        # Defence in depth: reject cross-origin Origin/Referer if present.
        if not (sec.origin_allowed(self.headers.get("Origin", ""), self.port)
                and sec.origin_allowed(self.headers.get("Referer", ""), self.port)):
            return self._err(403, "Cross-origin request blocked.")

        if not self._rate_ok(_BUCKET[path]):
            return

        body = self._read_body()
        if body is None:
            return
        try:
            data = sec.validate_schema(body, _SCHEMAS[path])
        except ValidationError as e:
            return self._err(422, f"Invalid input: {e}")

        plats = data.get("platforms")
        topic = data.get("topic", "")

        if path == "/api/post":
            if _run["active"]:
                return self._err(409, "A run is already in progress.")
            threading.Thread(target=_do_post, args=(plats, topic), daemon=True).start()
            return self._json({"ok": True, "msg": "Pipeline started."})
        if path == "/api/schedule":
            msg = ca.start_scheduler(data.get("time", ""), plats, topic)
            return self._json({"ok": True, "msg": msg})
        if path == "/api/stop":
            return self._json({"ok": True, "msg": ca.stop_scheduler()})
        if path == "/api/auth":
            if _auth["active"]:
                return self._err(409, f"Already connecting {_auth['platform']} — "
                                      "finish it in the browser tab.")
            threading.Thread(target=_do_auth, args=(data["platform"],), daemon=True).start()
            return self._json({"ok": True,
                               "msg": f"Opening {data['platform']} authorization in your browser…"})


def serve(port: int = 8799, open_browser: bool = True) -> None:
    Handler.port = port
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}"
    print(f"[content-agent] Jarvis HUD live → {url}")
    print("[content-agent] CSRF token bound to this process; only the served "
          "page can drive the API.")
    if open_browser:
        try:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        except Exception:
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[content-agent] HUD stopped.")
        httpd.shutdown()


if __name__ == "__main__":
    import sys
    serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8799)
