/**
 * System control tools — the macOS-native port of Mark-XXXIX-OR's
 * `computer_settings` + `screen_processor` (screenshot) actions.
 *
 * Mark's originals were Windows-leaning (pycaw/comtypes/win10toast). Here every
 * capability is reimplemented the macOS way via `osascript`, `networksetup`,
 * `pmset`, and `screencapture` — no fakes, every failure throws.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, isAbsolute } from "node:path";
import type { Tool } from "../types.js";

const execAsync = promisify(exec);

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
  return v;
}

const WORKDIR = resolve(requireEnv("JARVIS_WORKDIR"));

async function run(cmd: string): Promise<string> {
  const { stdout, stderr } = await execAsync(cmd, { timeout: 20_000, maxBuffer: 1024 * 1024 });
  return [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
}

/** AppleScript helper — runs a script and returns its trimmed output. */
async function osa(script: string): Promise<string> {
  // Pass the script on stdin to avoid quoting hell.
  const { stdout } = await execAsync(`osascript -e ${JSON.stringify(script)}`, { timeout: 20_000 });
  return stdout.trim();
}

function clampPct(n: number): number {
  if (Number.isNaN(n)) throw new Error("value must be a number 0–100.");
  return Math.max(0, Math.min(100, Math.round(n)));
}

export const systemTools: Tool[] = [
  {
    name: "system_control",
    description:
      "Control macOS system settings: volume, brightness, dark mode, Wi-Fi, screen lock, " +
      "and sleep. Use for commands like 'turn the volume up', 'set volume to 30', 'mute', " +
      "'brightness up', 'enable dark mode', 'turn off wifi', 'lock the screen', 'go to sleep'.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "set_volume", "mute", "unmute", "get_volume",
            "volume_up", "volume_down",
            "brightness_up", "brightness_down",
            "dark_mode_on", "dark_mode_off", "dark_mode_toggle",
            "wifi_on", "wifi_off",
            "lock_screen", "sleep",
          ],
          description: "The system action to perform.",
        },
        value: {
          type: "number",
          description: "For set_volume: target level 0–100. Ignored by other actions.",
        },
      },
      required: ["action"],
    },
    run: async ({ action, value }: { action: string; value?: number }) => {
      switch (action) {
        case "set_volume": {
          const v = clampPct(Number(value));
          await osa(`set volume output volume ${v}`);
          return `Volume set to ${v}%.`;
        }
        case "volume_up": {
          const cur = Number(await osa("output volume of (get volume settings)"));
          const v = clampPct(cur + 10);
          await osa(`set volume output volume ${v}`);
          return `Volume up to ${v}%.`;
        }
        case "volume_down": {
          const cur = Number(await osa("output volume of (get volume settings)"));
          const v = clampPct(cur - 10);
          await osa(`set volume output volume ${v}`);
          return `Volume down to ${v}%.`;
        }
        case "mute":
          await osa("set volume with output muted");
          return "Muted.";
        case "unmute":
          await osa("set volume without output muted");
          return "Unmuted.";
        case "get_volume": {
          const v = await osa("output volume of (get volume settings)");
          const muted = await osa("output muted of (get volume settings)");
          return `Volume is ${v}%${muted === "true" ? " (muted)" : ""}.`;
        }
        case "brightness_up":
          await osa('tell application "System Events" to key code 144');
          return "Brightness up.";
        case "brightness_down":
          await osa('tell application "System Events" to key code 145');
          return "Brightness down.";
        case "dark_mode_on":
        case "dark_mode_off":
        case "dark_mode_toggle": {
          const target =
            action === "dark_mode_on" ? "true" : action === "dark_mode_off" ? "false" : "not dark mode";
          await osa(
            `tell application "System Events" to tell appearance preferences to set dark mode to ${target}`,
          );
          return `Dark mode ${action === "dark_mode_toggle" ? "toggled" : action === "dark_mode_on" ? "on" : "off"}.`;
        }
        case "wifi_on":
        case "wifi_off": {
          // en0 is the usual Wi-Fi device; resolve it for robustness.
          const dev =
            (await run(
              "networksetup -listallhardwareports | awk '/Wi-Fi/{getline; print $2; exit}'",
            )) || "en0";
          await run(`networksetup -setairportpower ${dev} ${action === "wifi_on" ? "on" : "off"}`);
          return `Wi-Fi turned ${action === "wifi_on" ? "on" : "off"}.`;
        }
        case "lock_screen":
          await osa('tell application "System Events" to keystroke "q" using {control down, command down}');
          return "Screen locked.";
        case "sleep":
          await run("pmset sleepnow");
          return "Going to sleep.";
        default:
          throw new Error(`Unknown system action: ${action}`);
      }
    },
  },
  {
    name: "take_screenshot",
    description:
      "Capture the current screen to a PNG file in the working directory and return its path. " +
      "Use when the user asks to take/grab a screenshot of the screen.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Optional file name (defaults to screenshot.png)." },
      },
    },
    run: async ({ filename }: { filename?: string }) => {
      const name = (filename && !isAbsolute(filename) ? filename : "screenshot.png").replace(/[^\w.\-]/g, "_");
      const out = resolve(WORKDIR, name.endsWith(".png") ? name : `${name}.png`);
      // -x = no capture sound; whole screen.
      await run(`screencapture -x ${JSON.stringify(out)}`);
      return `Screenshot saved to ${out}`;
    },
  },
];
