/**
 * Project registry — a config file you can grow over time.
 *
 * Each project maps a human id to a Firestore collection plus which fields hold
 * the date, status, category and display text. Add a project by editing the
 * JSON file, or via the `register_project` tool — either way it works on the
 * next call (the file is re-read fresh every time, no restart needed).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface ProjectConfig {
  /** Stable id used in tool calls, e.g. "petsacre". */
  id: string;
  /** Human label, e.g. "petsacre.club". */
  label?: string;
  /** Firestore collection holding the records. */
  collection: string;
  /** Timestamp field used for date ranges/ordering. */
  dateField: string;
  /** Field holding a status string (for analytics breakdowns). */
  statusField?: string;
  /** Field holding a category/type (e.g. service). */
  categoryField?: string;
  /** Numeric field for revenue/amount analytics (e.g. "amount", "price"). */
  amountField?: string;
  /** Candidate fields for a record's title (first non-empty wins). */
  titleFields?: string[];
  /** Candidate fields for a record's subtitle. */
  subtitleFields?: string[];
}

export interface RegistryFile {
  projects: ProjectConfig[];
}

export const CONFIG_PATH =
  process.env.PROJECTS_CONFIG ??
  new URL("../projects.config.json", import.meta.url).pathname;

export function loadRegistry(): RegistryFile {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `No project config at ${CONFIG_PATH}. Copy projects.config.example.json ` +
        `to projects.config.json, or set PROJECTS_CONFIG to your file.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Project config at ${CONFIG_PATH} is not valid JSON: ${(err as Error).message}`);
  }
  const reg = parsed as RegistryFile;
  if (!reg || !Array.isArray(reg.projects)) {
    throw new Error(`Project config must be { "projects": [ ... ] }.`);
  }
  return reg;
}

export function saveRegistry(reg: RegistryFile): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(reg, null, 2) + "\n", "utf8");
}

export function getProject(id: string): ProjectConfig {
  const reg = loadRegistry();
  const project = reg.projects.find((p) => p.id === id);
  if (!project) {
    const known = reg.projects.map((p) => p.id).join(", ") || "(none)";
    throw new Error(`Unknown project "${id}". Registered projects: ${known}.`);
  }
  return project;
}
