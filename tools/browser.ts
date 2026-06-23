/**
 * Browser control (macOS, AppleScript).
 *
 * Drives Safari (default) or Chrome — open URLs, web-search, read the current
 * tab, open/close tabs. Set JARVIS_BROWSER="Google Chrome" to use Chrome.
 *
 * Real automation via osascript. Fails loud if the browser/AppleScript errors.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "../types.js";

const run = promisify(execFile);
const BROWSER = process.env.JARVIS_BROWSER ?? "Safari";
const isChrome = /chrome/i.test(BROWSER);

async function osa(script: string): Promise<string> {
  try {
    const { stdout } = await run("osascript", ["-e", script], { timeout: 15_000 });
    return stdout.trim();
  } catch (err) {
    throw new Error((err as Error).message);
  }
}

// Chrome uses "active tab"/"window", Safari uses "current tab"/"document".
const getUrl = isChrome
  ? `tell application "Google Chrome" to get URL of active tab of front window`
  : `tell application "Safari" to get URL of current tab of front window`;
const getTitle = isChrome
  ? `tell application "Google Chrome" to get title of active tab of front window`
  : `tell application "Safari" to get name of current tab of front window`;

function openUrlScript(url: string): string {
  const u = url.replace(/"/g, '\\"');
  return isChrome
    ? `tell application "Google Chrome"\nactivate\nopen location "${u}"\nend tell`
    : `tell application "Safari"\nactivate\nopen location "${u}"\nend tell`;
}

function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+/.test(s)) return `https://${s}`; // looks like a domain
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`; // otherwise search
}

export const browserTools: Tool[] = [
  {
    name: "browser_control",
    description:
      `Control the web browser (${BROWSER}). Actions: open (value = URL or search terms), ` +
      `search (value = query), current_url, current_title, close_tab. Opening a non-URL searches Google.`,
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["open", "search", "current_url", "current_title", "close_tab"] },
        value: { type: "string", description: "URL or search query for open/search." },
      },
      required: ["action"],
    },
    run: async ({ action, value }: { action: string; value?: string }) => {
      switch (action) {
        case "open": {
          if (!value) throw new Error("'value' (URL or terms) required for open.");
          const url = normalizeUrl(value);
          await osa(openUrlScript(url));
          return `Opened ${url}`;
        }
        case "search": {
          if (!value) throw new Error("'value' (query) required for search.");
          const url = `https://www.google.com/search?q=${encodeURIComponent(value)}`;
          await osa(openUrlScript(url));
          return `Searching for "${value}".`;
        }
        case "current_url":
          return (await osa(getUrl)) || "(no open tab)";
        case "current_title":
          return (await osa(getTitle)) || "(no open tab)";
        case "close_tab": {
          const script = isChrome
            ? `tell application "Google Chrome" to close active tab of front window`
            : `tell application "Safari" to close current tab of front window`;
          await osa(script);
          return "Closed the current tab.";
        }
        default:
          throw new Error(`Unknown action "${action}".`);
      }
    },
  },
];
