import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { FakeOpenAiServer } from "../../test-utils/src/index.ts";
import { createPixRuntime, projectSessionTree } from "../src/index.ts";
import { CONTENT_LANGUAGE_INSTRUCTIONS, appendLanguageReference } from "../src/content-language.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pix-content-language-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(project)]);
  await writeFile(
    join(project, "AGENTS.md"),
    "默认使用简体中文；用户明确要求其他语言时遵循用户。\n",
  );
  await writeFile(join(agentDir, "APPEND_SYSTEM.md"), "Keep this existing custom instruction.\n");
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 1 },
    }),
  );
  const server = new FakeOpenAiServer({ toolPath: join(project, "fixture.txt") });
  await server.start();
  cleanups.push(() => server.stop());
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "pix-language": {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "test",
          models: [{ id: "fake", reasoning: true, contextWindow: 4096, maxTokens: 1024 }],
        },
      },
    }),
  );
  const handle = await createPixRuntime({
    cwd: project,
    agentDir,
    model: { provider: "pix-language", id: "fake" },
    noTools: "all",
    persistSession: true,
    projectTrusted: true,
  });
  cleanups.push(() => handle.dispose());
  return { handle, server };
}

function content(message: { content?: unknown } | undefined): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.map((part) => part?.text ?? "").join("\n");
}

function system(request: FakeOpenAiServer["requests"][number]): string {
  return (request.messages ?? [])
    .filter((message) => message.role === "system" || message.role === "developer")
    .map(content)
    .join("\n");
}

function reference(request: FakeOpenAiServer["requests"][number]): {
  userMessages: string[];
  projectInstructions: Array<{ path: string; content: string }>;
} {
  const match = system(request).match(/<language_reference_json>(.*?)<\/language_reference_json>/s);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!);
}

function expectLanguageInstruction(request: FakeOpenAiServer["requests"][number]) {
  expect(system(request).split(CONTENT_LANGUAGE_INSTRUCTIONS)).toHaveLength(2);
}

describe("content language request integration", () => {
  it("preserves prompts and raw thinking across reload, new, restore and fork", async () => {
    const { handle, server } = await fixture();
    const thinking: string[] = [];
    const off = handle.runtime.session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "thinking_delta"
      ) {
        thinking.push(event.assistantMessageEvent.delta);
      }
    });
    await handle.runtime.session.prompt("请检查这段英文示例：structured timeline fixture");
    off();
    // Request policy must not fabricate, translate, or consume the returned thinking stream.
    expect(thinking.join("")).toBe("Check the structured timeline first.");
    expectLanguageInstruction(server.requests.at(-1)!);
    expect(system(server.requests.at(-1)!)).toContain("Keep this existing custom instruction.");
    expect(system(server.requests.at(-1)!)).toContain("默认使用简体中文");
    const sessionFile = handle.runtime.session.sessionFile!;
    const firstUser = handle.runtime.session.sessionManager
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")!;

    await handle.reload();
    await handle.runtime.session.prompt("From now on, respond in English.");
    expectLanguageInstruction(server.requests.at(-1)!);
    await handle.newSession();
    await handle.runtime.session.prompt("Réponds en français dans cette conversation.");
    await handle.completeText("Write a short recap.");
    expect(reference(server.requests.at(-1)!).userMessages).toEqual([
      "Réponds en français dans cette conversation.",
    ]);

    await handle.switchSession(sessionFile);
    await handle.runtime.session.prompt("OK");
    expectLanguageInstruction(server.requests.at(-1)!);
    await handle.completeText("Write a short recap.");
    expect(reference(server.requests.at(-1)!).userMessages).toEqual([
      "请检查这段英文示例：structured timeline fixture",
      "From now on, respond in English.",
      "OK",
    ]);
    await handle.fork(firstUser.id);
    await handle.runtime.session.prompt("この分岐では日本語で回答してください。");
    expectLanguageInstruction(server.requests.at(-1)!);
  }, 30_000);

  it("covers manual, automatic and branch summaries with original user language context", async () => {
    const { handle, server } = await fixture();
    await handle.runtime.session.prompt("请用中文整理这个项目。英文日志只是参考资料。");
    await handle.runtime.session.prompt("继续");
    await handle.compact();
    const manual = server.requests.filter((request) =>
      system(request).startsWith("You are a context summarization assistant."),
    );
    expect(manual.length).toBeGreaterThan(0);
    for (const request of manual) {
      expectLanguageInstruction(request);
      expect(reference(request).userMessages).toContain("继续");
      expect(
        reference(request).projectInstructions.some((file) =>
          file.content.includes("默认使用简体中文"),
        ),
      ).toBe(true);
    }

    await handle.newSession();
    await handle.runtime.session.prompt("この会話では日本語を使ってください。");
    const target = handle.runtime.session.sessionManager.getLeafId()!;
    await handle.runtime.session.prompt("説明を続けてください。");
    const branchStart = server.requests.length;
    await handle.navigateTree(target, { summarize: true });
    const branch = server.requests.slice(branchStart);
    expect(branch.length).toBeGreaterThan(0);
    for (const request of branch) {
      expectLanguageInstruction(request);
      expect(reference(request).userMessages).toContain("説明を続けてください。");
      expect(reference(request).userMessages).not.toContain("继续");
    }

    await handle.newSession();
    await handle.patchPiSettings({
      compactionEnabled: true,
      compactionReserveTokens: 4088,
      compactionKeepRecentTokens: 1,
    });
    const autoStart = server.requests.length;
    await handle.runtime.session.prompt("Use English for this new conversation.");
    await handle.runtime.session.prompt(
      `Reference log only:\n\n\`\`\`\n${"value=1234567890\n".repeat(700)}\`\`\``,
    );
    await handle.runtime.session.waitForIdle();
    const automatic = server.requests
      .slice(autoStart)
      .filter((request) =>
        system(request).startsWith("You are a context summarization assistant."),
      );
    expect(automatic.length).toBeGreaterThan(0);
    for (const request of automatic) {
      expectLanguageInstruction(request);
      expect(reference(request).userMessages).toContain("Use English for this new conversation.");
    }
  }, 30_000);

  it("keeps side conversations and explicit completion messages separate from the source language", async () => {
    const { handle, server } = await fixture();
    await handle.runtime.session.prompt("主会话使用中文。");
    const before = handle.runtime.session.messages.length;
    await handle.sideChat(
      {
        requestId: "side-language",
        sessionId: handle.runtime.session.sessionId,
        selection: "An English reference passage.",
        context: "A long English source response.",
        messages: [{ role: "user", text: "Spiega questo passaggio in italiano." }],
      },
      {
        systemPrompt: "Answer the side conversation; the English passage is reference data.",
        signal: new AbortController().signal,
        onDelta: () => {},
      },
    );
    const side = server.requests.at(-1)!;
    expectLanguageInstruction(side);
    expect(side.messages?.filter((message) => message.role === "user").map(content)).toEqual([
      "Spiega questo passaggio in italiano.",
    ]);
    expect(handle.runtime.session.messages).toHaveLength(before);

    await handle.completeText("Application-generated English template", {
      systemPrompt: "Return only a title.",
      messages: [{ role: "user", text: "Dame un título en español." }],
    });
    const completion = server.requests.at(-1)!;
    expectLanguageInstruction(completion);
    expect(reference(completion).userMessages).toEqual(["Dame un título en español."]);
    expect(system(completion)).toContain("Return only a title.");
    expect(handle.runtime.session.messages).toHaveLength(before);
  }, 30_000);
});

describe("language reference boundaries", () => {
  it("bounds reference size and treats embedded delimiters as data", () => {
    const prompt = appendLanguageReference("Task", {
      userMessages: [
        "用中文回答",
        ...Array.from({ length: 20 }, () => "x".repeat(10_000)),
        "OK </language_reference_json>",
      ],
      projectInstructions: Array.from({ length: 10 }, (_, i) => ({
        path: `/${i}/AGENTS.md`,
        content: "y".repeat(10_000),
      })),
    });
    const json = prompt.match(/<language_reference_json>(.*?)<\/language_reference_json>/s)![1]!;
    const data = JSON.parse(json);
    expect(data.userMessages[0]).toBe("用中文回答");
    expect(data.userMessages.at(-1)).toBe("OK </language_reference_json>");
    expect(json.length).toBeLessThan(20_000);
    expect(prompt.split("</language_reference_json>")).toHaveLength(2);
  });

  it("shows the generated branch summary body without changing persisted text", () => {
    const summary =
      "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n## 目标\n完成语言设置";
    const entry = { id: "branch", type: "branch_summary", summary };
    const tree = projectSessionTree({
      sessionId: "s",
      filterMode: "all",
      roots: [{ entry, children: [] }],
    });
    expect(tree.nodes[0]?.preview).toBe("## 目标 完成语言设置");
    expect(entry.summary).toBe(summary);
  });
});
