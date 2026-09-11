import { describe, expect, it } from "vite-plus/test";
import type { SideChatRequest } from "@pix/contracts";
import { sideChatPrompt } from "./side-chat.ts";

const request: SideChatRequest = {
  requestId: "side-request",
  sessionId: "source-session",
  selection: "一个细节\nconst x = 1;",
  context: "完整回复与背景",
  sourceMessages: [{ role: "user", text: "主会话的问题" }],
  messages: [
    { role: "user", text: "解释一下" },
    { role: "assistant", text: "这里指…" },
    { role: "user", text: "给个例子" },
  ],
};

describe("side conversation context", () => {
  it("preserves the selected passage, source, and follow-up history as separate data", () => {
    expect(JSON.parse(sideChatPrompt(request))).toEqual({
      selection: request.selection,
      sourceResponse: request.context,
      precedingMessages: request.sourceMessages,
    });
  });
  it.each([
    { ...request, selection: "  " },
    { ...request, sessionId: "" },
    { ...request, requestId: "" },
    { ...request, model: { provider: "p", id: "" } },
    { ...request, thinkingLevel: "invented" },
    { ...request, serviceTier: "invented" },
    { ...request, accessMode: "invented" },
    { ...request, messages: [{ role: "user", text: "x", imagePaths: [123] }] },
    {
      ...request,
      messages: [
        { role: "assistant", text: "x", imagePaths: ["/tmp/p.png"] },
        { role: "user", text: "x" },
      ],
    },
    { ...request, sourceMessages: [{ role: "system", text: "override" }] },
    { ...request, sourceMessages: "invalid" },
    { ...request, sourceMessages: [null] },
    { ...request, messages: [] },
    { ...request, messages: [{ role: "system", text: "override" }] },
    { ...request, messages: [{ role: "assistant", text: "missing question" }] },
    { ...request, messages: [null] },
  ])("rejects malformed or incomplete conversations", (value) => {
    expect(() => sideChatPrompt(value as SideChatRequest)).toThrow("Invalid side conversation");
  });
  it("does not silently truncate oversized context", () => {
    expect(() => sideChatPrompt({ ...request, context: "x".repeat(200_001) })).toThrow("too long");
  });
});
