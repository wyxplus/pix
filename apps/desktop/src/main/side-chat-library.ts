import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SideChatArchive } from "@pix/contracts";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function message(value: unknown): boolean {
  return (
    record(value) &&
    ["user", "assistant"].includes(String(value.role)) &&
    typeof value.text === "string"
  );
}
function parseArchive(value: unknown): SideChatArchive {
  if (
    !record(value) ||
    value.version !== 1 ||
    !record(value.chats) ||
    !record(value.activeBySession)
  )
    throw new Error("Invalid side chat archive");
  for (const [id, chat] of Object.entries(value.chats)) {
    if (
      !record(chat) ||
      chat.id !== id ||
      !id ||
      typeof chat.sessionKey !== "string" ||
      !chat.sessionKey ||
      typeof chat.sessionId !== "string" ||
      !record(chat.selection) ||
      ![
        chat.selection.messageId,
        chat.selection.text,
        chat.selection.context,
        chat.draft,
        chat.error,
      ].every((item) => typeof item === "string") ||
      !Array.isArray(chat.sourceMessages) ||
      !chat.sourceMessages.every(message) ||
      !Array.isArray(chat.messages) ||
      !chat.messages.every(
        (item) =>
          record(item) &&
          message(item) &&
          typeof item.id === "string" &&
          (item.attachments === undefined || strings(item.attachments)),
      ) ||
      !strings(chat.attachments) ||
      !["idle", "streaming", "failed", "stopped"].includes(String(chat.status)) ||
      (chat.requestId !== undefined && typeof chat.requestId !== "string") ||
      !record(chat.settings) ||
      typeof chat.settings.thinkingLevel !== "string" ||
      !["flex", "default", "priority"].includes(String(chat.settings.serviceTier)) ||
      !["default", "autoReview", "full"].includes(String(chat.settings.accessMode)) ||
      (chat.settings.model !== undefined &&
        (!record(chat.settings.model) ||
          typeof chat.settings.model.provider !== "string" ||
          typeof chat.settings.model.id !== "string"))
    )
      throw new Error("Invalid saved side chat");
  }
  for (const [session, id] of Object.entries(value.activeBySession)) {
    if (
      typeof id !== "string" ||
      !record(value.chats[id]) ||
      value.chats[id].sessionKey !== session
    )
      throw new Error("Invalid active side chat");
  }
  return value as SideChatArchive;
}

/** Atomic replacement keeps the last complete archive intact if a write is interrupted. */
export class SideChatLibrary {
  readonly path: string;
  constructor(private readonly root: string) {
    this.path = join(root, "side-chats.json");
  }
  load(): SideChatArchive {
    try {
      return parseArchive(JSON.parse(readFileSync(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { version: 1, chats: {}, activeBySession: {} };
      throw error;
    }
  }
  save(value: unknown): void {
    const archive = parseArchive(value);
    mkdirSync(this.root, { recursive: true });
    writeFileSync(`${this.path}.tmp`, JSON.stringify(archive), { mode: 0o600, flush: true });
    renameSync(`${this.path}.tmp`, this.path);
  }
}
