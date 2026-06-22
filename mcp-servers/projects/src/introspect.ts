/**
 * Standalone Firestore introspection CLI.
 *
 * Discover collections and auto-generate (and optionally register) project
 * configs from your REAL data — without starting the brain.
 *
 * Run from the repo root:
 *   npm run introspect                          # list collections
 *   npm run introspect -- <collection>          # suggest a config
 *   npm run introspect -- <collection> --register [--id=name]
 *
 * Credentials: GOOGLE_APPLICATION_CREDENTIALS, PROJECTS_SERVICE_ACCOUNT, or the
 * brain's PROJECTS_SA_KEY (the root npm script loads .env). No mock data — every
 * read hits Firestore and errors loudly if misconfigured.
 */

// Let the brain's PROJECTS_SA_KEY satisfy firebase-admin's expected env var
// (only when set, so we don't shadow PROJECTS_SERVICE_ACCOUNT with an empty value).
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.PROJECTS_SA_KEY) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.PROJECTS_SA_KEY;
}

import { firestore } from "./firestore.js";
import { inferProjectConfig } from "./infer.js";
import { loadRegistry, saveRegistry, CONFIG_PATH, type ProjectConfig } from "./config.js";

const SAMPLE_SIZE = 25;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (const a of argv) {
    if (a === "--register") flags.register = true;
    else if (a.startsWith("--id=")) flags.id = a.slice("--id=".length);
    else if (a === "--help" || a === "-h") flags.help = true;
    else positional.push(a);
  }
  return { collection: positional[0], flags };
}

function usage(): void {
  console.log(
    [
      "Usage:",
      "  npm run introspect                          list collections",
      "  npm run introspect -- <collection>          suggest a config",
      "  npm run introspect -- <collection> --register [--id=name]",
    ].join("\n"),
  );
}

async function listCollections(): Promise<void> {
  const cols = await firestore().listCollections();
  if (!cols.length) {
    console.log("No top-level collections found.");
    return;
  }
  console.log("Collections:");
  for (const c of cols) console.log(`  - ${c.id}`);
  console.log(`\nNext: npm run introspect -- ${cols[0].id}`);
}

async function suggest(collection: string, id: string | undefined, register: boolean): Promise<void> {
  const snap = await firestore().collection(collection).limit(SAMPLE_SIZE).get();
  if (snap.empty) throw new Error(`Collection "${collection}" is empty — nothing to infer from.`);

  const projectId = (id ?? collection).trim();
  const { config, hasDate, sampled } = inferProjectConfig(projectId, collection, snap.docs.map((d) => d.data()));

  console.log(`\nSampled ${sampled} document(s) from "${collection}".\n`);
  console.log(JSON.stringify(config, null, 2));

  if (!hasDate) {
    console.log(`\n⚠ No timestamp field detected. Set "dateField" manually before this works.`);
  }

  if (!register) {
    console.log(`\nTo save it: npm run introspect -- ${collection} --register${id ? ` --id=${id}` : ""}`);
    return;
  }

  if (!hasDate) throw new Error("Refusing to register without a dateField — set it manually and add via config.");

  const reg = loadRegistry();
  if (reg.projects.some((p) => p.id === projectId)) {
    throw new Error(`A project with id "${projectId}" already exists in ${CONFIG_PATH}.`);
  }
  reg.projects.push(config as ProjectConfig);
  saveRegistry(reg);
  console.log(`\n✓ Registered "${projectId}" in ${CONFIG_PATH}. It's queryable now.`);
}

async function main() {
  const { collection, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    usage();
    return;
  }
  if (!collection) {
    await listCollections();
    return;
  }
  await suggest(collection, typeof flags.id === "string" ? flags.id : undefined, Boolean(flags.register));
}

main().catch((err) => {
  console.error(`\n✗ ${(err as Error).message}`);
  process.exit(1);
});
