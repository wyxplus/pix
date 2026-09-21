import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MemoryContext, MemoryRecord } from "@pix/contracts";
import { FakeOpenAiServer } from "../../test-utils/src/index.ts";
import { createPixRuntime } from "../src/index.ts";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("reads fresh memory at provider calls without persisting the injected reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-memory-runtime-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"),
    cwd = join(root, "project");
  await mkdir(agentDir);
  await mkdir(cwd);
  const server = new FakeOpenAiServer({ toolPath: join(cwd, "proof.txt") });
  await server.start();
  cleanups.push(() => server.stop());
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ compaction: { enabled: false } }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "pix-memory": {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "test",
          models: [{ id: "fake", contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    }),
  );
  const record: MemoryRecord = {
    id: "m1",
    scope: "user",
    projectId: null,
    kind: "preference",
    content: "memory-only-canary-8291",
    conditions: "",
    status: "active",
    origin: "explicit",
    sources: [],
    factKey: "key",
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let enabled = true,
    calls = 0;
  const handle = await createPixRuntime({
    cwd,
    agentDir,
    model: { provider: "pix-memory", id: "fake" },
    persistSession: true,
    noTools: "all",
    projectTrusted: true,
    readMemoryContext: async (): Promise<MemoryContext> => {
      calls++;
      return {
        revision: calls,
        epoch: enabled ? 1 : 2,
        learning: false,
        records: enabled ? [record] : [],
      };
    },
  });
  cleanups.push(() => handle.dispose());
  await handle.runtime.session.prompt("hello");
  expect(JSON.stringify(server.requests.at(-1))).toContain(record.content);
  const path = handle.runtime.session.sessionManager.getSessionFile()!;
  expect(await readFile(path, "utf8")).not.toContain("pix_memory_json");
  expect(await readFile(path, "utf8")).not.toContain(record.content);
  enabled = false;
  await handle.runtime.session.prompt("again");
  expect(JSON.stringify(server.requests.at(-1))).not.toContain(record.content);
  expect(calls).toBe(2);
});
