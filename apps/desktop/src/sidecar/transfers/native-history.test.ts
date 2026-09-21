import { afterEach, expect, it } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, writeFile, rm, chmod, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { transferBranches, claudeTranscript, codexRollout } from "./native-history.ts";
import { NativeTransferStore } from "./native-transfer.ts";
import type { PixArchive } from "../archives/archive.ts";
import { packAttachments } from "../archives/attachments.ts";
import { PathAccess } from "../../main/path-access.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});
function fixture(): PixArchive {
  return {
    format: "pix.archive",
    version: 1,
    createdAt: new Date().toISOString(),
    memories: [],
    sideChats: null,
    warnings: [],
    sessions: [
      {
        id: "source",
        title: "Branches",
        jsonl:
          [
            { type: "session", version: 3, id: "source", cwd: "/source" },
            {
              type: "message",
              id: "u",
              parentId: null,
              message: { role: "user", content: "user-canary" },
            },
            {
              type: "message",
              id: "a",
              parentId: "u",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "hidden-canary" },
                  { type: "text", text: "answer-canary" },
                  { type: "toolCall", name: "exec", arguments: { command: "should-never-run" } },
                ],
              },
            },
            {
              type: "message",
              id: "fork",
              parentId: "u",
              message: { role: "user", content: "fork-canary" },
            },
          ]
            .map((row) => JSON.stringify(row))
            .join("\n") + "\n",
      },
    ],
  };
}
it("preserves separate branch chains, emits inert tool references, and excludes hidden content and tool arguments", () => {
  const branches = transferBranches(fixture().sessions[0]!);
  expect(branches).toHaveLength(2);
  expect(branches[0]!.messages.some((m) => m.text.includes("answer-canary"))).toBe(true);
  expect(branches[0]!.messages.some((m) => m.text.includes("fork-canary"))).toBe(false);
  expect(branches[1]!.messages.some((m) => m.text.includes("answer-canary"))).toBe(false);
  const payload = JSON.stringify(branches);
  expect(payload).not.toContain("hidden-canary");
  expect(payload).not.toContain("should-never-run");
  expect(payload).toContain("arguments not replayed");
});
it("creates strictly increasing Claude timestamps and valid parent links, with version gating", () => {
  const branch = transferBranches(fixture().sessions[0]!)[0]!;
  const converted = claudeTranscript(branch, "/target", "2.1.87");
  const rows = converted.jsonl
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i].parentUuid).toBe(rows[i - 1].uuid);
    expect(Date.parse(rows[i].timestamp)).toBeGreaterThan(Date.parse(rows[i - 1].timestamp));
  }
  expect(() => claudeTranscript(branch, "/target", "999")).toThrow("unsupported");
  expect(() => codexRollout(branch, "/target", "999")).toThrow("unsupported");
});
it("emits both Codex visible events and model context records for each historical message", () => {
  const branch = transferBranches(fixture().sessions[0]!)[0]!;
  const encoded = codexRollout(branch, "/target", "0.155.0-alpha.9.2");
  const rows = encoded.jsonl
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.type === "response_item")).toHaveLength(branch.messages.length);
  expect(
    rows.filter((row) => ["user_message", "agent_message"].includes(row.payload.type)),
  ).toHaveLength(branch.messages.length);
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pix-native-transfer-test-"));
  roots.push(root);
  const target = join(root, "target"),
    cwd = join(root, "workspace"),
    binary = join(root, "codex-test");
  await mkdir(target);
  await mkdir(cwd);
  await writeFile(binary, '#!/bin/sh\nprintf "codex-cli 0.155.0-alpha.9.2\\n"\n');
  await chmod(binary, 0o700);
  const store = new NativeTransferStore(join(root, "transfers"));
  return { root, target, cwd, binary, store };
}
it("previews without target writes, reuses IDs, delivers once, and never replaces a continued target session", async () => {
  const { store, target, cwd, binary } = await setup();
  const input = {
    archiveId: "archive",
    archive: fixture(),
    target: "codex" as const,
    binary,
    directory: target,
    cwd,
  };
  const plan = await store.plan(input);
  expect(await readdir(target)).toEqual([]);
  expect((await store.plan(input)).sessions).toEqual(plan.sessions);
  expect((await store.deliver(plan.id)).delivered).toBe(true);
  const dirs = (await readdir(join(target, "sessions"), { recursive: true })).filter((name) =>
    name.endsWith(".jsonl"),
  );
  expect(dirs).toHaveLength(2);
  const file = join(target, "sessions", dirs[0]!);
  await writeFile(file, "target continued");
  expect((await store.deliver(plan.id)).delivered).toBe(true);
  expect(await readFile(file, "utf8")).toBe("target continued");
});
it("rejects changed or unknown client versions at delivery and preserves the target", async () => {
  const { store, target, cwd, binary } = await setup();
  const plan = await store.plan({
    archiveId: "archive",
    archive: fixture(),
    target: "codex",
    binary,
    directory: target,
    cwd,
  });
  await writeFile(binary, '#!/bin/sh\nprintf "codex-cli 999\\n"\n');
  await expect(store.deliver(plan.id)).rejects.toThrow("Unsupported");
  expect(await readdir(target)).toEqual([]);
  await expect(store.deliver("../escape")).rejects.toThrow("invalid_transfer_id");
});
it("delivers side conversation drafts and attachment references that survive removal of the source", async () => {
  const { store, target, cwd, binary } = await setup();
  const archive = fixture();
  const attachment = join(cwd, "notes.txt");
  await writeFile(attachment, "portable side attachment");
  archive.sideChats = {
    version: 1,
    activeBySession: { old: "side" },
    chats: {
      side: {
        id: "side",
        sessionKey: "old",
        sessionId: "source",
        selection: { messageId: "u", text: "quoted selection", context: "source context" },
        sourceMessages: [],
        messages: [{ id: "m", role: "user", text: "side message", attachments: [attachment] }],
        draft: "unfinished draft",
        attachments: [attachment],
        status: "idle",
        error: "",
        settings: { accessMode: "default", thinkingLevel: "off", serviceTier: "default" },
      },
    },
  };
  await packAttachments(archive, [cwd], new PathAccess());
  const plan = await store.plan({
    archiveId: "side-archive",
    archive,
    target: "codex",
    binary,
    directory: target,
    cwd,
  });
  await rm(attachment);
  await store.deliver(plan.id);
  const assets = join(target, "pix-import-assets", plan.id);
  const restored = join(assets, (await readdir(assets))[0]!);
  expect(await readFile(restored, "utf8")).toBe("portable side attachment");
  const files = (await readdir(join(target, "sessions"), { recursive: true })).filter((name) =>
    name.endsWith(".jsonl"),
  );
  const history = (
    await Promise.all(files.map((file) => readFile(join(target, "sessions", file), "utf8")))
  ).join("\n");
  expect(history).toContain(restored);
  expect(history).toContain("unfinished draft");
  expect(history).toContain("Unsent Pix draft");
  expect(history).not.toContain(attachment);
});
