import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vite-plus/test";

describe("Sidecar shutdown protocol", () => {
  it("drains a large UTF-8 frame before exiting even when the reader is slow", async () => {
    const moduleUrl = new URL("./transport.ts", import.meta.url).href;
    const script = `
      const { markReady, send } = await import(${JSON.stringify(moduleUrl)});
      markReady(async () => {});
      send({ kind: "event", payload: "分析数据".repeat(250000) });
      process.send("buffered");
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    let stderr = "";
    child.stderr!.on("data", (chunk) => {
      stderr += chunk;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("message", () => resolve());
        child.once("error", reject);
        child.once("exit", () => reject(new Error(stderr)));
      });
      child.stdin!.write('{"version":1,"kind":"shutdown"}\n');
      // Leave stdout paused until shutdown begins, forcing a pending pipe write.
      await delay(50);
      const chunks: Buffer[] = [];
      for await (const chunk of child.stdout!) chunks.push(Buffer.from(chunk));
      expect(await exit, stderr).toBe(0);
      const frames = Buffer.concat(chunks)
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(frames).toHaveLength(2);
      expect(frames[1].payload).toBe("分析数据".repeat(250000));
    } finally {
      if (child.exitCode === null) child.kill();
    }
  });
});
