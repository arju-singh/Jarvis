"""
security — reusable, dependency-free hardening primitives for the local HTTP
control surfaces (content_agent_server.py, and usable by any future Python
endpoint).

Implements, per OWASP guidance for a localhost single-user control plane:
  • RateLimiter         — token-bucket limiter keyed by (IP + session token).
  • validate_schema     — strict allow-list schema validation (type / length /
                          choices / regex), rejecting unexpected fields.
  • CSRF / origin guards — per-process token + Host/Origin allow-listing to stop
                          DNS-rebinding and a malicious web page in the user's
                          browser from forging requests to 127.0.0.1.
  • constant_time_eq    — timing-safe token comparison.

Everything is in-memory and stdlib-only — no new dependencies, nothing that can
leak secrets, and safe to import from anywhere.
"""
from __future__ import annotations

import hmac
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional
from urllib.parse import urlparse

# ── CSRF / session token ──────────────────────────────────────────
# One random token per server process. It is injected into the served HTML so
# the same-origin page can send it back; cross-origin pages cannot read it, so
# they cannot forge state-changing requests (CSRF defence).
SESSION_TOKEN: str = secrets.token_urlsafe(32)


def constant_time_eq(a: str, b: str) -> bool:
    """Timing-safe string compare (avoids leaking token length/prefix)."""
    return hmac.compare_digest((a or "").encode(), (b or "").encode())


# ── Host / Origin allow-listing (anti DNS-rebinding & CSRF) ────────
def host_allowed(host_header: str, port: int) -> bool:
    """Accept only loopback Host headers for the bound port.

    Blocks DNS-rebinding (where a public hostname resolves to 127.0.0.1 and a
    remote page drives the local server)."""
    if not host_header:
        return False
    host = host_header.split(":", 1)[0].strip().lower()
    return host in {"127.0.0.1", "localhost", "[::1]", "::1"}


def origin_allowed(origin_or_referer: str, port: int) -> bool:
    """True when an Origin/Referer header points at our own loopback server.

    An *absent* Origin is allowed (non-browser clients / same-origin GETs);
    a *present* cross-origin one is rejected."""
    if not origin_or_referer:
        return True
    try:
        u = urlparse(origin_or_referer)
    except Exception:
        return False
    return u.hostname in {"127.0.0.1", "localhost", "::1"}


# ── Token-bucket rate limiter ─────────────────────────────────────
@dataclass
class _Bucket:
    tokens: float
    updated: float


@dataclass
class RateLimiter:
    """Thread-safe token bucket.

    capacity  — max burst.
    refill_per_sec — sustained requests/second once burst is spent.
    A request costs 1 token; when the bucket is empty the caller is told how
    long (seconds) until the next token, for a graceful ``Retry-After``.
    """
    capacity: float
    refill_per_sec: float
    _buckets: dict[str, _Bucket] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def check(self, key: str) -> tuple[bool, int]:
        """Return (allowed, retry_after_seconds)."""
        now = time.monotonic()
        with self._lock:
            b = self._buckets.get(key)
            if b is None:
                b = _Bucket(tokens=self.capacity, updated=now)
                self._buckets[key] = b
            # Refill based on elapsed time, capped at capacity.
            elapsed = now - b.updated
            b.tokens = min(self.capacity, b.tokens + elapsed * self.refill_per_sec)
            b.updated = now
            if b.tokens >= 1.0:
                b.tokens -= 1.0
                return True, 0
            # Empty — seconds until one token refills.
            retry = max(1, int((1.0 - b.tokens) / self.refill_per_sec) + 1)
            return False, retry

    def prune(self, max_idle_sec: float = 3600.0) -> None:
        """Drop buckets unused for a while (prevents unbounded growth)."""
        cutoff = time.monotonic() - max_idle_sec
        with self._lock:
            for k in [k for k, v in self._buckets.items() if v.updated < cutoff]:
                self._buckets.pop(k, None)


# ── Brute-force lockout ───────────────────────────────────────────
@dataclass
class BruteForceGuard:
    """Locks out a key (typically a client IP) after too many FAILED auth attempts.

    Why this is separate from RateLimiter: the request limiter is keyed by
    (ip + token), so each wrong token gets a fresh bucket and is never throttled
    — useless against token guessing. This guard keys on the IP alone and counts
    *failures*, so repeated bad tokens trip a temporary lockout no matter which
    token is presented.

    Usage pattern (callers enforce "valid token always passes"):
        if valid_token:  guard.register_success(ip)        # clears any lockout
        else:            locked = guard.is_locked(ip); guard.register_failure(ip)
    Because a correct token bypasses the lockout, a legitimate user on the same
    loopback IP is never self-DoS'd by an attacker hammering bad tokens.
    """
    max_failures: int = 10          # failures within the window before lockout
    window_sec: float = 60.0        # sliding window for counting failures
    lockout_sec: float = 300.0      # how long a tripped lockout lasts
    _fails: dict[str, list[float]] = field(default_factory=dict)
    _locked_until: dict[str, float] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def is_locked(self, key: str) -> tuple[bool, int]:
        """Return (locked, retry_after_seconds)."""
        now = time.monotonic()
        with self._lock:
            until = self._locked_until.get(key, 0.0)
            if now < until:
                return True, max(1, int(until - now) + 1)
            return False, 0

    def register_failure(self, key: str) -> None:
        now = time.monotonic()
        with self._lock:
            arr = [t for t in self._fails.get(key, []) if t > now - self.window_sec]
            arr.append(now)
            if len(arr) >= self.max_failures:
                self._locked_until[key] = now + self.lockout_sec
                arr = []                      # reset window once locked
            self._fails[key] = arr

    def register_success(self, key: str) -> None:
        """A valid auth clears the recent FAILURE history (instant recovery for a
        legitimate client) but deliberately does NOT lift an active lockout: a
        valid token already bypasses the lockout check, so on a shared loopback
        IP a legit poll must not un-lock an attacker mid-spree. An engaged
        lockout therefore always runs its full ``lockout_sec``."""
        with self._lock:
            self._fails.pop(key, None)


# ── Strict schema validation ──────────────────────────────────────
class ValidationError(ValueError):
    """Raised when user input fails the allow-list schema."""


@dataclass
class Field:
    """A single field spec. Unknown fields in the payload are always rejected."""
    type: type                      # str | int | bool | list
    required: bool = False
    max_len: Optional[int] = None   # for str / list
    choices: Optional[Iterable[Any]] = None
    item_choices: Optional[Iterable[Any]] = None   # for list[str]
    regex: Optional[str] = None
    min_val: Optional[int] = None
    max_val: Optional[int] = None
    default: Any = None


def validate_schema(payload: Any, schema: dict[str, Field]) -> dict[str, Any]:
    """Validate & normalise ``payload`` against ``schema``.

    - rejects non-dict payloads
    - rejects any field not declared in the schema (no mass-assignment)
    - enforces type, length, numeric bounds, choices and regex
    Returns a clean dict containing only declared fields. Raises ValidationError.
    """
    if not isinstance(payload, dict):
        raise ValidationError("body must be a JSON object")

    unexpected = set(payload) - set(schema)
    if unexpected:
        raise ValidationError(f"unexpected field(s): {', '.join(sorted(unexpected))}")

    out: dict[str, Any] = {}
    for name, spec in schema.items():
        if name not in payload or payload[name] is None:
            if spec.required:
                raise ValidationError(f"missing required field: {name}")
            if spec.default is not None:
                out[name] = spec.default
            continue

        val = payload[name]

        # bool must be checked before int (bool is a subclass of int).
        if spec.type is int and isinstance(val, bool):
            raise ValidationError(f"{name} must be an integer")
        if not isinstance(val, spec.type):
            raise ValidationError(f"{name} must be {spec.type.__name__}")

        if spec.type is str:
            if spec.max_len is not None and len(val) > spec.max_len:
                raise ValidationError(f"{name} exceeds max length {spec.max_len}")
            if spec.regex is not None and not re.fullmatch(spec.regex, val):
                raise ValidationError(f"{name} has an invalid format")
            if spec.choices is not None and val not in spec.choices:
                raise ValidationError(f"{name} must be one of {list(spec.choices)}")

        elif spec.type is int:
            if spec.min_val is not None and val < spec.min_val:
                raise ValidationError(f"{name} must be >= {spec.min_val}")
            if spec.max_val is not None and val > spec.max_val:
                raise ValidationError(f"{name} must be <= {spec.max_val}")

        elif spec.type is list:
            if spec.max_len is not None and len(val) > spec.max_len:
                raise ValidationError(f"{name} has too many items (max {spec.max_len})")
            if spec.item_choices is not None:
                for item in val:
                    if item not in spec.item_choices:
                        raise ValidationError(
                            f"{name} contains an invalid value: {item!r}")

        out[name] = val
    return out


def sanitize_text(s: str, max_len: int = 500) -> str:
    """Trim, cap length, and strip control characters (keeps \\n and \\t)."""
    s = (s or "")[: max_len + 1]
    s = "".join(ch for ch in s if ch in ("\n", "\t") or ord(ch) >= 0x20)
    return s.strip()[:max_len]
