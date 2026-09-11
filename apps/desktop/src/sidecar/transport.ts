import { createInterface } from "node:readline";
import { format } from "node:util";

// stdout is exclusively framed protocol traffic. SDK/tool logging belongs on stderr.
const write = process.stdout.write.bind(process.stdout);
for (const method of ["log", "info", "debug", "warn", "error"] as const) {
  console[method] = (...args: unknown[]) => {
    process.stderr.write(`${format(...args)}\n`);
  };
}
const VERSION = 1;
const handlers = new Map<string, (event: undefined, ...args: any[]) => unknown>();
const pending = new Map<
  string,
  {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
let nextId = 0;
let closed = false;
let shutdown: () => Promise<void> = async () => {};
let readyResolve!: () => void;
const ready = new Promise<void>((resolve) => {
  readyResolve = resolve;
});

export function send(message: Record<string, unknown>): void {
  if (!closed) write(`${JSON.stringify({ version: VERSION, ...message })}\n`);
}
export const rpc = {
  handle(channel: string, handler: (event: undefined, ...args: any[]) => unknown) {
    if (handlers.has(channel)) throw new Error(`Duplicate RPC channel: ${channel}`);
    handlers.set(channel, handler);
  },
};
export const renderer = {
  isClosed: () => closed,
  send: (channel: string, payload: unknown) => send({ kind: "event", channel, payload }),
};
export type RendererConnection = typeof renderer;

export function nativeRequest<T = any>(method: string, params: unknown = {}): Promise<T> {
  if (closed) return Promise.reject(new Error("Tauri connection closed"));
  const id = `native-${++nextId}`;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Native request timed out: ${method}`));
    }, 10 * 60_000);
    pending.set(id, { resolve, reject, timer });
    send({ kind: "native", id, method, params });
  });
}

export function markReady(onShutdown: () => Promise<void>): void {
  shutdown = onShutdown;
  readyResolve();
  send({ kind: "ready", channels: [...handlers.keys()] });
}

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  closed = true;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("Tauri connection closed"));
  }
  pending.clear();
  const deadline = setTimeout(() => process.exit(1), 4_000);
  deadline.unref();
  try {
    await shutdown();
  } finally {
    // Pipes are asynchronous on POSIX. process.exit() can otherwise truncate a
    // queued JSON frame (large model catalogs/history are larger than a pipe).
    if (!process.stdout.destroyed) {
      await new Promise<void>((resolve) => process.stdout.end(resolve));
    }
    process.exit(0);
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  void (async () => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.error("Rejected invalid JSON frame");
      return;
    }
    if (!message || message.version !== VERSION) return;
    if (message.kind === "shutdown") {
      await stop();
      return;
    }
    if (message.kind === "native-response") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (typeof message.error === "string") request.reject(new Error(message.error));
      else request.resolve(message.result);
      return;
    }
    if (message.kind !== "request" || typeof message.id !== "string") return;
    try {
      await ready;
      const handler = handlers.get(message.channel);
      if (!handler || !Array.isArray(message.args))
        throw new Error(`Unknown RPC channel: ${message.channel}`);
      // JSON's null in optional argument positions means omitted, just like the preload API.
      const args = message.args.map((arg: unknown) => (arg === null ? undefined : arg));
      const result = await handler(undefined, ...args);
      send({ kind: "response", id: message.id, result: result ?? null });
    } catch (error) {
      send({
        kind: "response",
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })().catch((error) => console.error("Sidecar dispatch failed", error));
});
lines.on("close", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
process.stdout.on("error", () => {
  void stop();
});
