import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  stat,
  symlink,
  chmod,
  copyFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  ArchiveStore,
  encodeArchive,
  decodeArchive,
  validateArchive,
  archiveMarkdown,
  readBounded,
} from "../../../src/sidecar/archives/archive.ts";
import {
  packAttachments,
  materializeAttachments,
} from "../../../src/sidecar/archives/attachments.ts";
import { PathAccess } from "../../../src/main/path-access.ts";
import { SideChatLibrary } from "../../../src/main/side-chat-library.ts";
import { MemoryStore } from "../../../src/sidecar/memory/store.ts";
import { initializeStorage, copyVerified } from "../../../src/sidecar/storage/profile.ts";
import { DesktopPreferences } from "../../../src/sidecar/storage/preferences.ts";
import { NativeTransferStore } from "../../../src/sidecar/transfers/native-transfer.ts";
import {
  transferBranches,
  claudeTranscript,
  codexRollout,
} from "../../../src/sidecar/transfers/native-history.ts";
const sha = (value) => createHash("sha256").update(value).digest("hex");
export async function fixture(root) {
  const project = join(root, "项目 Alpha"),
    other = join(root, "Project Beta");
  await mkdir(project, { recursive: true });
  await mkdir(other);
  const store = new MemoryStore(join(root, "memory.sqlite"));
  store.patchPreferences({ longTerm: true, shortTerm: true }, 0);
  const a = store.project("corpus-alpha", project, "Alpha"),
    b = store.project("corpus-beta", other, "Beta");
  const personal = store.create({
    scope: "user",
    kind: "preference",
    content: "Personal preference PERSONAL_IVORY.",
  });
  const local = store.create({
    scope: "project",
    projectId: a.id,
    kind: "decision",
    content: "Project gate ALPHA_JADE.",
  });
  store.create({
    scope: "project",
    projectId: b.id,
    kind: "fact",
    content: "Private Beta label BETA_GARNET.",
  });
  const rows = [
    { type: "session", version: 3, id: "source-elm", cwd: project },
    {
      type: "message",
      id: "u",
      parentId: null,
      timestamp: "2026-01-01T01:00:00Z",
      message: { role: "user", content: "Initial requirement USER_CEDAR." },
    },
    {
      type: "message",
      id: "a",
      parentId: "u",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Proposed solution ASSISTANT_BIRCH." },
          { type: "thinking", thinking: "HIDDEN_CYPRESS" },
          { type: "toolCall", name: "bash", arguments: { command: "DO_NOT_RUN_OAK" } },
        ],
      },
    },
    {
      type: "message",
      id: "fork",
      parentId: "u",
      message: { role: "user", content: "Alternate branch FORK_LARCH." },
    },
  ];
  const session = {
    id: "source-elm",
    title: "Synthetic independent project history",
    jsonl: rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  };
  const archive = {
    format: "pix.archive",
    version: 1,
    createdAt: "2026-09-20T00:00:00Z",
    memories: store.exportRecords(true, a.id),
    suppressions: [],
    sessions: [session],
    sideChats: null,
    warnings: [],
  };
  const archives = new ArchiveStore(join(root, "archives"));
  return { root, project, other, store, a, b, personal, local, rows, session, archive, archives };
}
const side = () => ({
  version: 1,
  activeBySession: { old: "side" },
  chats: {
    side: {
      id: "side",
      sessionKey: "old",
      sessionId: "source-elm",
      selection: { messageId: "u", text: "selected text", context: "source context" },
      sourceMessages: [{ role: "user", text: "source message" }],
      messages: [{ id: "m", role: "user", text: "side question" }],
      draft: "unsent side draft",
      attachments: [],
      settings: { thinkingLevel: "off", serviceTier: "default", accessMode: "full" },
      status: "streaming",
      requestId: "stale",
      error: "",
    },
  },
});
const independentDecode = (bytes) => {
  const envelope = JSON.parse(gunzipSync(bytes));
  assert.equal(sha(envelope.payload), envelope.sha256);
  return JSON.parse(envelope.payload);
};
const storage = [];
const add = (category, id, description, run, requires = []) =>
  storage.push({
    id: `storage.${category}.${id}`,
    suite: "storage",
    category,
    description,
    run,
    requires,
  });
add("scope", "personal-only", "Personal package excludes project records", async (c) => {
  c.archive.memories = c.store.exportRecords(true);
  c.archive.sessions = [];
  const x = independentDecode(await encodeArchive(c.archive));
  assert.deepEqual(
    x.memories.map((m) => m.id),
    [c.personal.id],
  );
});
add(
  "scope",
  "project-only",
  "Project package excludes personal and other-project records",
  async (c) => {
    c.archive.memories = c.store.exportRecords(false, c.a.id);
    const x = independentDecode(await encodeArchive(c.archive));
    assert.deepEqual(
      x.memories.map((m) => m.id),
      [c.local.id],
    );
  },
);
add("scope", "sessions-only", "Conversation-only package carries no memory", async (c) => {
  c.archive.memories = [];
  const x = independentDecode(await encodeArchive(c.archive));
  assert.equal(x.memories.length, 0);
  assert.equal(x.sessions[0].jsonl, c.session.jsonl);
});
add(
  "scope",
  "combined",
  "Combined package retains selected scopes with no unrelated project",
  async (c) => {
    const x = independentDecode(await encodeArchive(c.archive));
    assert.equal(x.memories.length, 2);
    assert.ok(!JSON.stringify(x).includes("BETA_GARNET"));
  },
);
add(
  "scope",
  "disabled-export",
  "Turning both scopes off preserves exportable records",
  async (c) => {
    c.store.patchPreferences({ longTerm: false, shortTerm: false }, c.store.preferences().revision);
    c.archive.memories = c.store.exportRecords(true, c.a.id);
    assert.equal(independentDecode(await encodeArchive(c.archive)).memories.length, 2);
    assert.equal(c.store.context(c.a.id, "gate").records.length, 0);
  },
);
add(
  "sessions",
  "branch-graph",
  "Frozen parent relationships survive native encoding",
  async (c) => {
    const rows = independentDecode(await encodeArchive(c.archive))
      .sessions[0].jsonl.trim()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(
      rows.slice(1).map((r) => [r.id, r.parentId]),
      [
        ["u", null],
        ["a", "u"],
        ["fork", "u"],
      ],
    );
  },
);
add(
  "sessions",
  "many-sessions",
  "Independent session IDs survive beyond management pagination",
  async (c) => {
    c.archive.sessions = Array.from({ length: 125 }, (_, i) => ({
      id: `session-${i}`,
      title: `History ${i}`,
      jsonl:
        JSON.stringify({ type: "session", version: 3, id: `session-${i}`, cwd: c.project }) + "\n",
    }));
    const x = independentDecode(await encodeArchive(c.archive));
    assert.equal(new Set(x.sessions.map((s) => s.id)).size, 125);
  },
);
add("sessions", "side-conversation", "Archive preserves source selection and draft", async (c) => {
  c.archive.sideChats = side();
  const x = independentDecode(await encodeArchive(c.archive));
  assert.equal(x.sideChats.chats.side.draft, "unsent side draft");
  assert.equal(x.sideChats.chats.side.selection.messageId, "u");
});
add(
  "sessions",
  "empty-session",
  "Empty durable session round trips without invented messages",
  async (c) => {
    c.archive.sessions[0].jsonl = JSON.stringify(c.rows[0]) + "\n";
    const x = independentDecode(await encodeArchive(c.archive));
    assert.equal(x.sessions[0].jsonl.trim().split("\n").length, 1);
  },
);
add(
  "sessions",
  "orphan-sidechat",
  "Deleted source session cannot leave an orphan side conversation",
  async (c) => {
    c.archive.sideChats = side();
    c.archive.sessions = [];
    assert.throws(() => validateArchive(c.archive), /orphan_side_chat/);
  },
);
add(
  "format",
  "markdown-visible",
  "Readable export preserves visible branches and omits reasoning",
  async (c) => {
    const md = archiveMarkdown(c.archive);
    assert.ok(
      md.includes("USER_CEDAR") && md.includes("ASSISTANT_BIRCH") && md.includes("FORK_LARCH"),
    );
    assert.ok(!md.includes("HIDDEN_CYPRESS") && !md.includes("DO_NOT_RUN_OAK"));
  },
);
add(
  "format",
  "relative-attachment",
  "Relative attachment is packed and restored by content hash",
  async (c) => {
    await writeFile(join(c.project, "note.txt"), "ATTACHMENT_FIR");
    c.archive.sessions[0].jsonl = c.session.jsonl.replace(
      "USER_CEDAR.",
      "USER_CEDAR. <attached-paths><path>note.txt</path></attached-paths>",
    );
    await packAttachments(c.archive, [c.project], new PathAccess());
    const files = await materializeAttachments(c.archive, join(c.root, "restore"));
    assert.equal(await readFile(files[0], "utf8"), "ATTACHMENT_FIR");
  },
);
add(
  "format",
  "duplicate-attachment",
  "Identical bytes from two names use one archive blob",
  async (c) => {
    await writeFile(join(c.project, "one"), "same-payload");
    await writeFile(join(c.project, "two"), "same-payload");
    c.archive.sessions[0].jsonl = c.session.jsonl.replace(
      "USER_CEDAR.",
      "USER_CEDAR. <attached-paths><path>one</path><path>two</path></attached-paths>",
    );
    await packAttachments(c.archive, [c.project], new PathAccess());
    assert.equal(c.archive.attachments.blobs.length, 1);
    assert.equal(c.archive.attachments.links.length, 2);
  },
);
add(
  "format",
  "missing-attachment",
  "Missing file is reported without creating fake content",
  async (c) => {
    c.archive.sessions[0].jsonl = c.session.jsonl.replace(
      "USER_CEDAR.",
      "USER_CEDAR. <attached-paths><path>absent.pdf</path></attached-paths>",
    );
    await packAttachments(c.archive, [c.project], new PathAccess());
    assert.equal(c.archive.attachments.blobs.length, 0);
    assert.equal(c.archive.warnings.length, 1);
  },
);
add(
  "format",
  "external-authorization",
  "A prose path does not authorize attachment export",
  async (c) => {
    await writeFile(join(c.other, "private"), "PRIVATE_BETA_BYTES");
    c.archive.sessions[0].jsonl = c.session.jsonl.replace(
      "USER_CEDAR.",
      `USER_CEDAR. ${join(c.other, "private")}`,
    );
    await packAttachments(c.archive, [c.project], new PathAccess());
    assert.equal(c.archive.attachments.blobs.length, 0);
  },
);
add("consistency", "checksum", "Changed payload with old digest is rejected", async (c) => {
  const envelope = JSON.parse(gunzipSync(await encodeArchive(c.archive)));
  envelope.payload = envelope.payload.replace("USER_CEDAR", "CHANGED");
  await assert.rejects(decodeArchive(gzipSync(JSON.stringify(envelope))), /checksum/);
});
add("consistency", "partial-tail", "Incomplete JSONL tail prevents publication", async (c) => {
  c.archive.sessions[0].jsonl += '{"type":';
  await assert.rejects(encodeArchive(c.archive));
});
add("consistency", "duplicate-session", "Duplicate source IDs are rejected", async (c) => {
  c.archive.sessions.push(structuredClone(c.session));
  await assert.rejects(encodeArchive(c.archive), /duplicate_session/);
});
add(
  "consistency",
  "missing-parent",
  "Broken ancestry cannot be accepted as complete",
  async (c) => {
    c.archive.sessions[0].jsonl = c.session.jsonl.replace('"parentId":"u"', '"parentId":"absent"');
    await assert.rejects(encodeArchive(c.archive), /invalid_session_parent/);
  },
);
add(
  "consistency",
  "renamed-untrusted",
  "Renaming text to archive suffix does not bypass validation",
  async (c) => {
    const file = join(c.root, "renamed.pixarchive");
    await writeFile(file, "ordinary markdown");
    await assert.rejects(c.archives.import(await readBounded(file)));
  },
);
add("paths", "unified-root", "Unified profile binds all managed service roots", async (c) => {
  const p = await initializeStorage({
    PIX_DATA_DIR: join(c.root, "legacy"),
    PIX_STORAGE_DIR: join(c.root, "unified"),
  });
  assert.equal(p.agent, join(c.root, "unified", "agent"));
  assert.equal(p.memory, join(c.root, "unified", "memory"));
});
add("paths", "external-agent", "Explicit external agent override remains visible", async (c) => {
  const p = await initializeStorage({
    PIX_STORAGE_DIR: join(c.root, "unified"),
    PIX_STORAGE_LOCATOR: join(c.root, "locator"),
    PI_CODING_AGENT_DIR: join(c.root, "external-agent"),
  });
  assert.equal(p.externalAgent, true);
  assert.equal(p.agent, join(c.root, "external-agent"));
});
add("paths", "portable-marker", "Portable marker selects sibling PixData", async (c) => {
  const portable = join(c.root, "portable");
  await mkdir(portable);
  await writeFile(join(portable, "pix-portable.json"), "{}");
  const p = await initializeStorage({
    PIX_DATA_DIR: join(c.root, "legacy"),
    PIX_PORTABLE_ROOT: portable,
  });
  assert.equal(p.mode, "portable");
  assert.equal(p.root, join(portable, "PixData"));
});
add("paths", "unavailable-volume", "Unavailable configured root does not fall back", async (c) => {
  const locator = join(c.root, "locator");
  await writeFile(locator, JSON.stringify({ version: 1, root: join(c.root, "disconnected") }));
  await assert.rejects(
    initializeStorage({ PIX_DATA_DIR: join(c.root, "fallback"), PIX_STORAGE_LOCATOR: locator }),
    /configured_storage_unavailable/,
  );
});
add("paths", "relative-root", "Relative storage root is rejected", async (c) => {
  await assert.rejects(
    initializeStorage({
      PIX_STORAGE_DIR: "relative-dir",
      PIX_STORAGE_LOCATOR: join(c.root, "locator"),
    }),
    /absolute/,
  );
});
add("migration", "copied-bytes", "Verified copy preserves nested bytes and source", async (c) => {
  const source = join(c.root, "old"),
    target = join(c.root, "new");
  await mkdir(join(source, "nested"), { recursive: true });
  await writeFile(join(source, "nested", "data"), "MIGRATION_WILLOW");
  assert.equal(await copyVerified(source, target), 1);
  assert.equal(await readFile(join(target, "nested", "data"), "utf8"), "MIGRATION_WILLOW");
  assert.equal(await readFile(join(source, "nested", "data"), "utf8"), "MIGRATION_WILLOW");
});
add(
  "migration",
  "preferences",
  "File-backed preference initialization preserves newer local values",
  async (c) => {
    const p = new DesktopPreferences(join(c.root, "preferences"));
    await p.patch({ "pix.theme": "dark" }, true);
    await p.patch({ "pix.theme": "light" }, true);
    assert.equal((await p.read())["pix.theme"], "dark");
  },
);
add(
  "migration",
  "preference-concurrency",
  "Concurrent preference updates do not drop sibling keys",
  async (c) => {
    const p = new DesktopPreferences(join(c.root, "preferences"));
    await Promise.all([
      p.patch({ "pix.a": "A" }),
      p.patch({ "pix.b": "B" }),
      p.patch({ "pix.c": "C" }),
    ]);
    assert.deepEqual(await p.read(), { "pix.a": "A", "pix.b": "B", "pix.c": "C" });
  },
);
add(
  "migration",
  "sqlite-identity",
  "Closed SQLite copy keeps instance, records and suppression",
  async (c) => {
    const id = c.store.instanceId();
    c.store.forget([c.local.id]);
    c.store.close();
    const source = join(c.root, "closed-source"),
      target = join(c.root, "closed-target");
    await mkdir(source);
    await copyFile(join(c.root, "memory.sqlite"), join(source, "memory.sqlite"));
    await copyVerified(source, target);
    const restored = new MemoryStore(join(target, "memory.sqlite"));
    try {
      assert.equal(restored.instanceId(), id);
      assert.equal(restored.exportSuppressions(false, c.a.id).length, 1);
    } finally {
      restored.close();
    }
  },
);
add(
  "migration",
  "private-permissions",
  "Preference files are not group/world readable on POSIX",
  async (c) => {
    if (process.platform === "win32")
      return { status: "blocked", reason: "requires_windows_acl_inspection" };
    const file = join(c.root, "preferences");
    await new DesktopPreferences(file).patch({ "pix.theme": "dark" });
    assert.equal((await stat(file)).mode & 0o077, 0);
  },
);
add(
  "recovery",
  "existing-destination",
  "Interrupted copy does not overwrite existing files",
  async (c) => {
    const source = join(c.root, "old"),
      target = join(c.root, "new");
    await mkdir(source);
    await mkdir(target);
    await writeFile(join(source, "data"), "old");
    await writeFile(join(target, "data"), "newer");
    await assert.rejects(copyVerified(source, target));
    assert.equal(await readFile(join(target, "data"), "utf8"), "newer");
  },
);
add("recovery", "symlink-refusal", "Migration refuses an external symlink", async (c) => {
  if (process.platform === "win32")
    return { status: "blocked", reason: "symlink_privilege_required" };
  const source = join(c.root, "symlink-source");
  await mkdir(source);
  await writeFile(join(c.other, "outside"), "outside");
  await symlink(join(c.other, "outside"), join(source, "link"));
  await assert.rejects(copyVerified(source, join(c.root, "copied")), /symlink/);
});
add(
  "recovery",
  "partial-migration",
  "Preexisting partial root preserves original profile",
  async (c) => {
    const old = join(c.root, "old"),
      target = join(c.root, "partial"),
      locator = join(c.root, "locator");
    await mkdir(old);
    await mkdir(target);
    await writeFile(join(old, "marker"), "retain");
    await writeFile(
      locator,
      JSON.stringify({ version: 1, pending: { id: "m", root: target, desktop: old } }),
    );
    const p = await initializeStorage({ PIX_DATA_DIR: old, PIX_STORAGE_LOCATOR: locator });
    assert.equal(p.root, old);
    assert.ok(p.migrationError.includes("incomplete"));
    assert.equal(await readFile(join(old, "marker"), "utf8"), "retain");
  },
);
add("recovery", "invalid-locator", "Corrupt locator fails explicitly", async (c) => {
  const locator = join(c.root, "locator");
  await writeFile(locator, '{"version":99}');
  await assert.rejects(
    initializeStorage({ PIX_DATA_DIR: join(c.root, "legacy"), PIX_STORAGE_LOCATOR: locator }),
    /invalid_storage_locator/,
  );
});
add("recovery", "unknown-schema", "Newer memory schema is not silently downgraded", async (c) => {
  const { DatabaseSync } = await import("node:sqlite");
  const file = join(c.root, "future.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA user_version=999");
  db.close();
  assert.throws(() => new MemoryStore(file), /unsupported_memory_schema/);
});
add("platform", "unicode-path", "Unicode storage path survives durable preferences", async (c) => {
  const file = join(c.root, "设置-é-🧪", "preferences.json");
  await new DesktopPreferences(file).patch({ "pix.memory": "长期与短期" });
  assert.equal((await new DesktopPreferences(file).read())["pix.memory"], "长期与短期");
});
add(
  "platform",
  "macos-arm64-installed",
  "Installed macOS arm64 package runs memory smoke",
  async (c) => c.platform("aarch64-apple-darwin"),
  ["installed-package"],
);
add(
  "platform",
  "macos-x64-installed",
  "Installed macOS x64 package runs memory smoke",
  async (c) => c.platform("x86_64-apple-darwin"),
  ["installed-package"],
);
add(
  "platform",
  "windows-installed",
  "Installed Windows NSIS package runs memory smoke",
  async (c) => c.platform("x86_64-pc-windows-msvc"),
  ["installed-package"],
);
add(
  "platform",
  "linux-installed",
  "Extracted Linux package runs memory smoke",
  async (c) => c.platform("x86_64-unknown-linux-gnu"),
  ["installed-package"],
);
export const storageCases = storage;
const native = [];
const n = (category, id, description, run, requires = []) =>
  native.push({
    id: `native.${category}.${id}`,
    suite: "native",
    category,
    description,
    run,
    requires,
  });
n("pix", "logical-roundtrip", "Native round trip preserves complete logical payload", async (c) =>
  assert.deepEqual(await decodeArchive(await encodeArchive(c.archive)), c.archive),
);
n("pix", "reimport-idempotent", "Repeated archive imports retain one object", async (c) => {
  const bytes = await encodeArchive(c.archive);
  const a = await c.archives.import(bytes),
    b = await c.archives.import(bytes);
  assert.equal(a.id, b.id);
  assert.equal((await c.archives.list()).length, 1);
});
n(
  "pix",
  "disabled-adoption",
  "Disabled memory scopes reject adoption while archive stays available",
  async (c) => {
    const imported = await c.archives.import(await encodeArchive(c.archive));
    c.store.patchPreferences({ longTerm: false, shortTerm: false }, c.store.preferences().revision);
    assert.throws(() => c.store.importRecords(c.archive.memories, true, c.a.id), /scope_disabled/);
    assert.equal((await c.archives.read(imported.id)).memories.length, 2);
  },
);
n(
  "pix",
  "nonempty-newer-target",
  "Existing local correction is preserved during adoption",
  async (c) => {
    c.store.update({
      id: c.local.id,
      expectedRevision: c.local.revision,
      content: "Current corrected gate ALPHA_OLIVE.",
    });
    c.store.importRecords(c.archive.memories, true, c.a.id);
    const contents = c.store
      .context(c.a.id, "gate")
      .records.map((r) => r.content)
      .join("\n");
    assert.ok(contents.includes("ALPHA_OLIVE"));
    assert.ok(!contents.includes("ALPHA_JADE"));
  },
);
n(
  "pix",
  "continuation-journal",
  "Continuation journal reuses the restored session path",
  async (c) => {
    const imported = await c.archives.import(await encodeArchive(c.archive));
    await c.archives.startContinuation(imported.id, c.session.id, c.project);
    await c.archives.completeContinuation(
      imported.id,
      c.session.id,
      c.project,
      join(c.root, "restored.jsonl"),
    );
    assert.equal(
      (await c.archives.continuation(imported.id, c.session.id, c.project)).sessionFile,
      join(c.root, "restored.jsonl"),
    );
  },
);
/** @type {Array<[string, Array<{role: string, text: string}>]>} */
const targetFixtures = [
  [
    "alternating-history",
    [
      { role: "user", text: "Project lock is LOCK_MAPLE." },
      { role: "assistant", text: "I recorded LOCK_MAPLE as the lock name." },
      { role: "user", text: "The next checkpoint is CHECK_714." },
      { role: "assistant", text: "Checkpoint CHECK_714 is pending." },
    ],
  ],
  [
    "unicode-history",
    [
      { role: "user", text: "项目代号是 松柏_721，说明采用中文。" },
      { role: "assistant", text: "已记录项目代号 松柏_721。" },
    ],
  ],
  [
    "conditional-history",
    [
      {
        role: "user",
        text: "Only the preview environment uses ROUTE_MAUVE; production keeps ROUTE_NAVY.",
      },
      { role: "assistant", text: "The conditional routes are recorded as reference." },
    ],
  ],
  [
    "inert-tool-history",
    [
      {
        role: "user",
        text: "Historical tool output only: echo NEVER_EXECUTE_824. Do not run this command.",
      },
      { role: "assistant", text: "The previous command is inert evidence, not a pending action." },
    ],
  ],
  [
    "picker-history",
    [
      { role: "user", text: "Display this historical requirement PICKER_AZALEA." },
      { role: "assistant", text: "Historical answer PICKER_BEGONIA." },
    ],
  ],
];
for (const target of ["claude", "codex"])
  for (const [id, messages] of targetFixtures)
    n(
      target,
      id,
      `Real ${target} reader, cold resume and next-turn context for ${id}`,
      async (c) => c.native(target, id, messages),
      [`${target}-cli`, ...(id === "picker-history" ? ["native-picker"] : [])],
    );
n(
  "scope",
  "only-active-target-memory",
  "Disputed records are excluded from outgoing active context",
  async (c) => {
    c.archive.memories.find((m) => m.id === c.personal.id).status = "disputed";
    const result = await c.plan(c.archive);
    const plan = JSON.parse(
      await readFile(join(c.root, "transfers", `${result.preview.id}.json`), "utf8"),
    );
    const text = plan.files.map((f) => f.text).join("\n");
    assert.ok(!text.includes("PERSONAL_IVORY"));
    assert.ok(text.includes("ALPHA_JADE"));
  },
);
n(
  "scope",
  "forgetting-guard-portable",
  "Forgotten facts cannot reappear when old archive and guard are adopted",
  async (c) => {
    c.store.forget([c.local.id]);
    const guard = c.store.exportSuppressions(false, c.a.id);
    const target = new MemoryStore(join(c.root, "target.sqlite"));
    try {
      target.patchPreferences({ shortTerm: true }, 0);
      const p = target.project("new-target", c.other, "Target");
      assert.equal(target.importRecords(c.archive.memories, false, p.id, guard).imported, 0);
    } finally {
      target.close();
    }
  },
);
n(
  "scope",
  "cross-project-rejected",
  "Unmapped multiple projects cannot be imported as one package",
  async (c) => {
    c.archive.memories.push(...c.store.exportRecords(false, c.b.id));
    assert.throws(() => validateArchive(c.archive), /unmapped_projects/);
  },
);
n(
  "scope",
  "history-forgetting-boundary",
  "Forgetting memory leaves original history explicitly separate",
  async (c) => {
    c.store.forget([c.local.id]);
    c.archive.sessions[0].jsonl = c.session.jsonl.replace("USER_CEDAR", "ALPHA_JADE");
    c.archive.memories = c.store.exportRecords(false, c.a.id);
    const x = independentDecode(await encodeArchive(c.archive));
    assert.equal(x.memories.length, 0);
    assert.ok(x.sessions[0].jsonl.includes("ALPHA_JADE"));
  },
);
n("scope", "source-guard", "Copied source suppression prevents re-extraction", async (c) => {
  const job = c.store.beginLearning(c.store.preferences().epoch, c.a.id, [
    {
      sessionId: "guard-source",
      entryId: "source-e",
      text: "Alpha archive marker SOURCE_SEQUOIA.",
    },
  ]);
  if (!job) {
    c.store.patchPreferences({ dailyTokenBudget: 100000 }, c.store.preferences().revision);
  }
  const next =
    job ??
    c.store.beginLearning(c.store.preferences().epoch, c.a.id, [
      {
        sessionId: "guard-source",
        entryId: "source-e",
        text: "Alpha archive marker SOURCE_SEQUOIA.",
      },
    ]);
  c.store.finishLearning(next.id, [
    {
      scope: "project",
      kind: "fact",
      content: "Alpha archive marker SOURCE_SEQUOIA.",
      quote: "Alpha archive marker SOURCE_SEQUOIA.",
      entryId: "source-e",
    },
  ]);
  const record = c.store
    .exportRecords(false, c.a.id)
    .find((r) => r.content.includes("SOURCE_SEQUOIA"));
  c.store.forget([record.id]);
  assert.equal(
    c.store.beginLearning(c.store.preferences().epoch, c.a.id, [
      { sessionId: "guard-source", entryId: "source-e", text: "A paraphrase of the old fact." },
    ]),
    null,
  );
});
n(
  "content",
  "fork-separation",
  "Mutually exclusive leaves become separate target conversations",
  async (c) => {
    const branches = transferBranches(c.session);
    assert.equal(branches.length, 2);
    assert.ok(
      branches.every(
        (b) =>
          !b.messages.some((m) => m.text.includes("ASSISTANT_BIRCH")) ||
          !b.messages.some((m) => m.text.includes("FORK_LARCH")),
      ),
    );
  },
);
n(
  "content",
  "sidechat-restoration",
  "Sidechat restore binds new identity without old access permissions",
  async (c) => {
    const library = new SideChatLibrary(join(c.root, "desktop"));
    const result = library.restore(side(), "source-elm", {
      sessionId: "new-session",
      sessionFile: join(c.root, "new.jsonl"),
    });
    const chat = Object.values(result.chats)[0];
    assert.equal(chat.sessionId, "new-session");
    assert.equal(chat.status, "stopped");
    assert.equal(chat.settings.accessMode, "default");
    assert.equal(chat.requestId, undefined);
  },
);
n(
  "content",
  "hidden-exclusion",
  "Invisible reasoning and tool arguments never reach target encoding",
  async (c) => {
    const branch = transferBranches(c.session)[0];
    const text =
      claudeTranscript(branch, c.project, "2.1.87").jsonl +
      codexRollout(branch, c.project, "0.155.0-alpha.9.2").jsonl;
    assert.ok(!text.includes("HIDDEN_CYPRESS") && !text.includes("DO_NOT_RUN_OAK"));
    assert.ok(text.includes("arguments not replayed"));
  },
);
n(
  "content",
  "restore-missing-original",
  "Packed attachment remains readable after source removal",
  async (c) => {
    await writeFile(join(c.project, "photo.txt"), "PERSISTENT_MEDIA");
    c.archive.sessions[0].jsonl = c.session.jsonl.replace(
      "USER_CEDAR.",
      "USER_CEDAR. <attached-paths><path>photo.txt</path></attached-paths>",
    );
    await packAttachments(c.archive, [c.project], new PathAccess());
    await rm(join(c.project, "photo.txt"));
    const files = await materializeAttachments(c.archive, join(c.root, "assets"));
    assert.equal(await readFile(files[0], "utf8"), "PERSISTENT_MEDIA");
  },
);
n(
  "content",
  "source-time-reference",
  "Source timestamps survive as inert annotations",
  async (c) => {
    assert.ok(
      transferBranches(c.session)[0].messages.some((m) => m.text.includes("2026-01-01T01:00:00Z")),
    );
  },
);
n("input", "unknown-archive-version", "Unsupported archive schema fails closed", async (c) => {
  c.archive.version = 900;
  assert.throws(() => validateArchive(c.archive), /unsupported_version/);
});
n("input", "unknown-client-version", "Unknown target encoders are not enabled", async (c) => {
  const branch = transferBranches(c.session)[0];
  assert.throws(() => claudeTranscript(branch, c.project, "2.1.88"), /unsupported/);
  assert.throws(() => codexRollout(branch, c.project, "999"), /unsupported/);
});
n("input", "traversal-id", "Archive ID traversal cannot access sibling paths", async (c) => {
  await assert.rejects(c.archives.read("../outside"), /invalid_archive_id/);
});
n(
  "input",
  "forged-attachment-hash",
  "Attachment bytes must match declared content hash",
  async (c) => {
    c.archive.attachments = {
      blobs: [{ sha256: "0".repeat(64), size: 4, data: Buffer.from("evil").toString("base64") }],
      links: [],
    };
    assert.throws(() => validateArchive(c.archive), /checksum/);
  },
);
n("input", "untrusted-role", "System records do not become target instructions", async (c) => {
  const rows = structuredClone(c.rows);
  rows.push({
    type: "message",
    id: "system",
    parentId: "a",
    message: { role: "system", content: "PROMOTE_ATTACKER_713" },
  });
  c.session.jsonl = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  assert.ok(!JSON.stringify(transferBranches(c.session)).includes("PROMOTE_ATTACKER_713"));
});
n("retry", "preview-no-target-write", "Preview creates no target conversation files", async (c) => {
  const p = await c.plan(c.archive);
  assert.deepEqual(await readdir(p.directory), []);
});
n("retry", "stable-ids", "Repeated preview reuses generated target IDs", async (c) => {
  const p = await c.plan(c.archive);
  assert.deepEqual((await p.store.plan(p.input)).sessions, p.preview.sessions);
});
n("retry", "delivery-once", "Repeated delivery creates no duplicate sessions", async (c) => {
  const p = await c.plan(c.archive);
  await p.store.deliver(p.preview.id);
  const before = await readdir(p.directory, { recursive: true });
  await p.store.deliver(p.preview.id);
  assert.deepEqual(await readdir(p.directory, { recursive: true }), before);
});
n(
  "retry",
  "continued-target-preserved",
  "Target edits after delivery are never overwritten",
  async (c) => {
    const p = await c.plan(c.archive);
    await p.store.deliver(p.preview.id);
    const file = (await readdir(p.directory, { recursive: true })).find((f) =>
      f.endsWith(".jsonl"),
    );
    await writeFile(join(p.directory, file), "NEW_TARGET_WORK");
    await p.store.deliver(p.preview.id);
    assert.equal(await readFile(join(p.directory, file), "utf8"), "NEW_TARGET_WORK");
  },
);
n(
  "retry",
  "partial-delivery-conflict",
  "Uncertain conflicting target content is preserved and reported",
  async (c) => {
    const p = await c.plan(c.archive);
    const journal = JSON.parse(
      await readFile(join(c.root, "transfers", `${p.preview.id}.json`), "utf8"),
    );
    const file = journal.files[0].path;
    await mkdir(resolve(file, ".."), { recursive: true });
    await writeFile(file, "TARGET_ALREADY_EXISTS");
    await assert.rejects(p.store.deliver(p.preview.id), /Target conversation changed/);
    assert.equal(await readFile(file, "utf8"), "TARGET_ALREADY_EXISTS");
  },
);
n(
  "destination",
  "unicode-data-root",
  "Unicode target directory is preserved in preview and delivery",
  async (c) => {
    const p = await c.plan(c.archive, "目标-资料-é");
    assert.ok(p.preview.directory.includes("目标-资料-é"));
    await p.store.deliver(p.preview.id);
    assert.ok((await readdir(p.directory, { recursive: true })).some((f) => f.endsWith(".jsonl")));
  },
);
n(
  "destination",
  "client-version-change",
  "Changed CLI version blocks the planned delivery",
  async (c) => {
    const p = await c.plan(c.archive);
    await writeFile(
      p.binary,
      process.platform === "win32"
        ? "@echo codex-cli 999\r\n"
        : '#!/bin/sh\nprintf "codex-cli 999\\n"\n',
    );
    await assert.rejects(p.store.deliver(p.preview.id), /Unsupported/);
    assert.deepEqual(await readdir(p.directory), []);
  },
);
n(
  "destination",
  "no-auto-memory-write",
  "Migration does not write AGENTS.md or target automatic memory",
  async (c) => {
    const p = await c.plan(c.archive);
    await p.store.deliver(p.preview.id);
    const names = await readdir(p.directory, { recursive: true });
    assert.ok(names.every((n) => !/(AGENTS|CLAUDE|MEMORY)\.md$/.test(n)));
  },
);
n("destination", "no-model-delivery", "Delivery only probes selected CLI version", async (c) => {
  const p = await c.plan(c.archive);
  await p.store.deliver(p.preview.id);
  assert.deepEqual((await readFile(p.calls, "utf8")).trim().split("\n"), [
    "--version",
    "--version",
  ]);
});
n(
  "destination",
  "unsupported-ui-honesty",
  "Preview states that desktop and IDE clients are unverified",
  async (c) => {
    const p = await c.plan(c.archive);
    assert.ok(
      p.preview.warnings.some((w) => w.includes("desktop/IDE") && w.includes("not verified")),
    );
  },
);
export const nativeCases = native;
export async function syntheticPlan(c, archive, directoryName = "target") {
  if (process.platform === "win32")
    throw new Error(
      "blocked:version-probe fixture requires POSIX; real-client jobs cover Windows delivery separately",
    );
  const directory = join(c.root, directoryName),
    binary = join(c.root, "version-probe"),
    calls = join(c.root, "version-calls");
  await mkdir(directory);
  const escaped = calls.replaceAll("'", "'\\''");
  await writeFile(
    binary,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${escaped}'\nprintf 'codex-cli 0.155.0-alpha.9.2\\n'\n`,
    { mode: 0o700 },
  );
  await chmod(binary, 0o700);
  const store = new NativeTransferStore(join(c.root, "transfers"));
  const input = {
    archiveId: sha(JSON.stringify(archive)),
    archive,
    target: "codex",
    binary,
    directory,
    cwd: c.project,
  };
  const preview = await store.plan(input);
  return { store, input, preview, directory, binary, calls };
}
