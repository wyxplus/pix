import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vite-plus/test";
import { MessageIdentity } from "./message-identity.ts";
import { projectSessionHistory } from "@pix/agent-runtime";

describe("live/history message identity", () => {
  it("matches SDK snapshot copies to final history without conflating repeated replies", () => {
    const identity = new MessageIdentity();
    const final = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "inspect" },
        { type: "text", text: "result" },
      ],
    };
    const start = () =>
      identity.observe({ type: "message_start", message: { ...final } } as AgentSessionEvent);
    const first = start();
    const delta = identity.observe({
      type: "message_update",
      message: { ...final },
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "result" },
    } as AgentSessionEvent);
    identity.observe({ type: "message_end", message: final } as AgentSessionEvent);
    const rows = identity.history(
      projectSessionHistory([final], ["entry-1"]),
      [{ id: "entry-1", message: final }],
      "session-1",
    );
    expect(rows[0]?.messageId).toBe(first);
    expect(rows[1]?.messageId).toBe(delta);
    expect(rows[0]?.messageId).not.toBe(rows[1]?.messageId);
    expect(start()).not.toBe(first);
    // A session reopened from JSON gets new objects but retains entry identities.
    expect(
      identity.history(
        projectSessionHistory([final], ["entry-1"]),
        [{ id: "entry-1", message: structuredClone(final) }],
        "session-1",
      ),
    ).toEqual(rows);
    expect(
      identity.history(
        projectSessionHistory([final], ["entry-1"]),
        [{ id: "entry-1", message: structuredClone(final) }],
        "another-session",
      )[0]?.messageId,
    ).toBeUndefined();
  });

  it("retains tool call IDs in persisted result projection", () => {
    expect(
      projectSessionHistory([
        {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "call-2",
          content: [{ type: "text", text: "result" }],
        },
      ])[0],
    ).toMatchObject({ role: "tool", toolCallId: "call-2" });
  });
});
