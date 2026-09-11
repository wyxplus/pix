import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createSideChatStore } from "./side-chat-store.ts";
import type { SideChatRequest, SideChatArchive } from "@pix/contracts";

const selection = { messageId: "answer", text: "选文", context: "完整回复" };
let store: ReturnType<typeof createSideChatStore>;
let saved: SideChatArchive;
const storage = {
  load: async () => structuredClone(saved),
  save: async (archive: SideChatArchive) => {
    saved = structuredClone(archive);
  },
};
const get = () => store.getState();
const completions: {
  request: SideChatRequest;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}[] = [];
const cancel = vi.fn().mockResolvedValue(undefined);
function open(session = "main") {
  return get().open(session, session, selection, [{ role: "user", text: "原问题" }]);
}
beforeEach(async () => {
  saved = { version: 1, chats: {}, activeBySession: {} };
  store = createSideChatStore(storage);
  await get().hydrate();
  await get().flush();
  completions.length = 0;
  cancel.mockClear();
  vi.stubGlobal("window", {
    pix: {
      agent: {
        sideChat: (request: SideChatRequest) =>
          new Promise<string>((resolve, reject) => completions.push({ request, resolve, reject })),
        cancelSideChat: cancel,
      },
    },
  });
});
afterEach(async () => {
  await get().flush();
  vi.unstubAllGlobals();
});

describe("side chat lifecycle", () => {
  it("writes the newest state after an older in-flight save, including tab deletion", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let hold = false;
    store = createSideChatStore({
      ...storage,
      save: async (archive) => {
        if (hold) {
          hold = false;
          await blocked;
        }
        await storage.save(archive);
      },
    });
    await get().hydrate();
    await get().flush();
    hold = true;
    const first = open();
    const second = open();
    get().setDraft(second, "最新草稿");
    get().close(first);
    release();
    await get().flush();
    expect(Object.keys(saved.chats)).toEqual([second]);
    expect(saved.chats[second]?.draft).toBe("最新草稿");
    expect(saved.activeBySession.main).toBe(second);
  });

  it("reports storage failures and retries the full current state on the next edit", async () => {
    let fail = false;
    store = createSideChatStore({
      ...storage,
      save: async (archive) => {
        if (fail) throw new Error("Disk full");
        await storage.save(archive);
      },
    });
    await get().hydrate();
    await get().flush();
    fail = true;
    const id = open();
    await expect(get().flush()).rejects.toThrow("Disk full");
    expect(get().chats[id]).toBeDefined();
    fail = false;
    get().setDraft(id, "重试保存");
    await get().flush();
    expect(saved.chats[id]?.draft).toBe("重试保存");
    expect(get().persistenceError).toBe("");
  });

  it("deletes messages, drafts, attachments and lookup entries on close", async () => {
    const id = open();
    const sending = get().send(id, "问题");
    completions[0]!.resolve("完整回答");
    await sending;
    get().setDraft(id, "未发送草稿");
    get().setAttachments(id, ["/tmp/file.txt"]);
    get().close(id);
    expect(get().chats).toEqual({});
    expect(get().activeBySession).toEqual({});
    const next = open();
    expect(next).not.toBe(id);
    expect(get().chats[next]).toMatchObject({ messages: [], draft: "", attachments: [] });
  });

  it("cancels on close and cannot be recreated by a late delta, result, or picker callback", async () => {
    const id = open();
    const sending = get().send(id, "问题");
    const request = completions[0]!;
    get().close(id);
    expect(cancel).toHaveBeenCalledWith(request.request.requestId);
    const next = open();
    get().delta(request.request.requestId, "旧片段");
    get().setAttachments(id, ["/tmp/late.txt"]);
    request.resolve("旧结果");
    await sending;
    expect(Object.keys(get().chats)).toEqual([next]);
    expect(get().chats[next]).toMatchObject({ messages: [], attachments: [] });
  });

  it("keeps independent tabs and active selections for each main session", () => {
    const first = open();
    get().setDraft(first, "第一份草稿");
    const second = open();
    const other = open("another");
    expect(Object.keys(get().chats)).toEqual([first, second, other]);
    expect(get().activeBySession).toEqual({ main: second, another: other });
    get().activate(first);
    expect(get().chats[first]?.draft).toBe("第一份草稿");
    get().close(second);
    expect(get().activeBySession).toEqual({ main: first, another: other });
    const third = open();
    get().close(third);
    expect(get().activeBySession.main).toBe(first);
    get().close(first);
    expect(get().activeBySession).toEqual({ another: other });
  });

  it("restores histories, drafts, files, settings and active tabs; deletion survives restart", async () => {
    const first = open();
    const sending = get().send(first, "问题");
    completions[0]!.resolve("完整回答");
    await sending;
    get().setDraft(first, "草稿");
    get().setAttachments(first, ["/tmp/kept.txt"]);
    get().setSettings(first, {
      model: { provider: "test", id: "chosen" },
      thinkingLevel: "high",
      serviceTier: "priority",
      accessMode: "full",
    });
    const second = open();
    const other = open("another");
    get().activate(first);
    await get().flush();
    const before = structuredClone(saved);
    store = createSideChatStore(storage);
    await get().hydrate();
    expect(get().chats).toEqual(before.chats);
    expect(get().activeBySession).toEqual({ main: first, another: other });
    get().close(first);
    await get().flush();
    store = createSideChatStore(storage);
    await get().hydrate();
    expect(Object.keys(get().chats)).toEqual([second, other]);
    expect(get().activeBySession).toEqual({ main: second, another: other });
  });

  it("restores an interrupted answer as stopped and can retry using the rebound source session", async () => {
    const id = open();
    const oldStore = store;
    const sending = get().send(id, "问题");
    get().delta(completions[0]!.request.requestId, "部分回答");
    get().setDraft(id, "保留追问");
    await get().flush();
    const restored = createSideChatStore(storage);
    await restored.getState().hydrate();
    await restored.getState().flush();
    expect(restored.getState().chats[id]).toMatchObject({
      status: "stopped",
      requestId: undefined,
      draft: "保留追问",
    });
    expect(restored.getState().chats[id]?.messages[1]?.text).toBe("部分回答");
    restored.getState().bindSession("main", "resumed-id");
    const retry = restored.getState().send(id, undefined, true);
    expect(completions[1]!.request.sessionId).toBe("resumed-id");
    expect(completions[1]!.request.messages).toEqual([{ role: "user", text: "问题" }]);
    completions[1]!.resolve("重试回答");
    await retry;
    completions[0]!.resolve("退出前的请求结束");
    await sending;
    await oldStore.getState().flush();
    await restored.getState().flush();
  });

  it("routes simultaneous streams to their own tabs when switching or deleting another tab", async () => {
    const first = open();
    const firstSend = get().send(first, "第一个");
    const second = open();
    const secondSend = get().send(second, "第二个");
    get().activate(first);
    get().delta(completions[0]!.request.requestId, "A");
    get().delta(completions[1]!.request.requestId, "B");
    expect(get().chats[first]?.messages[1]?.text).toBe("A");
    expect(get().chats[second]?.messages[1]?.text).toBe("B");
    get().close(second);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(completions[1]!.request.requestId);
    completions[1]!.resolve("late B");
    completions[0]!.resolve("finished A");
    await Promise.all([firstSend, secondSend]);
    expect(get().chats[first]?.messages[1]?.text).toBe("finished A");
    expect(get().chats[second]).toBeUndefined();
  });

  it("stops a request without deleting the open chat or submitting a prepared draft", async () => {
    const id = open();
    const sending = get().send(id, "第一个问题");
    const first = completions[0]!;
    get().delta(first.request.requestId, "保留部分回复");
    get().setDraft(id, "新问题");
    await get().stop(id);
    expect(cancel).toHaveBeenCalledWith(first.request.requestId);
    expect(get().chats[id]).toMatchObject({ draft: "新问题", status: "stopped" });
    expect(completions).toHaveLength(1);
    const nextSending = get().send(id);
    get().delta(first.request.requestId, "不应追加");
    first.resolve("旧结果不应覆盖新回复");
    await sending;
    expect(get().chats[id]?.status).toBe("streaming");
    expect(get().chats[id]?.messages[1]?.text).toBe("保留部分回复");
    completions[1]!.resolve("新回复");
    await nextSending;
    expect(get().chats[id]?.messages.at(-1)?.text).toBe("新回复");
  });

  it("sends attachment-only turns and preserves new draft attachments across retries", async () => {
    const id = open();
    get().setSettings(id, {
      model: { provider: "test", id: "chosen" },
      thinkingLevel: "high",
      serviceTier: "priority",
      accessMode: "full",
    });
    get().setAttachments(id, ["/tmp/file.txt", "/tmp/image.png"]);
    const sending = get().send(id);
    expect(completions[0]!.request).toMatchObject({
      model: { provider: "test", id: "chosen" },
      thinkingLevel: "high",
      serviceTier: "priority",
    });
    expect(completions[0]!.request.messages[0]?.text).toContain("/tmp/file.txt");
    expect(completions[0]!.request.messages[0]?.imagePaths).toEqual(["/tmp/image.png"]);
    get().setDraft(id, "下一题");
    get().setAttachments(id, ["/tmp/new.txt"]);
    completions[0]!.reject(new Error("Offline"));
    await sending;
    const retrying = get().send(id, undefined, true);
    expect(completions[1]!.request.messages).toEqual(completions[0]!.request.messages);
    completions[1]!.resolve("OK");
    await retrying;
    expect(get().chats[id]).toMatchObject({ draft: "下一题", attachments: ["/tmp/new.txt"] });
  });

  it("retries the failed question once without losing a new draft or duplicating history", async () => {
    const id = open();
    get().setDraft(id, "重试的问题");
    const sending = get().send(id);
    get().setDraft(id, "准备好的追问");
    completions[0]!.reject(new Error("Temporary failure"));
    await sending;
    expect(get().chats[id]?.status).toBe("failed");
    expect(get().chats[id]?.draft).toBe("准备好的追问");
    const retrying = get().send(id, undefined, true);
    await get().send(id, undefined, true);
    expect(completions).toHaveLength(2);
    expect(completions[1]!.request.messages).toEqual([{ role: "user", text: "重试的问题" }]);
    completions[1]!.resolve("重试成功");
    await retrying;
    expect(get().chats[id]?.messages).toHaveLength(2);
    expect(get().chats[id]?.draft).toBe("准备好的追问");
  });
});
