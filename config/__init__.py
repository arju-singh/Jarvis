"""
config — single source of truth for app config and SECRETS.

Secret resolution order (OWASP: prefer the environment, never hard-code):
  1. environment variable   (e.g. GEMINI_API_KEY, OPENROUTER_API_KEY)
  2. config/api_keys.json    (git-ignored; auto-hardened to 0600 on POSIX)

No secret is ever logged, returned to a client, or written to source.
"""
import json
import os
import stat
from pathlib import Path

_CONFIG_PATH = Path(__file__).parent / "api_keys.json"

# logical name -> (environment variable, json key)
_SECRETS = {
    "gemini":     ("GEMINI_API_KEY",     "gemini_api_key"),
    "openrouter": ("OPENROUTER_API_KEY", "openrouter_api_key"),
}


def _harden_perms(path: Path) -> None:
    """Best-effort: ensure the secrets file is owner-read/write only (0600)."""
    try:
        if os.name == "posix" and path.exists():
            if stat.S_IMODE(path.stat().st_mode) & 0o077:
                path.chmod(0o600)
    except Exception:
        pass


def get_config() -> dict:
    _harden_perms(_CONFIG_PATH)
    with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def get_secret(name: str, required: bool = True) -> str:
    """Return a secret by logical name, env-first then file. Raises if required
    and unresolved. Never prints the value."""
    env_name, json_key = _SECRETS.get(name, (name.upper(), name))

    # 1) environment wins.
    val = (os.environ.get(env_name) or "").strip()
    if val:
        return val

    # 2) fall back to the git-ignored, permission-hardened config file.
    try:
        _harden_perms(_CONFIG_PATH)
        with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
            val = (json.load(f).get(json_key) or "").strip()
    except FileNotFoundError:
        val = ""

    if not val and required:
        raise RuntimeError(
            f"Missing secret '{name}'. Set ${env_name} in the environment, "
            f"or add '{json_key}' to config/api_keys.json."
        )
    return val


def get_os() -> str:
    """Returns: 'windows' | 'mac' | 'linux'"""
    return get_config().get("os_system", "windows").lower()

def is_windows() -> bool: return get_os() == "windows"
def is_mac()     -> bool: return get_os() == "mac"
def is_linux()   -> bool: return get_os() == "linux"
