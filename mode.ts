/**
 * Mode resolution — online (cloud) vs offline (local).
 *
 *   JARVIS_MODE=online   → always cloud (Claude + ElevenLabs)
 *   JARVIS_MODE=offline  → always local (Ollama + Piper), no internet used
 *   JARVIS_MODE=auto     → probe connectivity once at boot and pick (default)
 */

export type Mode = "online" | "offline";

async function hasInternet(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    // 204-no-content endpoint: cheap, returns fast, no body.
    await fetch("https://www.gstatic.com/generate_204", { method: "HEAD", signal: ctrl.signal });
    clearTimeout(timer);
    return true;
  } catch {
    return false;
  }
}

export async function resolveMode(): Promise<Mode> {
  const raw = (process.env.JARVIS_MODE ?? "auto").toLowerCase();
  if (raw === "online" || raw === "offline") return raw;
  if (raw !== "auto") {
    throw new Error(`Invalid JARVIS_MODE "${raw}". Use online | offline | auto.`);
  }
  return (await hasInternet()) ? "online" : "offline";
}
