import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathAccess } from "../../main/path-access.ts";
import { SideChatLibrary } from "../../main/side-chat-library.ts";
import { ArchiveStore, encodeArchive, validateArchive, type PixArchive } from "./archive.ts";
import { packAttachments, materializeAttachments, validateAttachments } from "./attachments.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pix-attachment-roundtrip-"));
  roots.push(root);
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "notes.txt"), "portable-content");
  const archive: PixArchive = {
    format: "pix.archive",
    version: 1,
    createdAt: new Date().toISOString(),
    memories: [],
    warnings: [],
    sessions: [
      {
        id: "source",
        title: "source",
        jsonl:
          [
            { type: "session", version: 3, id: "source", cwd: project },
            {
              type: "message",
              id: "user",
              parentId: null,
              message: {
                role: "user",
                content: "hello\n<attached-paths><path>notes.txt</path></attached-paths>",
              },
            },
          ]
            .map((row) => JSON.stringify(row))
            .join("\n") + "\n",
      },
    ],
    sideChats: {
      version: 1,
      activeBySession: { old: "side" },
      chats: {
        side: {
          id: "side",
          sessionKey: "old",
          sessionId: "source",
          selection: { messageId: "user", text: "hello", context: "hello" },
          sourceMessages: [],
          messages: [{ id: "u", role: "user", text: "explain", attachments: ["notes.txt"] }],
          draft: "draft",
          attachments: ["notes.txt"],
          status: "streaming",
          requestId: "old-running",
          settings: { accessMode: "full", thinkingLevel: "off", serviceTier: "default" },
          error: "",
        },
      },
    },
  };
  return { root, project, archive };
}
it("packs once, survives deletion of originals, remaps session and side chat, and verifies on cold read", async () => {
  const { root, project, archive } = await fixture();
  await packAttachments(archive, [project], new PathAccess());
  expect(archive.attachments?.blobs).toHaveLength(1);
  expect(archive.attachments?.links).toHaveLength(1);
  expect(archive.warnings).toEqual([]);
  const store = new ArchiveStore(join(root, "archives"));
  const imported = await store.import(await encodeArchive(archive));
  await rm(project, { recursive: true });
  const restored = await store.prepareSession(imported.id, "source");
  expect(await readFile(restored.attachments[0]!, "utf8")).toBe("portable-content");
  // JSONL is JSON-encoded; on Windows backslashes are escaped, so compare against the JSON-encoded path.
  expect(await readFile(restored.path, "utf8")).toContain(
    JSON.stringify(restored.attachments[0]!).slice(1, -1),
  );
  expect(restored.sideChats.chats.side?.attachments).toEqual(restored.attachments);
  const side = new SideChatLibrary(join(root, "desktop"));
  const target = { sessionId: "new", sessionFile: join(root, "new.jsonl") };
  const result = side.restore(restored.sideChats, "source", target);
  const chat = Object.values(result.chats)[0]!;
  expect(chat.status).toBe("stopped");
  expect(chat.requestId).toBeUndefined();
  expect(chat.settings.accessMode).toBe("default");
  expect(chat.sessionId).toBe("new");
  const saved = side.load();
  saved.chats[chat.id]!.draft = "newer";
  side.save(saved);
  side.restore(restored.sideChats, "source", target);
  expect(side.load().chats[chat.id]?.draft).toBe("newer");
  expect(Object.keys(side.load().chats)).toHaveLength(1);
  expect(
    (await new ArchiveStore(join(root, "archives")).prepareSession(imported.id, "source"))
      .attachments,
  ).toEqual(restored.attachments);
});
it("reports missing and unauthorized paths without reading prose links or escaping symlinks", async () => {
  const { root, project, archive } = await fixture();
  const secret = join(root, "secret.txt");
  await writeFile(secret, "outside-secret");
  await symlink(secret, join(project, "linked"));
  // Inject paths by editing parsed rows; string replacement would embed unescaped backslashes into JSON on Windows.
  const rows = archive.sessions[0]!.jsonl.trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { message?: { content?: string } });
  rows[1]!.message!.content = rows[1]!.message!.content!.replace(
    "<path>notes.txt</path>",
    `<path>linked</path><path>missing</path><path>${secret}</path>`,
  );
  archive.sessions[0]!.jsonl = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  archive.sideChats = null;
  await packAttachments(archive, [project], new PathAccess());
  expect(archive.warnings).toHaveLength(3);
  expect(archive.attachments?.blobs).toEqual([]);
  expect(JSON.stringify(archive)).not.toContain("outside-secret");
  const access = new PathAccess();
  access.grant(secret);
  await packAttachments(archive, [project], access);
  expect(archive.attachments?.blobs).toHaveLength(1);
});
it("rejects tampered bytes, traversal names, dangling links and side chat sessions before any restore", async () => {
  const { project, archive } = await fixture();
  await packAttachments(archive, [project], new PathAccess());
  const data = archive.attachments!;
  const bad = structuredClone(data);
  bad.blobs[0]!.data = Buffer.from("wrong").toString("base64");
  expect(() => validateAttachments(bad, new Set(["source"]))).toThrow("checksum");
  for (const name of ["../../escape", ".", "..", "a/b", "a\\b"]) {
    const bad = structuredClone(data);
    bad.links[0]!.name = name;
    expect(() => validateAttachments(bad, new Set(["source"]))).toThrow("link");
  }
  expect(() => validateAttachments(data, new Set())).toThrow("link");
  const broken = structuredClone(archive);
  broken.sessions = [];
  expect(() => validateArchive(broken)).toThrow("orphan_side_chat");
});
it("refuses a changed materialized file instead of silently using it", async () => {
  const { root, project, archive } = await fixture();
  await packAttachments(archive, [project], new PathAccess());
  const output = join(root, "restored");
  const files = await materializeAttachments(structuredClone(archive), output);
  await writeFile(files[0]!, "tampered");
  await expect(materializeAttachments(structuredClone(archive), output)).rejects.toThrow(
    "materialization_mismatch",
  );
});
