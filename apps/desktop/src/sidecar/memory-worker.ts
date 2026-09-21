import { parentPort, workerData } from "node:worker_threads";
import { MemoryStore } from "./memory/store.ts";

const store = new MemoryStore(String(workerData.path));
const methods = [
  "state",
  "preferences",
  "patchPreferences",
  "project",
  "list",
  "create",
  "update",
  "forget",
  "clear",
  "context",
  "revision",
  "instanceId",
  "beginLearning",
  "finishLearning",
  "prepareConsolidation",
  "resolve",
  "projectRoots",
  "exportRecords",
  "exportSuppressions",
  "importRecords",
  "close",
] as const;
parentPort!.on("message", (request: { id: number; method: string; args: unknown[] }) => {
  try {
    if (!methods.includes(request.method as (typeof methods)[number]))
      throw new Error("unknown_memory_method");
    const method = store[request.method as (typeof methods)[number]] as (
      ...args: unknown[]
    ) => unknown;
    const value = method.apply(store, request.args);
    parentPort!.postMessage({ id: request.id, value });
  } catch (error) {
    parentPort!.postMessage({
      id: request.id,
      error: error instanceof Error ? error.message : "memory_error",
    });
  }
});
