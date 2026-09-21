import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, realpath, readFile, lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { PathAccess } from "../../main/path-access.ts";
import { parseSideChatArchive } from "../../main/side-chat-library.ts";
import type { PixArchive } from "./archive.ts";

export const ATTACHMENT_LIMIT = 12_000_000;
const TOTAL_LIMIT = 48_000_000;
export interface ArchiveAttachments {
  blobs: { sha256: string; size: number; data: string }[];
  links: { sessionId: string; path: string; sha256: string; name: string }[];
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const xml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const unxml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");

function paths(text: string, replace: (path: string) => string): string {
  return text.replace(/<attached-paths>\s*([\s\S]*?)\s*<\/attached-paths>\s*$/i, (block: string) =>
    block.replace(
      /<path>([\s\S]*?)<\/path>/gi,
      (_tag: string, value: string) => `<path>${xml(replace(unxml(value).trim()))}</path>`,
    ),
  );
}

/** Only explicit attachment metadata is traversed. Ordinary prose/tool paths are never read. */
export function mapAttachmentPaths(
  archive: PixArchive,
  replace: (sessionId: string, path: string, cwd: string) => string,
): void {
  const cwds = new Map<string, string>();
  for (const session of archive.sessions) {
    const rows = session.jsonl
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const cwd = rows[0].cwd as string;
    cwds.set(session.id, cwd);
    for (const row of rows) {
      if (row.type !== "message" || row.message?.role !== "user") continue;
      const map = (text: string) => paths(text, (path) => replace(session.id, path, cwd));
      if (typeof row.message.content === "string") row.message.content = map(row.message.content);
      else if (Array.isArray(row.message.content))
        for (const part of row.message.content)
          if (part.type === "text" && typeof part.text === "string") part.text = map(part.text);
    }
    session.jsonl = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  }
  if (archive.sideChats != null) {
    const side = parseSideChatArchive(archive.sideChats);
    for (const chat of Object.values(side.chats)) {
      const map = (path: string) => replace(chat.sessionId, path, cwds.get(chat.sessionId) ?? "");
      chat.attachments = chat.attachments.map(map);
      for (const message of chat.messages) {
        if (message.attachments) message.attachments = message.attachments.map(map);
        message.text = paths(message.text, map);
      }
    }
  }
}

export function validateAttachments(value: ArchiveAttachments, sessionIds: Set<string>): void {
  if (
    !value ||
    !Array.isArray(value.blobs) ||
    !Array.isArray(value.links) ||
    value.blobs.length > 4000 ||
    value.links.length > 20_000
  )
    throw new Error("invalid_attachments");
  const hashes = new Set<string>();
  let total = 0;
  for (const blob of value.blobs) {
    if (
      !blob ||
      !/^[a-f0-9]{64}$/.test(blob.sha256) ||
      hashes.has(blob.sha256) ||
      !Number.isSafeInteger(blob.size) ||
      blob.size < 0 ||
      blob.size > ATTACHMENT_LIMIT ||
      typeof blob.data !== "string" ||
      blob.data.length > Math.ceil(ATTACHMENT_LIMIT / 3) * 4
    )
      throw new Error("invalid_attachment_blob");
    const bytes = Buffer.from(blob.data, "base64");
    if (
      bytes.length !== blob.size ||
      bytes.toString("base64") !== blob.data ||
      digest(bytes) !== blob.sha256
    )
      throw new Error("attachment_checksum_mismatch");
    total += blob.size;
    if (total > TOTAL_LIMIT) throw new Error("attachments_too_large");
    hashes.add(blob.sha256);
  }
  const links = new Set<string>();
  for (const link of value.links) {
    if (
      !link ||
      !sessionIds.has(link.sessionId) ||
      typeof link.path !== "string" ||
      !link.path ||
      link.path.length > 8192 ||
      link.path.includes("\0") ||
      !hashes.has(link.sha256) ||
      typeof link.name !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,120}$/.test(link.name) ||
      link.name === "." ||
      link.name === ".."
    )
      throw new Error("invalid_attachment_link");
    const key = JSON.stringify([link.sessionId, link.path]);
    if (links.has(key)) throw new Error("duplicate_attachment_link");
    links.add(key);
  }
}

export async function packAttachments(
  archive: PixArchive,
  roots: string[],
  selected: PathAccess,
): Promise<void> {
  const access = new PathAccess();
  for (const root of roots) {
    try {
      access.grant(root);
    } catch {
      /* Missing roots produce per-file notes. */
    }
  }
  const references = new Map<string, { sessionId: string; path: string; cwd: string }>();
  mapAttachmentPaths(archive, (sessionId, path, cwd) => {
    references.set(JSON.stringify([sessionId, path]), { sessionId, path, cwd });
    return path;
  });
  const result: ArchiveAttachments = { blobs: [], links: [] };
  const known = new Set<string>();
  let total = 0;
  for (const { sessionId, path, cwd } of references.values()) {
    try {
      let source: string;
      try {
        source = access.assert(path, cwd);
      } catch {
        source = selected.assert(path, cwd);
      }
      const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > ATTACHMENT_LIMIT)
          throw new Error("not_a_bounded_file");
        // Bound allocation even if a writer grows the source while it is being copied.
        const buffer = Buffer.alloc(before.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const read = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!read.bytesRead) break;
          offset += read.bytesRead;
        }
        const after = await handle.stat();
        if (
          offset !== before.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          before.size !== after.size
        )
          throw new Error("attachment_changed");
        bytes = buffer.subarray(0, offset);
      } finally {
        await handle.close();
      }
      const sha256 = digest(bytes);
      if (!known.has(sha256)) {
        if (total + bytes.length > TOTAL_LIMIT) throw new Error("attachments_too_large");
        total += bytes.length;
        result.blobs.push({ sha256, size: bytes.length, data: bytes.toString("base64") });
        known.add(sha256);
      }
      result.links.push({
        sessionId,
        path,
        sha256,
        name:
          basename(source)
            .replace(/[^a-zA-Z0-9_.-]/g, "_")
            .slice(-120) || "attachment",
      });
    } catch (error) {
      archive.warnings.push(
        `Attachment unavailable (${sessionId}): ${path} — ${error instanceof Error ? error.message : "read_failed"}`,
      );
    }
  }
  archive.attachments = result;
}

/** Imported source paths are labels only. All output names are locally constructed and verified. */
export async function materializeAttachments(
  archive: PixArchive,
  directory: string,
): Promise<string[]> {
  if (!archive.attachments) return [];
  validateAttachments(archive.attachments, new Set(archive.sessions.map((session) => session.id)));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("attachment_directory_symlink");
  directory = await realpath(directory);
  const outputs = new Map<string, string>();
  for (const link of archive.attachments.links) {
    const blob = archive.attachments.blobs.find((blob) => blob.sha256 === link.sha256)!;
    const target = join(directory, `${blob.sha256}-${link.name}`);
    try {
      const handle = await open(target, "wx", 0o600);
      try {
        await handle.writeFile(Buffer.from(blob.data, "base64"));
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if ((await realpath(target)) !== target || digest(await readFile(target)) !== blob.sha256)
      throw new Error("attachment_materialization_mismatch");
    outputs.set(JSON.stringify([link.sessionId, link.path]), target);
  }
  mapAttachmentPaths(
    archive,
    (session, path) => outputs.get(JSON.stringify([session, path])) ?? path,
  );
  return [...new Set(outputs.values())];
}
