import { describe, expect, it } from "vite-plus/test";
import {
  appendMonotonicText,
  applyRuntimeEventToLiveStream,
  assertLiveStreamTextMonotonic,
  emptyLiveStream,
  liveStreamNotCoveredByHistory,
  retractOptimisticUserMessage,
} from "./live-stream.ts";

describe("appendMonotonicText", () => {
  it("appends incremental chunks", () => {
    expect(appendMonotonicText("", "Hel")).toBe("Hel");
    expect(appendMonotonicText("Hel", "lo")).toBe("Hello");
    expect(appendMonotonicText("Hello", "!")).toBe("Hello!");
  });

  it("preserves repeated characters even when the next chunk starts with the buffer", () => {
    expect(appendMonotonicText("哈", "哈哈")).toBe("哈哈哈");
    expect(appendMonotonicText("0", "0")).toBe("00");
  });

  it("preserves repeated digits and newlines instead of treating them as redelivery", () => {
    expect(appendMonotonicText("10", "0")).toBe("100");
    expect(appendMonotonicText("Header\n", "\n")).toBe("Header\n\n");
  });

  it("preserves a table delimiter chunk that overlaps a prior column", () => {
    expect(appendMonotonicText("| --- ", "| --- |\n")).toBe("| --- | --- |\n");
  });

  it("never returns a shorter string than prev when delta is non-empty prefix-lossy", () => {
    const prev = "The quick brown fox";
    // A totally new delta still appends (we never replace with shorter).
    const next = appendMonotonicText(prev, " jumps");
    expect(next.length).toBeGreaterThanOrEqual(prev.length);
    expect(next.startsWith(prev) || next === prev).toBe(true);
  });
});

describe("live stream (append-only)", () => {
  it("only grows assistant text under many deltas", () => {
    let state = emptyLiveStream();
    for (let i = 0; i < 300; i++) {
      state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: `t${i} ` }, [], {
        sequence: i + 1,
      });
    }
    const assistant = state.items.find((item) => item.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.text.startsWith("t0 ")).toBe(true);
    expect(assistant?.kind === "assistant" && assistant.text.includes("t299 ")).toBe(true);
    expect(
      assistant?.kind === "assistant" && assistant.text.split(/\s+/).filter(Boolean),
    ).toHaveLength(300);
  });

  it("dedupes by host sequence so redelivery does not double-append", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "Hello" }, [], {
      sequence: 10,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "Hello" }, [], {
      sequence: 10,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: " world" }, [], {
      sequence: 11,
    });
    const assistant = state.items.find((item) => item.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.text).toBe("Hello world");
  });

  it("keeps event order: thinking → assistant → tool → assistant", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(state, { type: "thinking.delta", delta: "plan" }, [], {
      sequence: 1,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "Hi" }, [], {
      sequence: 2,
    });
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "tool.started", toolCallId: "1", toolName: "bash", args: { command: "ls" } },
      [],
      { sequence: 3 },
    );
    state = applyRuntimeEventToLiveStream(
      state,
      {
        type: "tool.completed",
        toolCallId: "1",
        toolName: "bash",
        output: "ok",
        isError: false,
      },
      [],
      { sequence: 4 },
    );
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "Done" }, [], {
      sequence: 5,
    });

    expect(state.items.map((item) => item.kind)).toEqual([
      "thinking",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(state.items[1]).toMatchObject({ kind: "assistant", text: "Hi" });
    expect(state.items[3]).toMatchObject({ kind: "assistant", text: "Done" });
    expect(state.items[2]).toMatchObject({ kind: "tool", status: "completed" });
  });

  it("attaches tool result images onto the matching running tool row", () => {
    const image = {
      mimeType: "image/png",
      dataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    };
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "tool.started", toolCallId: "img", toolName: "read", args: { path: "shot.png" } },
      [],
      { sequence: 1 },
    );
    state = applyRuntimeEventToLiveStream(
      state,
      {
        type: "tool.completed",
        toolCallId: "img",
        toolName: "read",
        output: "",
        isError: false,
        images: [image],
      },
      [],
      { sequence: 2 },
    );
    expect(state.items[0]).toMatchObject({
      kind: "tool",
      status: "completed",
      output: "",
      images: [image],
    });
  });

  it("never shortens an existing assistant buffer across a long stream", () => {
    let state = emptyLiveStream();
    let prev = state;
    for (let i = 0; i < 200; i++) {
      state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: `x${i}` }, [], {
        sequence: i + 1,
      });
      expect(assertLiveStreamTextMonotonic(prev, state)).toBe(true);
      prev = state;
    }
    const assistant = state.items.find((item) => item.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.text.startsWith("x0")).toBe(true);
    expect(assistant?.kind === "assistant" && assistant.text.includes("x199")).toBe(true);
  });

  it("keeps identical text from distinct host sequences", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "| --- " }, [], {
      sequence: 1,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "| --- " }, [], {
      sequence: 2,
    });
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "|\n" }, [], {
      sequence: 3,
    });
    const assistant = state.items.find((item) => item.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.text).toBe("| --- | --- |\n");
  });

  it.each(["message.delta", "thinking.delta"] as const)(
    "preserves complete Markdown under different %s chunk boundaries and replays",
    (type) => {
      const markdown = [
        "统计：",
        "",
        "| 项目 | 数值 |",
        "| --- | --- |",
        "| 收入 | 1000 |",
        "| 空值 | |",
        "",
        "```js",
        "const empty = [];",
        "const nested = [[1000]];",
        "```",
      ].join("\n");
      for (let size = 1; size <= 32; size++) {
        let state = emptyLiveStream();
        let sequence = 0;
        for (let offset = 0; offset < markdown.length; offset += size) {
          const event = { type, delta: markdown.slice(offset, offset + size) };
          state = applyRuntimeEventToLiveStream(state, event, [], { sequence: ++sequence });
          // A true redelivery repeats the sequence, regardless of its text.
          state = applyRuntimeEventToLiveStream(state, event, [], { sequence });
        }
        const item = state.items[0];
        expect(item?.kind === "assistant" || item?.kind === "thinking").toBe(true);
        expect(item && "text" in item && item.text).toBe(markdown);
      }
    },
  );

  it("keeps attachment chips on optimistic user rows and merges host echo paths", () => {
    let state = emptyLiveStream();
    const prompts = ["Inspect these"];
    // Optimistic (or full) payload with attached-paths — same shape as sendPrompt.
    state = applyRuntimeEventToLiveStream(
      state,
      {
        type: "user.message",
        content:
          "Inspect these\n\n<attached-paths>\n  <path>/tmp/a.png</path>\n  <path>/tmp/note.md</path>\n</attached-paths>",
      },
      prompts,
      { sequence: 1 },
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "user",
      text: "Inspect these",
      attachments: ["/tmp/a.png", "/tmp/note.md"],
    });

    // Host re-echo with same text + paths must not drop chips or double the row.
    state = applyRuntimeEventToLiveStream(
      state,
      {
        type: "user.message",
        content:
          "Inspect these\n\n<attached-paths>\n  <path>/tmp/a.png</path>\n  <path>/tmp/note.md</path>\n  <path>/tmp/extra.txt</path>\n</attached-paths>",
      },
      prompts,
      { sequence: 2 },
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "user",
      text: "Inspect these",
      attachments: ["/tmp/a.png", "/tmp/note.md", "/tmp/extra.txt"],
    });
  });

  it("fills attachments when optimistic row had text only", () => {
    let state = emptyLiveStream();
    const prompts = ["Look"];
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "user.message", content: "Look" },
      prompts,
      { sequence: 1 },
    );
    expect(state.items[0]).toMatchObject({ kind: "user", text: "Look" });
    expect(
      state.items[0]?.kind === "user" ? state.items[0].attachments : undefined,
    ).toBeUndefined();

    state = applyRuntimeEventToLiveStream(
      state,
      {
        type: "user.message",
        content: "Look\n\n<attached-paths>\n  <path>/tmp/photo.webp</path>\n</attached-paths>",
      },
      prompts,
      { sequence: 2 },
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "user",
      text: "Look",
      attachments: ["/tmp/photo.webp"],
    });
  });

  it("retracts a ghost user row so queued steer does not split the assistant", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "user.message", content: "first" },
      ["first"],
      { sequence: 1 },
    );
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "message.delta", delta: "Working on it" },
      ["first"],
      { sequence: 2 },
    );
    // Bug path: optimistic user for a mid-turn queue lands between assistant chunks.
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "user.message", content: "steer please" },
      ["first", "steer please"],
      { sequence: 3 },
    );
    expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant", "user"]);
    expect(state.promptIndex).toBe(2);

    state = retractOptimisticUserMessage(state, "steer please");
    expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(state.promptIndex).toBe(1);

    // Further assistant deltas rejoin the open bubble instead of starting a new one.
    state = applyRuntimeEventToLiveStream(state, { type: "message.delta", delta: "…" }, ["first"], {
      sequence: 4,
    });
    expect(state.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(state.items[1]).toMatchObject({ kind: "assistant", text: "Working on it…" });
  });

  it("ignores retract when the display text is not present", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "user.message", content: "keep me" },
      ["keep me"],
      { sequence: 1 },
    );
    const next = retractOptimisticUserMessage(state, "missing");
    expect(next).toEqual(state);
  });
});

describe("liveStreamNotCoveredByHistory", () => {
  it("replaces a running tool when its matching completed result overtakes the event", () => {
    const live = applyRuntimeEventToLiveStream(
      emptyLiveStream(),
      { type: "tool.started", toolCallId: "same-call", toolName: "bash", args: {} },
      [],
    );
    const covered = liveStreamNotCoveredByHistory(live, [
      { role: "tool", text: "done", toolCallId: "same-call" },
    ]);
    expect(covered.items).toEqual([]);
    expect(
      applyRuntimeEventToLiveStream(
        covered,
        {
          type: "tool.completed",
          toolCallId: "same-call",
          toolName: "bash",
          output: "done",
          isError: false,
        },
        [],
        { sequence: 5 },
      ).items,
    ).toEqual([]);
  });

  it("retains a current reply when an older turn has the same prefix or identical text", () => {
    const state = applyRuntimeEventToLiveStream(
      emptyLiveStream(),
      { type: "message.delta", delta: "结果：100，接下来检查成本。", messageId: "current" },
      [],
    );
    for (const text of ["结果：100", "结果：100，接下来检查成本。"]) {
      expect(
        liveStreamNotCoveredByHistory(state, [{ role: "assistant", text, messageId: "earlier" }])
          .items,
      ).toEqual(state.items);
    }
    expect(
      liveStreamNotCoveredByHistory(state, [
        { role: "assistant", text: "结果：100", messageId: "current" },
      ]).items,
    ).toEqual(state.items);
  });

  it("matches completed tools by call ID instead of name", () => {
    const state = applyRuntimeEventToLiveStream(
      emptyLiveStream(),
      {
        type: "tool.completed",
        toolCallId: "new",
        toolName: "bash",
        output: "new output",
        isError: false,
      },
      [],
    );
    expect(
      liveStreamNotCoveredByHistory(state, [
        { role: "tool", toolName: "bash", toolCallId: "old", text: "old output" },
      ]).items,
    ).toEqual(state.items);
    expect(
      liveStreamNotCoveredByHistory(state, [
        { role: "tool", toolName: "bash", toolCallId: "new", text: "new output" },
      ]).items,
    ).toEqual([]);
  });

  it("does not recreate a covered message from delayed deltas after a snapshot", () => {
    const state = liveStreamNotCoveredByHistory(emptyLiveStream(), [
      { role: "assistant", text: "Hello", messageId: "completed" },
    ]);
    const next = applyRuntimeEventToLiveStream(
      state,
      { type: "message.delta", delta: "lo", messageId: "completed" },
      [],
      { sequence: 20 },
    );
    expect(next.items).toEqual([]);
    expect(next.seenSequences).toContain(20);
    expect(
      applyRuntimeEventToLiveStream(
        next,
        { type: "message.delta", delta: "Hello", messageId: "new-turn" },
        [],
      ).items,
    ).toHaveLength(1);
  });

  it("drops user/assistant rows already present in history and keeps open tools", () => {
    let state = emptyLiveStream();
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "user.message", content: "hi", messageId: "user-1" },
      ["hi"],
      {
        sequence: 1,
      },
    );
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "message.delta", delta: "hello", messageId: "assistant-1" },
      [],
      {
        sequence: 2,
      },
    );
    state = applyRuntimeEventToLiveStream(
      state,
      { type: "tool.started", toolCallId: "t1", toolName: "bash", args: {} },
      [],
      { sequence: 3 },
    );
    const next = liveStreamNotCoveredByHistory(state, [
      { role: "user", text: "hi", messageId: "user-1" },
      { role: "assistant", text: "hello", messageId: "assistant-1" },
    ]);
    expect(next.items.some((item) => item.kind === "user" || item.kind === "assistant")).toBe(
      false,
    );
    expect(next.items.some((item) => item.kind === "tool" && item.status === "running")).toBe(true);
  });
});
