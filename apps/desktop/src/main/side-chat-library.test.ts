import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { SideChatArchive } from "@pix/contracts";
import { SideChatLibrary } from "./side-chat-library.ts";

const roots: string[] = [];
function library() {
  const root = mkdtempSync(join(tmpdir(), "pix-side-chats-"));
  roots.push(root);
  return new SideChatLibrary(root);
}
function archive(): SideChatArchive {
  return {
    version: 1,
    activeBySession: { main: "first" },
    chats: {
      first: {
        id: "first",
        sessionKey: "main",
        sessionId: "main-id",
        selection: { messageId: "answer", text: "选文", context: "完整来源" },
        sourceMessages: [{ role: "user", text: "来源问题" }],
        messages: [{ id: "message", role: "assistant", text: "保存的回答" }],
        draft: "保存的草稿",
        attachments: ["/tmp/file.txt"],
        settings: { thinkingLevel: "high", serviceTier: "default", accessMode: "default" },
        status: "idle",
        error: "",
      },
    },
  };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("side chat archive", () => {
  it("persists full chat state across instances and durably deletes closed tabs", () => {
    const first = library();
    expect(first.load()).toEqual({ version: 1, chats: {}, activeBySession: {} });
    first.save(archive());
    const reopened = new SideChatLibrary(join(first.path, ".."));
    expect(reopened.load()).toEqual(archive());
    reopened.save({ version: 1, chats: {}, activeBySession: {} });
    expect(first.load().chats).toEqual({});
  });
  it("rejects invalid writes without overwriting a valid archive, and ignores incomplete temporary files", () => {
    const file = library();
    file.save(archive());
    for (const invalid of [
      {},
      { ...archive(), version: 2 },
      { ...archive(), activeBySession: { other: "first" } },
      { ...archive(), chats: { first: { ...archive().chats.first, messages: [null] } } },
    ])
      expect(() => file.save(invalid)).toThrow();
    writeFileSync(`${file.path}.tmp`, "{incomplete");
    expect(file.load()).toEqual(archive());
  });
  it("reports a damaged archive instead of treating it as empty and losing recoverable data", () => {
    const file = library();
    writeFileSync(file.path, "broken archive");
    expect(() => file.load()).toThrow();
    expect(readFileSync(file.path, "utf8")).toBe("broken archive");
  });
});
