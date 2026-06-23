/**
 * game_updater — install / update / list / launch Steam and Epic games.
 *
 *   Steam → steamcmd   (https://developer.valvesoftware.com/wiki/SteamCMD)
 *   Epic  → legendary  (https://github.com/derrod/legendary)
 *
 * Real CLIs, no mock data. If the CLI isn't installed or you aren't logged in,
 * the tool fails loud with the fix. Big installs can take a while — STEAM
 * installs go to STEAM_INSTALL_DIR (default ~/SteamGames).
 *
 * Auth: `legendary auth` (Epic) once; Steam uses anonymous login (works for
 * free/dedicated content) unless you own the title and log in via steamcmd.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Tool } from "../types.js";

const run = promisify(execFile);

async function cli(cmd: string, args: string[], timeoutMs = 600_000): Promise<string> {
  try {
    const { stdout, stderr } = await run(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return (stdout.trim() || stderr.trim() || "(done)");
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === "ENOENT") {
      const fix = cmd === "steamcmd"
        ? "Install it: brew install --cask steamcmd (or from Valve)."
        : "Install it: pip install legendary-gl, then run `legendary auth`.";
      throw new Error(`"${cmd}" is not installed. ${fix}`);
    }
    throw new Error((e.stderr || e.stdout || e.message).trim());
  }
}

const STEAM_DIR = process.env.STEAM_INSTALL_DIR ?? join(homedir(), "SteamGames");

async function steam(action: string, game?: string): Promise<string> {
  switch (action) {
    case "install":
    case "update": {
      if (!game) throw new Error("Steam needs the numeric appid as 'game' (find it on SteamDB).");
      if (!/^\d+$/.test(game)) throw new Error(`Steam 'game' must be a numeric appid, got "${game}".`);
      // Order matters: force_install_dir BEFORE login (per Valve).
      const out = await cli("steamcmd", [
        "+force_install_dir", join(STEAM_DIR, game),
        "+login", "anonymous",
        "+app_update", game, "validate",
        "+quit",
      ]);
      return `Steam app ${game} ${action} finished into ${join(STEAM_DIR, game)}.\n${out.slice(-500)}`;
    }
    case "list":
      throw new Error("Steam can't list owned games via steamcmd anonymously — use the Steam app, or give an appid to install/update.");
    case "launch":
      throw new Error("steamcmd can't launch games. Use: open steam://run/<appid>");
    default:
      throw new Error(`Unknown Steam action "${action}".`);
  }
}

async function epic(action: string, game?: string): Promise<string> {
  switch (action) {
    case "list":
      return await cli("legendary", ["list", "--json"], 60_000);
    case "install":
    case "update": {
      if (!game) throw new Error("Epic needs the game's App Name as 'game' (see game_updater list).");
      return await cli("legendary", ["install", game, "-y"]);
    }
    case "launch": {
      if (!game) throw new Error("Epic needs the game's App Name as 'game'.");
      return await cli("legendary", ["launch", game], 30_000);
    }
    default:
      throw new Error(`Unknown Epic action "${action}".`);
  }
}

export const gameTools: Tool[] = [
  {
    name: "game_updater",
    description:
      "Install, update, list, or launch Steam and Epic games. Steam uses steamcmd (game = numeric " +
      "appid); Epic uses legendary (game = App Name from a list). Use this DIRECTLY for any Steam/Epic " +
      "request — never web search first. Large installs can take several minutes.",
    input_schema: {
      type: "object",
      properties: {
        platform: { type: "string", enum: ["steam", "epic"], description: "Which store." },
        action: { type: "string", enum: ["install", "update", "list", "launch"], description: "What to do." },
        game: { type: "string", description: "Steam appid (number) or Epic App Name." },
      },
      required: ["platform", "action"],
    },
    run: async ({ platform, action, game }: { platform: string; action: string; game?: string }) => {
      if (platform === "steam") return steam(action, game);
      if (platform === "epic") return epic(action, game);
      throw new Error(`Unknown platform "${platform}" — use steam or epic.`);
    },
  },
];
