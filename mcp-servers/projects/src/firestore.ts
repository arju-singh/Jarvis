/**
 * Lazy Firestore access, shared by all project tools.
 *
 * No fallbacks: if credentials are missing the first real query throws a clear
 * error. Listing tools / registering projects does NOT need credentials, so the
 * server boots and is usable for config even before Firestore is set up.
 */

import { readFileSync } from "node:fs";
import { initializeApp, cert, type App } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";

let app: App | undefined;
let db: Firestore | undefined;

export function firestore(): Firestore {
  if (db) return db;
  const keyPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ?? process.env.PROJECTS_SERVICE_ACCOUNT;
  if (!keyPath) {
    throw new Error(
      "No Firestore credentials. Set GOOGLE_APPLICATION_CREDENTIALS (or " +
        "PROJECTS_SERVICE_ACCOUNT) to your service-account JSON path.",
    );
  }
  let serviceAccount: Record<string, unknown>;
  try {
    serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch (err) {
    throw new Error(`Could not read service-account key at ${keyPath}: ${(err as Error).message}`);
  }
  app = initializeApp({ credential: cert(serviceAccount as any) });
  db = getFirestore(app);
  return db;
}

export { Timestamp };
