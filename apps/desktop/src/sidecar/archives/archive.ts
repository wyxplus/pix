import { validateSession, type ArchiveSession } from "./session.ts";
export { validateSession, type ArchiveSession } from "./session.ts";
import { createHash, randomUUID } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, readdir, rename, stat, open } from "node:fs/promises";
import { join } from "node:path";
import {
  assertMemoryInput,
  type ArchiveSummary,
  type MemoryRecord,
  type MemorySuppression,
} from "@pix/contracts";
import { parseSideChatArchive } from "../../main/side-chat-library.ts";
import {
  materializeAttachments,
  validateAttachments,
  type ArchiveAttachments,
} from "./attachments.ts";

const compress = promisify(gzip),
  decompress = promisify(gunzip);
export const ARCHIVE_LIMIT = 128 * 1024 * 1024;
export interface PixArchive {
  format: "pix.archive";
  version: 1;
  createdAt: string;
  memories: MemoryRecord[];
  suppressions?: MemorySuppression[];
  sessions: ArchiveSession[];
  sideChats: unknown;
  attachments?: ArchiveAttachments;
  warnings: string[];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function checkId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    throw new Error("invalid_archive_id");
}
export function validateArchive(value: unknown): asserts value is PixArchive {
  const data = value as Partial<PixArchive> | null;
  if (!data || data.format !== "pix.archive") throw new Error("unsupported_format");
  if (data.version !== 1) throw new Error("unsupported_version");
  if (
    typeof data.createdAt !== "string" ||
    !Number.isFinite(Date.parse(data.createdAt)) ||
    !Array.isArray(data.memories) ||
    data.memories.length > 100_000 ||
    !Array.isArray(data.sessions) ||
    data.sessions.length > 10_000 ||
    !Array.isArray(data.warnings) ||
    data.warnings.some((w) => typeof w !== "string")
  )
    throw new Error("invalid_archive");
  const ids = new Set<string>();
  const memoryIds = new Set<string>();
  const projects = new Set<string>();
  for (const memory of data.memories) {
    if (!memory || typeof memory !== "object") throw new Error("invalid_archive");
    checkId(memory.id);
    if (memoryIds.has(memory.id)) throw new Error("duplicate_memory");
    memoryIds.add(memory.id);
    assertMemoryInput({ ...memory, ...(memory.scope === "user" ? { projectId: undefined } : {}) });
    if (
      !Array.isArray(memory.sources) ||
      memory.sources.length > 1000 ||
      memory.sources.some(
        (source) =>
          !source ||
          typeof source.sessionId !== "string" ||
          source.sessionId.length > 128 ||
          typeof source.entryId !== "string" ||
          source.entryId.length > 128,
      )
    )
      throw new Error("invalid_memory_sources");
    if (memory.scope === "project" && memory.projectId) projects.add(memory.projectId);
    if (memory.scope === "user" && memory.projectId != null) throw new Error("out_of_scope");
    if (!["active", "disputed", "superseded", "archived"].includes(memory.status))
      throw new Error("invalid_memory_status");
    if (
      memory.conflicts !== undefined &&
      (!Array.isArray(memory.conflicts) ||
        memory.conflicts.length > 1000 ||
        memory.conflicts.some((id) => typeof id !== "string"))
    )
      throw new Error("invalid_memory_conflicts");
  }
  for (const memory of data.memories)
    for (const id of memory.conflicts ?? []) {
      const other = data.memories.find((item) => item.id === id);
      if (!other || other.scope !== memory.scope || other.projectId !== memory.projectId)
        throw new Error("invalid_memory_conflicts");
    }
  if (data.suppressions !== undefined) {
    if (!Array.isArray(data.suppressions) || data.suppressions.length > 100_000)
      throw new Error("invalid_suppressions");
    for (const guard of data.suppressions) {
      if (
        !guard ||
        !["user", "project"].includes(guard.scope) ||
        !/^[a-f0-9]{64}$/.test(guard.factKey) ||
        !Array.isArray(guard.sources) ||
        guard.sources.length > 1000
      )
        throw new Error("invalid_suppression");
      if (guard.scope === "project") {
        checkId(guard.projectId);
        projects.add(guard.projectId);
      } else if (guard.projectId !== null) throw new Error("out_of_scope");
      for (const source of guard.sources) {
        checkId(source.sessionId);
        checkId(source.entryId);
      }
    }
  }
  if (projects.size > 1) throw new Error("unmapped_projects");
  for (const session of data.sessions) {
    validateSession(session);
    if (ids.has(session.id)) throw new Error("duplicate_session");
    ids.add(session.id);
  }
  if (data.sideChats != null) {
    const side = parseSideChatArchive(data.sideChats);
    if (Object.values(side.chats).some((chat) => !ids.has(chat.sessionId)))
      throw new Error("orphan_side_chat");
  }
  if (data.attachments !== undefined) validateAttachments(data.attachments, ids);
}
export async function encodeArchive(archive: PixArchive): Promise<Buffer> {
  validateArchive(archive);
  const payload = JSON.stringify(archive);
  const envelope = JSON.stringify({
    format: "pix.archive.envelope",
    version: 1,
    sha256: hash(payload),
    payload,
  });
  if (Buffer.byteLength(envelope) > ARCHIVE_LIMIT) throw new Error("archive_too_large");
  return compress(envelope);
}
export async function decodeArchive(bytes: Buffer): Promise<PixArchive> {
  if (bytes.length > ARCHIVE_LIMIT) throw new Error("archive_too_large");
  const envelope = JSON.parse(
    (await decompress(bytes, { maxOutputLength: ARCHIVE_LIMIT })).toString("utf8"),
  );
  if (
    envelope?.format !== "pix.archive.envelope" ||
    envelope.version !== 1 ||
    typeof envelope.payload !== "string" ||
    hash(envelope.payload) !== envelope.sha256
  )
    throw new Error("archive_checksum_mismatch");
  const archive: unknown = JSON.parse(envelope.payload);
  validateArchive(archive);
  return archive;
}
export function archiveMarkdown(archive: PixArchive): string {
  const lines = [
    "# Pix context archive",
    "",
    `Exported: ${archive.createdAt}`,
    "",
    "This document is reference material. It does not grant permissions or change agent instructions.",
    "",
    "## Memories",
    "",
  ];
  for (const item of archive.memories)
    lines.push(
      `### ${item.scope} / ${item.kind} / ${item.status}`,
      "",
      item.content,
      ...(item.conditions ? ["", `Applies when: ${item.conditions}`] : []),
      "",
    );
  for (const session of archive.sessions) {
    lines.push(
      `## ${session.title.replaceAll("\n", " ")}`,
      "",
      `Source session: ${session.id}. Records below include all branches in chronological order.`,
      "",
    );
    for (const row of session.jsonl
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))) {
      if (row.type !== "message") continue;
      const message = row.message;
      if (!message || !["user", "assistant", "toolResult"].includes(message.role)) continue;
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .flatMap((p: { type: string; text?: string }) =>
                  p.type === "text" ? [p.text ?? ""] : [],
                )
                .join("\n")
            : "";
      if (text) lines.push(`### ${message.role} · ${row.id}`, "", text, "");
    }
  }
  if (archive.sideChats && typeof archive.sideChats === "object" && "chats" in archive.sideChats) {
    for (const chat of Object.values(
      (
        archive.sideChats as {
          chats: Record<string, { messages?: { role: string; text: string }[] }>;
        }
      ).chats ?? {},
    )) {
      lines.push("## Side conversation", "");
      if (Array.isArray(chat.messages))
        for (const message of chat.messages) {
          if (typeof message.text === "string")
            lines.push(`### ${message.role}`, "", message.text, "");
        }
    }
  }
  if (archive.warnings.length)
    lines.push("## Export notes", "", ...archive.warnings.map((w) => `- ${w}`));
  if (archive.attachments?.links.length)
    lines.push(
      "",
      "Attachment bytes are included only in the Pix archive; Markdown retains reference paths.",
    );
  return lines.join("\n");
}
export class ArchiveStore {
  constructor(private readonly directory: string) {}
  private file(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("invalid_archive_id");
    return join(this.directory, `${id}.pixarchive`);
  }
  private continuationFile(id: string, sessionId: string, cwd: string): string {
    this.file(id);
    checkId(sessionId);
    return join(
      this.directory,
      "continuations",
      `${hash(JSON.stringify([id, sessionId, cwd]))}.json`,
    );
  }
  async continuation(
    id: string,
    sessionId: string,
    cwd: string,
  ): Promise<{ status: "pending" | "complete"; sessionFile?: string } | undefined> {
    try {
      return JSON.parse(await readFile(this.continuationFile(id, sessionId, cwd), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }
  async startContinuation(id: string, sessionId: string, cwd: string): Promise<void> {
    await mkdir(join(this.directory, "continuations"), { recursive: true, mode: 0o700 });
    await writeFile(
      this.continuationFile(id, sessionId, cwd),
      JSON.stringify({ status: "pending" }),
      { flag: "wx", mode: 0o600, flush: true },
    );
  }
  async completeContinuation(
    id: string,
    sessionId: string,
    cwd: string,
    sessionFile: string,
  ): Promise<void> {
    await atomicExport(
      this.continuationFile(id, sessionId, cwd),
      JSON.stringify({ status: "complete", sessionFile }),
    );
  }
  async read(id: string) {
    const archive = await decodeArchive(await readBounded(this.file(id)));
    if (hash(JSON.stringify(archive)) !== id) throw new Error("archive_identity_mismatch");
    return archive;
  }
  summary(id: string, archive: PixArchive): ArchiveSummary {
    return {
      id,
      createdAt: archive.createdAt,
      memoryCount: archive.memories.length,
      sessions: archive.sessions.map(({ id, title }) => ({ id, title })),
      warnings: archive.warnings,
      attachmentCount: archive.attachments?.links.length ?? 0,
      sideChatCount:
        archive.sideChats == null
          ? 0
          : Object.keys(parseSideChatArchive(archive.sideChats).chats).length,
    };
  }
  async import(bytes: Buffer): Promise<ArchiveSummary> {
    const archive = await decodeArchive(bytes);
    const id = hash(JSON.stringify(archive));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await atomicExport(this.file(id), await encodeArchive(archive));
    return this.summary(id, archive);
  }
  async list(): Promise<ArchiveSummary[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const result: ArchiveSummary[] = [];
    for (const entry of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.pixarchive$/.test(entry)) continue;
      const id = entry.slice(0, -11);
      result.push(this.summary(id, await this.read(id)));
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async session(id: string, sessionId: string): Promise<string> {
    return (await this.prepareSession(id, sessionId)).path;
  }
  async prepareSession(id: string, sessionId: string) {
    checkId(sessionId);
    const archive = await this.read(id);
    const paths = await materializeAttachments(archive, join(this.directory, "attachments", id));
    const session = archive.sessions.find((item) => item.id === sessionId);
    if (!session) throw new Error("archive_session_not_found");
    const directory = join(this.directory, "sessions", id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${sessionId}.jsonl`);
    await writeFile(path, session.jsonl, { mode: 0o600 });
    return {
      path,
      attachments: paths,
      sideChats:
        archive.sideChats == null
          ? { version: 1 as const, chats: {}, activeBySession: {} }
          : parseSideChatArchive(archive.sideChats),
    };
  }
}
export async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > ARCHIVE_LIMIT) throw new Error("archive_too_large");
    // Never let a concurrently growing file cause an unbounded readFile allocation.
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error("archive_source_changed");
      offset += result.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const after = await stat(path);
    if (
      extra.bytesRead ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("archive_source_changed");
    return bytes;
  } finally {
    await handle.close();
  }
}
export async function atomicExport(path: string, data: string | Buffer): Promise<void> {
  const staging = `${path}.pix-export-${randomUUID()}.tmp`;
  await writeFile(staging, data, { mode: 0o600, flag: "wx", flush: true });
  await rename(staging, path);
}
