/**
 * Computer control + session tools (macOS).
 *
 *  - computer_settings : ONE single-action computer command (volume, brightness,
 *    wifi, screenshot, lock, sleep, dark mode). Real macOS commands — no mock.
 *  - shutdown_jarvis   : stop the assistant session (exits the brain).
 *
 * Commands use osascript / networksetup / screencapture / pmset / brightness.
 * Anything that isn't installed or permitted fails loud with a clear message.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type { Tool } from "../types.js";

const run = promisify(execFile);

async function exec(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: 20_000, maxBuffer: 1024 * 1024 });
    return (stdout.trim() || stderr.trim());
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") throw new Error(`"${cmd}" is not installed.`);
    throw new Error(e.message);
  }
}

const osa = (script: string) => exec("osascript", ["-e", script]);

async function wifiDevice(): Promise<string> {
  const out = await exec("networksetup", ["-listallhardwareports"]);
  // Block: "Hardware Port: Wi-Fi\nDevice: en0"
  const m = /Wi-Fi[\s\S]*?Device:\s*(\w+)/.exec(out);
  return m?.[1] ?? "en0";
}

function clampNum(value: unknown, lo: number, hi: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Expected a number between ${lo} and ${hi}.`);
  return Math.max(lo, Math.min(hi, n));
}

const ACTIONS = [
  "volume_set", "volume_mute", "volume_unmute", "volume_get",
  "brightness_set", "brightness_up", "brightness_down",
  "wifi_on", "wifi_off", "wifi_status",
  "screenshot", "lock", "display_sleep",
  "dark_mode_on", "dark_mode_off",
] as const;

export const computerTools: Tool[] = [
  {
    name: "computer_settings",
    description:
      "Perform ONE single computer control action on this Mac. Actions: " +
      "volume_set (value 0-100), volume_mute, volume_unmute, volume_get, " +
      "brightness_set (value 0-100), brightness_up, brightness_down, " +
      "wifi_on, wifi_off, wifi_status, screenshot, lock, display_sleep, " +
      "dark_mode_on, dark_mode_off. Use this for any single computer command.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ACTIONS as unknown as string[], description: "Which action to run." },
        value: { type: "number", description: "For volume_set / brightness_set: 0-100." },
      },
      required: ["action"],
    },
    run: async ({ action, value }: { action: string; value?: number }) => {
      switch (action) {
        case "volume_set":
          await osa(`set volume output volume ${clampNum(value, 0, 100)}`);
          return `Volume set to ${clampNum(value, 0, 100)}%.`;
        case "volume_mute":
          await osa("set volume output muted true");
          return "Muted.";
        case "volume_unmute":
          await osa("set volume output muted false");
          return "Unmuted.";
        case "volume_get":
          return `Volume is ${await osa("output volume of (get volume settings)")}%.`;
        case "brightness_set": {
          const v = clampNum(value, 0, 100) / 100;
          try {
            await exec("brightness", [String(v)]);
          } catch (e) {
            if ((e as Error).message.includes("not installed")) {
              throw new Error("brightness CLI not installed. Run: brew install brightness");
            }
            throw e;
          }
          return `Brightness set to ${Math.round(v * 100)}%.`;
        }
        case "brightness_up":
          await osa('tell application "System Events" to key code 144');
          return "Brightness up.";
        case "brightness_down":
          await osa('tell application "System Events" to key code 145');
          return "Brightness down.";
        case "wifi_on":
          await exec("networksetup", ["-setairportpower", await wifiDevice(), "on"]);
          return "Wi-Fi on.";
        case "wifi_off":
          await exec("networksetup", ["-setairportpower", await wifiDevice(), "off"]);
          return "Wi-Fi off.";
        case "wifi_status":
          return await exec("networksetup", ["-getairportpower", await wifiDevice()]);
        case "screenshot": {
          const dir = process.env.JARVIS_WORKDIR ?? process.cwd();
          const path = join(dir, `screenshot-${Date.now()}.png`);
          await exec("screencapture", ["-x", path]);
          return `Screenshot saved to ${path}.`;
        }
        case "lock":
          await osa('tell application "System Events" to keystroke "q" using {control down, command down}');
          return "Locked.";
        case "display_sleep":
          await exec("pmset", ["displaysleepnow"]);
          return "Display asleep.";
        case "dark_mode_on":
          await osa('tell application "System Events" to tell appearance preferences to set dark mode to true');
          return "Dark mode on.";
        case "dark_mode_off":
          await osa('tell application "System Events" to tell appearance preferences to set dark mode to false');
          return "Dark mode off.";
        default:
          throw new Error(`Unknown action "${action}". Valid: ${ACTIONS.join(", ")}.`);
      }
    },
  },
  {
    name: "notify",
    description: "Show a desktop notification (macOS). Use for reminders or to surface a result.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Notification body." },
        title: { type: "string", description: "Title (default Jarvis)." },
      },
      required: ["message"],
    },
    run: async ({ message, title }: { message: string; title?: string }) => {
      const esc = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      await osa(`display notification "${esc(message)}" with title "${esc(title ?? "Jarvis")}"`);
      return "Notification shown.";
    },
  },
  {
    name: "shutdown_jarvis",
    description:
      "Stop the Jarvis assistant session (exits the brain — the user must relaunch it manually). " +
      "ONLY call this when the user EXPLICITLY asks to stop Jarvis or the assistant BY NAME, e.g. " +
      "\"shut down Jarvis\", \"stop the assistant\", \"quit Jarvis\", \"go to sleep Jarvis\". " +
      "DO NOT call it for a bare \"shut down\"/\"shutdown\" (that means their computer, not you), " +
      "and not for casual goodbyes like \"bye\" or \"thanks\". Pass the user's exact words in `user_said`.",
    input_schema: {
      type: "object",
      properties: {
        user_said: { type: "string", description: "The user's exact words requesting the shutdown." },
      },
      required: ["user_said"],
    },
    run: async ({ user_said }: { user_said?: string }) => {
      // Hard guard, independent of the model: only actually exit when the request
      // clearly names Jarvis / the assistant. A bare "shut down" never kills us.
      const said = String(user_said ?? "");
      const meansAssistant =
        /\b(jarvis|the assistant|assistant)\b/i.test(said) ||
        /\bstop (listening|the session)\b/i.test(said);
      if (!meansAssistant) {
        return (
          "Not shutting down — that didn't clearly ask to stop the assistant. " +
          "If you want me to actually stop, say \"shut down Jarvis\"."
        );
      }
      // Let the reply send + speak first, then exit.
      setTimeout(() => process.exit(0), 1500);
      return "Shutting down. Goodbye.";
    },
  },
];
