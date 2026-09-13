import { randomUUID } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { SessionHistoryMessage } from "@pix/contracts";

/** Relate SDK live message snapshots to their eventual persisted message object. */
export class MessageIdentity {
  #active = new Map<string, string>();
  #completed = new WeakMap<object, string>();
  #entries = new Map<string, string>();

  observe(event: AgentSessionEvent): string | undefined {
    if (
      event.type !== "message_start" &&
      event.type !== "message_update" &&
      event.type !== "message_end"
    )
      return undefined;
    const message = event.message;
    if (message.role !== "user" && message.role !== "assistant") return undefined;
    let id = event.type === "message_start" ? undefined : this.#active.get(message.role);
    if (!id) id = randomUUID();
    this.#active.set(message.role, id);
    if (event.type === "message_end") {
      this.#completed.set(message, id);
      this.#active.delete(message.role);
    }
    // projectSessionHistory groups adjacent non-empty text/thinking blocks.
    // Use the same group index rather than equating all text in an assistant message.
    let segment = 0;
    if (
      event.type === "message_update" &&
      "contentIndex" in event.assistantMessageEvent &&
      Array.isArray(message.content)
    ) {
      let previous: string | undefined;
      for (const part of message.content.slice(0, event.assistantMessageEvent.contentIndex + 1)) {
        const role =
          part.type === "text" && part.text.trim()
            ? "assistant"
            : part.type === "thinking" && part.thinking.trim()
              ? "thinking"
              : undefined;
        if (!role) continue;
        if (previous && previous !== role) segment += 1;
        previous = role;
      }
    }
    return `${id}:${segment}`;
  }

  history(
    rows: SessionHistoryMessage[],
    entries: readonly { id: string; message?: unknown }[],
    sessionId: string,
  ): SessionHistoryMessage[] {
    for (const entry of entries) {
      if (!entry.message || typeof entry.message !== "object") continue;
      const id = this.#completed.get(entry.message);
      if (id) this.#entries.set(`${sessionId}:${entry.id}`, id);
    }
    const segments = new Map<string, number>();
    return rows.map((row) => {
      if (
        !row.entryId ||
        (row.role !== "user" && row.role !== "assistant" && row.role !== "thinking")
      )
        return row;
      const id = this.#entries.get(`${sessionId}:${row.entryId}`);
      if (!id) return row;
      const segment = segments.get(row.entryId) ?? 0;
      segments.set(row.entryId, segment + 1);
      return { ...row, messageId: `${id}:${segment}` };
    });
  }
}
