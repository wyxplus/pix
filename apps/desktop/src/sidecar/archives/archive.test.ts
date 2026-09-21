import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  ArchiveStore,
  archiveMarkdown,
  decodeArchive,
  encodeArchive,
  validateArchive,
  type PixArchive,
} from "./archive.ts";
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
function archive(): PixArchive {
  return {
    format: "pix.archive",
    version: 1,
    createdAt: new Date().toISOString(),
    memories: [],
    sessions: [
      {
        id: "session1",
        title: "Project history",
        jsonl:
          [
            { type: "session", id: "session1", version: 3, cwd: "/old/project" },
            {
              type: "message",
              id: "a",
              parentId: null,
              message: { role: "user", content: "first" },
            },
            {
              type: "message",
              id: "b",
              parentId: "a",
              message: {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "hidden" },
                  { type: "text", text: "answer" },
                ],
              },
            },
            { type: "message", id: "c", parentId: "a", message: { role: "user", content: "fork" } },
          ]
            .map((row) => JSON.stringify(row))
            .join("\n") + "\n",
      },
    ],
    sideChats: null,
    warnings: ["External attachments not copied."],
  };
}
it("preserves every session branch and embedded record in a native round trip", async () => {
  const input = archive();
  expect(await decodeArchive(await encodeArchive(input))).toEqual(input);
});
it("imports idempotently and continues from a validated local session file", async () => {
  const path = await mkdtemp(join(tmpdir(), "pix-archive-test-"));
  paths.push(path);
  const store = new ArchiveStore(path),
    bytes = await encodeArchive(archive());
  const first = await store.import(bytes),
    second = await store.import(bytes);
  expect(first.id).toBe(second.id);
  expect(await store.list()).toHaveLength(1);
  expect(await store.session(first.id, "session1")).toContain("session1.jsonl");
  await expect(store.session(first.id, "../../escape")).rejects.toThrow("invalid_archive_id");
  await expect(store.read("../escape")).rejects.toThrow("invalid_archive_id");
});
it("rejects checksum mismatch and arbitrary renamed files", async () => {
  await expect(
    decodeArchive(
      gzipSync(
        JSON.stringify({
          format: "pix.archive.envelope",
          version: 1,
          payload: "{}",
          sha256: "bad",
        }),
      ),
    ),
  ).rejects.toThrow("archive_checksum_mismatch");
  await expect(decodeArchive(Buffer.from("ordinary markdown"))).rejects.toThrow();
});
it("rejects unsupported archive and pi protocol versions", () => {
  expect(() => validateArchive({ ...archive(), version: 2 })).toThrow("unsupported_version");
  const bad = archive();
  bad.sessions[0]!.jsonl = bad.sessions[0]!.jsonl.replace('"version":3', '"version":99');
  expect(() => validateArchive(bad)).toThrow("unsupported_session_version");
});
it("rejects duplicate sessions and broken branch ancestry", () => {
  const duplicate = archive();
  duplicate.sessions.push(duplicate.sessions[0]!);
  expect(() => validateArchive(duplicate)).toThrow("duplicate_session");
  const broken = archive();
  broken.sessions[0]!.jsonl = broken.sessions[0]!.jsonl.replace(
    '"parentId":"a"',
    '"parentId":"missing"',
  );
  expect(() => validateArchive(broken)).toThrow("invalid_session_parent");
});
it("Markdown includes both branches, omits hidden reasoning and describes its reference role", () => {
  const markdown = archiveMarkdown(archive());
  expect(markdown).toContain("fork");
  expect(markdown).toContain("answer");
  expect(markdown).not.toContain("hidden");
  expect(markdown).toContain("reference material");
});
