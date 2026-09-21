import { createRequire } from "node:module";
import { realpath } from "node:fs/promises";
import { initializeStorage, storageLockRoot } from "./storage/profile.ts";
const { lock } = createRequire(import.meta.url)("proper-lockfile") as {
  lock: (path: string, options: { stale: number; update: number }) => Promise<() => Promise<void>>;
};
// Resolve the data layout before pi or any singleton reads environment variables.
// The lock package releases locks on process exit; keep the old root locked through migration.
const previousRoot = await storageLockRoot();
await lock(previousRoot, { stale: 120_000, update: 15_000 });
const profile = await initializeStorage();
if ((await realpath(profile.root)) !== previousRoot)
  await lock(profile.root, { stale: 120_000, update: 15_000 });
await import("./index.ts");
