/**
 * Desktop control tools.
 *
 * Safety model:
 *  - `run_shell` refuses obviously destructive commands. The brain is told to
 *    ask the user out loud, and only after a verbal "yes" may it call
 *    `run_shell_confirmed` — keeping a human in the loop for dangerous ops.
 *  - File access is confined to JARVIS_WORKDIR. Paths outside it are rejected.
 *  - Nothing is faked: every failure throws and is surfaced to the model/user.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute } from "node:path";
import { readFile, writeFile, readdir } from "node:fs/promises";
import type { Tool } from "../types.js";

const execAsync = promisify(exec);

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
  return v;
}

const WORKDIR = resolve(requireEnv("JARVIS_WORKDIR"));

const DESTRUCTIVE: RegExp[] = [
  /\brm\s+-[rf]/, /\bmkfs\b/, /\bdd\s+if=/, />\s*\/dev\/sd/,
  /\bshutdown\b/, /\breboot\b/, /\bformat\b/, /\bdel\s+\/[sq]/i,
  /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/,          // fork bomb
];

function isDestructive(cmd: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(cmd));
}

async function shell(cmd: string): Promise<string> {
  const { stdout, stderr } = await execAsync(cmd, {
    cwd: WORKDIR,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const out = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  return out || "(command produced no output)";
}

function safePath(p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(WORKDIR, p);
  const rel = relative(WORKDIR, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes JARVIS_WORKDIR: ${p}`);
  }
  return abs;
}

export const desktopTools: Tool[] = [
  {
    name: "run_shell",
    description:
      "Run a non-destructive shell command in the working directory and return its output. " +
      "Destructive commands are refused; ask the user to confirm, then use run_shell_confirmed.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    run: async ({ command }: { command: string }) => {
      if (isDestructive(command)) {
        throw new Error(
          "Refused: this command looks destructive. Ask the user to confirm out loud, " +
          "then call run_shell_confirmed.",
        );
      }
      return shell(command);
    },
  },
  {
    name: "run_shell_confirmed",
    description:
      "Run a shell command the user has VERBALLY confirmed. Only call this after the user " +
      "explicitly said yes to this exact command.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
    run: async ({ command }: { command: string }) => {
      console.warn(`[CONFIRMED SHELL] ${command}`);
      return shell(command);
    },
  },
  {
    name: "open_app",
    description: "Open an application or file using the OS default handler.",
    input_schema: {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
    },
    run: async ({ target }: { target: string }) => {
      const opener =
        process.platform === "win32" ? `start "" "${target}"`
        : process.platform === "darwin" ? `open "${target}"`
        : `xdg-open "${target}"`;
      await shell(opener);
      return `Opened ${target}`;
    },
  },
  {
    name: "list_dir",
    description: "List files in a directory inside the working directory.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    run: async ({ path }: { path: string }) => {
      const entries = await readdir(safePath(path), { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the working directory.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    run: async ({ path }: { path: string }) => readFile(safePath(path), "utf8"),
  },
  {
    name: "write_file",
    description: "Write a UTF-8 text file inside the working directory (overwrites).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
    run: async ({ path, content }: { path: string; content: string }) => {
      await writeFile(safePath(path), content, "utf8");
      return `Wrote ${content.length} chars to ${path}`;
    },
  },
];
