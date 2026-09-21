import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  MemoryContext,
  MemoryInput,
  MemoryPreferences,
  MemoryProject,
  MemoryRecord,
  MemoryScope,
  MemoryState,
} from "@pix/contracts";

const exec = promisify(execFile);

export class MemoryService {
  private readonly worker: Worker;
  private serial = 0;
  private failure: Error | undefined;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(directory: string) {
    const built = new URL("./memory-worker.mjs", import.meta.url);
    this.worker = new Worker(
      existsSync(built) ? built : new URL("../memory-worker.ts", import.meta.url),
      { workerData: { path: join(directory, "memory.sqlite") } },
    );
    this.worker.on("message", (message: { id: number; value?: unknown; error?: string }) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.value);
    });
    const fail = (error: Error) => {
      this.failure = error;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
    };
    this.worker.on("error", fail);
    this.worker.on("exit", () => fail(new Error("memory_service_stopped")));
  }

  call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.serial;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("memory_timeout"));
      }, 10_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      this.worker.postMessage({ id, method, args });
    });
  }

  async close(): Promise<void> {
    try {
      if (!this.failure) await this.call("close");
    } finally {
      await this.worker.terminate();
    }
  }
  state() {
    return this.call<MemoryState>("state");
  }
  preferences() {
    return this.call<MemoryPreferences>("preferences");
  }
  patchPreferences(patch: Partial<MemoryPreferences>, revision: number) {
    return this.call<MemoryPreferences>("patchPreferences", patch, revision);
  }
  list(input: { scope: MemoryScope; projectId?: string; query?: string }) {
    return this.call<MemoryRecord[]>("list", input);
  }
  create(input: MemoryInput) {
    return this.call<MemoryRecord>("create", input);
  }
  update(input: { id: string; expectedRevision: number; content: string; conditions?: string }) {
    return this.call<MemoryRecord>("update", input);
  }
  forget(ids: string[]) {
    return this.call<void>("forget", ids);
  }
  clear(input: { scope: MemoryScope; projectId?: string }) {
    return this.call<void>("clear", input);
  }
  context(projectId: string | undefined, query: string) {
    return this.call<MemoryContext>("context", projectId, query);
  }

  async project(cwd: string): Promise<MemoryProject> {
    const root = await realpath(cwd);
    let identity = root;
    try {
      const { stdout } = await exec(
        "git",
        ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
        { timeout: 3000, maxBuffer: 32_768 },
      );
      identity = await realpath(resolve(root, stdout.trim()));
    } catch {
      /* Non-Git projects retain their registered root. */
    }
    return this.call<MemoryProject>("project", identity, root, basename(root));
  }
}
