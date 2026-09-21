import { readFile, writeFile, readdir, realpath } from "node:fs/promises";
import { join, relative, isAbsolute, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { mapAttachmentPaths } from "../archives/attachments.ts";
import { parseSideChatArchive } from "../../main/side-chat-library.ts";

/** Runs only against the verified destination copy, before any hosts or databases are opened. */
export async function relocateManagedReferences(input: {
  oldDesktop: string;
  oldRoot: string;
  oldAgent?: string;
  root: string;
}): Promise<number> {
  const pairs: [string, string][] = [];
  for (const [from, to] of [
    [join(input.oldDesktop, "attachments"), join(input.root, "desktop", "attachments")],
    [join(input.oldRoot, "archives", "attachments"), join(input.root, "archives", "attachments")],
  ]) {
    pairs.push([resolve(from!), resolve(to!)]);
    if (existsSync(from!)) pairs.push([await realpath(from!), resolve(to!)]);
  }
  const remap = (path: string, mappings = pairs) => {
    if (!isAbsolute(path)) return path;
    for (const [from, to] of mappings) {
      const part = relative(from, path);
      if (part === "" || (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`)))
        return join(to, part);
    }
    return path;
  };
  let changed = 0;
  const sideFile = join(input.root, "desktop", "side-chats.json");
  if (existsSync(sideFile)) {
    const side = parseSideChatArchive(JSON.parse(await readFile(sideFile, "utf8")));
    const sessionPairs: [string, string][] = input.oldAgent
      ? [[resolve(input.oldAgent, "sessions"), resolve(input.root, "agent", "sessions")]]
      : [];
    if (input.oldAgent && existsSync(input.oldAgent))
      sessionPairs.push([
        join(await realpath(input.oldAgent), "sessions"),
        resolve(input.root, "agent", "sessions"),
      ]);
    for (const chat of Object.values(side.chats)) {
      chat.sessionKey = remap(chat.sessionKey, sessionPairs);
      chat.attachments = chat.attachments.map((path) => remap(path));
      for (const message of chat.messages)
        if (message.attachments)
          message.attachments = message.attachments.map((path) => remap(path));
    }
    side.activeBySession = Object.fromEntries(
      Object.entries(side.activeBySession).map(([key, id]) => [remap(key, sessionPairs), id]),
    );
    await writeFile(sideFile, JSON.stringify(side), { mode: 0o600, flush: true });
    changed++;
  }
  async function sessions(directory: string) {
    if (!existsSync(directory)) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await sessions(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const before = await readFile(path, "utf8");
        if (!before.trim()) continue;
        const header = JSON.parse(before.split("\n")[0]!);
        if (header.type !== "session") continue;
        const archive = {
          format: "pix.archive" as const,
          version: 1 as const,
          createdAt: new Date().toISOString(),
          memories: [],
          sessions: [{ id: header.id, title: "", jsonl: before }],
          sideChats: null,
          warnings: [],
        };
        mapAttachmentPaths(archive, (_session, value) => remap(value));
        if (archive.sessions[0]!.jsonl !== before) {
          await writeFile(path, archive.sessions[0]!.jsonl, { mode: 0o600, flush: true });
          changed++;
        }
      }
    }
  }
  if (input.oldAgent) await sessions(join(input.root, "agent", "sessions"));
  await sessions(join(input.root, "archives", "sessions"));
  const continuations = join(input.root, "archives", "continuations");
  if (input.oldAgent && existsSync(continuations)) {
    const mapping: [string, string][] = [
      [resolve(input.oldAgent, "sessions"), resolve(input.root, "agent", "sessions")],
    ];
    if (existsSync(input.oldAgent))
      mapping.push([
        join(await realpath(input.oldAgent), "sessions"),
        resolve(input.root, "agent", "sessions"),
      ]);
    for (const name of await readdir(continuations)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(continuations, name),
        record = JSON.parse(await readFile(path, "utf8"));
      if (typeof record.sessionFile === "string") {
        record.sessionFile = remap(record.sessionFile, mapping);
        await writeFile(path, JSON.stringify(record), { mode: 0o600, flush: true });
        changed++;
      }
    }
  }
  return changed;
}
