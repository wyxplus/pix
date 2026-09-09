import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { join } from "node:path";

/** Test driver for the production stdio protocol; only native calls are injected. */
export class SidecarClient extends EventEmitter {
  pending = new Map();
  sequence = 0;
  stderr = "";
  constructor(root, env, native = async () => null) {
    super();
    this.child = spawn(
      process.env.PIX_SMOKE_NODE || process.execPath,
      [join(root, "dist/sidecar/sidecar.mjs")],
      {
        cwd: root,
        env: { ...env, PIX_APP_ROOT: root },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Sidecar startup timed out: ${this.stderr}`)),
        30_000,
      );
      this.once("ready", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      this.child.once("exit", (code) => {
        clearTimeout(timeout);
        const error = new Error(`Sidecar exited ${code}: ${this.stderr.slice(-6000)}`);
        reject(error);
        for (const { reject, timeout } of this.pending.values()) {
          clearTimeout(timeout);
          reject(error);
        }
        this.pending.clear();
      });
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-40_000);
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        throw new Error(`Non-protocol stdout: ${line}`);
      }
      if (frame.kind === "ready") this.emit("ready", frame);
      if (frame.kind === "event")
        this.emit("event", { channel: frame.channel, payload: frame.payload });
      if (frame.kind === "response") {
        if (frame.error && process.env.PIX_SIDECAR_DEBUG === "1")
          console.error("Sidecar rejected", frame.error);
        const call = this.pending.get(frame.id);
        if (call) {
          this.pending.delete(frame.id);
          clearTimeout(call.timeout);
          if (frame.error)
            call.reject(new Error(`${call.channel}: ${frame.error}\n${this.stderr.slice(-4000)}`));
          else call.resolve(frame.result);
        }
      }
      if (frame.kind === "native") {
        Promise.resolve()
          .then(() => native(frame.method, frame.params))
          .then(
            (result) => this.send({ kind: "native-response", id: frame.id, result }),
            (error) => this.send({ kind: "native-response", id: frame.id, error: String(error) }),
          );
      }
    });
  }
  send(frame) {
    this.child.stdin.write(`${JSON.stringify({ version: 1, ...frame })}\n`);
  }
  async invoke(channel, ...args) {
    await this.ready;
    if (process.env.PIX_SIDECAR_DEBUG === "1") console.log("RPC", channel);
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out: ${channel}\n${this.stderr.slice(-4000)}`));
      }, 90_000);
      this.pending.set(id, { resolve, reject, timeout, channel });
      this.send({ kind: "request", id, channel, args });
    });
  }
  async close() {
    if (this.child.exitCode !== null) return;
    const exit = new Promise((resolve) => this.child.once("exit", resolve));
    this.send({ kind: "shutdown" });
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 6_000);
    await exit;
    clearTimeout(timer);
  }
}
