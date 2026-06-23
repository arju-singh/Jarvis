"""
Jarvis Python tools — an MCP server exposing capabilities from the Python
ecosystem that the Node brain doesn't have natively.

Wired into the brain via the MCP bridge (stdio). Cross-platform; risky imports
(pyautogui needs a display + Accessibility permission) are loaded lazily so the
server still starts if they're unavailable.

No mock data: every tool does the real thing and raises a clear error on failure.

Run:  ./.venv/bin/python mcp-servers/pytools/server.py
"""

from __future__ import annotations

import re
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("pytools")


# --- web: keyless search + scrape ----------------------------------------

@mcp.tool()
def ddg_search(query: str, max_results: int = 5) -> str:
    """Search the web with DuckDuckGo (no API key needed). Returns top results."""
    try:
        from ddgs import DDGS  # newer package name
    except ImportError:
        from duckduckgo_search import DDGS  # older name
    with DDGS() as ddgs:
        results = list(ddgs.text(query, max_results=max_results))
    if not results:
        return f'No results for "{query}".'
    return "\n".join(
        f"{i+1}. {r.get('title','')}\n   {r.get('body','')}\n   {r.get('href','')}"
        for i, r in enumerate(results)
    )


@mcp.tool()
def web_scrape(url: str, max_chars: int = 3000) -> str:
    """Fetch a web page and return its readable text (scripts/nav stripped)."""
    import requests
    from bs4 import BeautifulSoup

    resp = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0 (Jarvis)"})
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header", "noscript"]):
        tag.decompose()
    text = " ".join(soup.get_text(" ").split())
    return text[:max_chars] if text else "(no readable text found)"


# --- youtube transcript ---------------------------------------------------

def _video_id(value: str) -> str:
    m = re.search(r"(?:v=|youtu\.be/|embed/|shorts/)([A-Za-z0-9_-]{11})", value)
    if m:
        return m.group(1)
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", value.strip()):
        return value.strip()
    raise ValueError(f'Could not find a YouTube video id in "{value}".')


@mcp.tool()
def youtube_transcript(video: str, max_chars: int = 4000) -> str:
    """Get the transcript text of a YouTube video (URL or 11-char id)."""
    from youtube_transcript_api import YouTubeTranscriptApi

    vid = _video_id(video)
    try:  # newer API (instance .fetch)
        snippets = YouTubeTranscriptApi().fetch(vid)
        text = " ".join(s.text for s in snippets)
    except (TypeError, AttributeError):  # older API (classmethod)
        items = YouTubeTranscriptApi.get_transcript(vid)
        text = " ".join(i["text"] for i in items)
    return text[:max_chars] if text else "(no transcript available)"


# --- clipboard ------------------------------------------------------------

@mcp.tool()
def clipboard_get() -> str:
    """Read the current clipboard text."""
    import pyperclip

    return pyperclip.paste() or "(clipboard is empty)"


@mcp.tool()
def clipboard_set(text: str) -> str:
    """Write text to the clipboard."""
    import pyperclip

    pyperclip.copy(text)
    return f"Copied {len(text)} characters to the clipboard."


# --- input automation (needs Accessibility permission on macOS) -----------

@mcp.tool()
def type_text(text: str) -> str:
    """Type text into the focused app via simulated keystrokes."""
    import pyautogui

    pyautogui.typewrite(text, interval=0.01)
    return f"Typed {len(text)} characters."


@mcp.tool()
def press_hotkey(keys: str) -> str:
    """Press a keyboard shortcut, e.g. 'command+c' or 'ctrl+shift+t'."""
    import pyautogui

    combo = [k.strip() for k in keys.replace("cmd", "command").split("+") if k.strip()]
    if not combo:
        raise ValueError("Provide keys like 'command+c'.")
    pyautogui.hotkey(*combo)
    return f"Pressed {'+'.join(combo)}."


# --- system info ----------------------------------------------------------

@mcp.tool()
def move_to_trash(path: str) -> str:
    """Move a file or folder to the Trash (recoverable, not a permanent delete)."""
    import os
    import send2trash

    target = os.path.abspath(os.path.expanduser(path))
    if not os.path.exists(target):
        raise FileNotFoundError(f"No such file or folder: {target}")
    send2trash.send2trash(target)
    return f"Moved to Trash: {target}"


@mcp.tool()
def system_status() -> str:
    """Report CPU, memory, battery and top processes."""
    import psutil

    cpu = psutil.cpu_percent(interval=0.3)
    mem = psutil.virtual_memory()
    parts = [f"CPU {cpu}%", f"RAM {mem.percent}% ({mem.used // (1024**2)}MB/{mem.total // (1024**2)}MB)"]
    batt = psutil.sensors_battery() if hasattr(psutil, "sensors_battery") else None
    if batt:
        parts.append(f"Battery {batt.percent}%{' (charging)' if batt.power_plugged else ''}")
    top = sorted(psutil.process_iter(["name", "cpu_percent"]), key=lambda p: p.info["cpu_percent"] or 0, reverse=True)[:3]
    parts.append("Top: " + ", ".join(f"{p.info['name']}" for p in top))
    return " | ".join(parts)


if __name__ == "__main__":
    mcp.run()  # stdio transport
