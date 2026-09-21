import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { prepareLaunchEnv } from "./launch-env.mjs";
import { SidecarClient } from "./sidecar-client.mjs";

await test(
  "memory, worker packaging, archive round trip and cold-start policy through production RPC",
  { timeout: 60_000 },
  async () => {
    const modelRequests = [];
    const prepared = await prepareLaunchEnv({
      isolated: true,
      fakeModelOptions: {
        responseText: (request) => {
          modelRequests.push(request);
          const system = JSON.stringify(
            request.messages?.filter((m) => m.role === "system" || m.role === "developer"),
          );
          const content = request.messages?.findLast((m) => m.role === "user")?.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map((p) => p.text ?? "").join("")
                : "";
          if (system.includes("Extract only durable")) {
            const input = JSON.parse(text);
            const source = input.sources.find((s) =>
              s.text.includes("Across all projects prefer short explanations."),
            );
            return JSON.stringify(
              source
                ? [
                    {
                      scope: "user",
                      kind: "preference",
                      content: "Prefer short explanations.",
                      quote: "Across all projects prefer short explanations.",
                      entryId: source.entryId,
                    },
                  ]
                : [],
            );
          }
          if (system.includes("Compare the evidence-validated"))
            return JSON.stringify([{ candidateIndex: 0, action: "add", relatedIds: [] }]);
          return undefined;
        },
      },
    });
    const root = process.env.PIX_SMOKE_ROOT || resolve(import.meta.dirname, ".."),
      outside = mkdtempSync(join(tmpdir(), "pix-memory-smoke-"));
    const archivePath = join(outside, "roundtrip.pixarchive");
    let client;
    const launch = () =>
      new SidecarClient(
        root,
        { ...prepared.environment, PIX_NO_AUTO_RESUME: "1" },
        async (method) => {
          if (method === "dialog.save") return { canceled: false, filePath: archivePath };
          if (method === "dialog.open") return { canceled: false, filePaths: [archivePath] };
          if (method === "paths.was-dropped") return false;
          return null;
        },
      );
    try {
      client = launch();
      await client.ready;
      const cwd = prepared.environment.PIX_WORKSPACE;
      await client.invoke("pix:host:start", { cwd });
      await client.invoke("pix:trust:set", true);
      let state = await client.invoke("pix:memory:state");
      assert.equal(state.preferences.longTerm, false);
      await assert.rejects(
        client.invoke("pix:memory:create", { scope: "user", kind: "fact", content: "not enabled" }),
        /scope_disabled/,
      );
      await client.invoke(
        "pix:memory:preferences",
        { longTerm: true, shortTerm: true },
        state.preferences.revision,
      );
      const project = await client.invoke("pix:memory:project", cwd);
      const personal = await client.invoke("pix:memory:create", {
        scope: "user",
        kind: "preference",
        content: "Use concise Chinese explanations.",
      });
      await client.invoke("pix:memory:create", {
        scope: "project",
        projectId: project.id,
        kind: "fact",
        content: "The local fixture is fixture.txt.",
      });
      await client.invoke("pix:agent:prompt", "Hello memory smoke");
      const attachment = join(cwd, "portable.txt");
      writeFileSync(attachment, "portable-smoke-attachment");
      await client.invoke(
        "pix:agent:prompt",
        `Attachment fixture\n<attached-paths><path>${attachment}</path></attached-paths>`,
      );
      const sourceSnapshot = await client.invoke("pix:host:snapshot");
      await client.invoke("pix:side-chats:save", {
        version: 1,
        activeBySession: { [sourceSnapshot.sessionFile]: "side-smoke" },
        chats: {
          "side-smoke": {
            id: "side-smoke",
            sessionKey: sourceSnapshot.sessionFile,
            sessionId: sourceSnapshot.sessionId,
            selection: { messageId: "source", text: "quoted", context: "source context" },
            sourceMessages: [],
            messages: [
              { id: "u", role: "user", text: "explain attachment", attachments: [attachment] },
            ],
            draft: "keep this draft",
            attachments: [attachment],
            status: "streaming",
            requestId: "stale-request",
            settings: { thinkingLevel: "off", serviceTier: "default", accessMode: "full" },
            error: "",
          },
        },
      });
      const exported = await client.invoke("pix:archives:export", {
        personal: true,
        project: true,
        sessions: true,
        cwd,
        format: "pix",
      });
      assert.equal(exported.path, archivePath);
      assert.ok(readFileSync(archivePath).length > 100);
      const imported = await client.invoke("pix:archives:import");
      assert.equal(imported.memoryCount, 2);
      assert.equal(imported.sessions.length, 1);
      assert.equal(imported.attachmentCount, 1);
      assert.equal(imported.sideChatCount, 1);
      rmSync(attachment);
      const continued = await client.invoke("pix:archives:continue", {
        archiveId: imported.id,
        sessionId: imported.sessions[0].id,
        cwd,
      });
      const restoredChat = Object.values(continued.sideChats.chats)[0];
      assert.equal(restoredChat.draft, "keep this draft");
      assert.equal(restoredChat.status, "stopped");
      assert.equal(restoredChat.settings.accessMode, "default");
      assert.equal(readFileSync(restoredChat.attachments[0], "utf8"), "portable-smoke-attachment");
      const continuedSnapshot = await client.invoke("pix:host:snapshot");
      await client.invoke("pix:archives:continue", {
        archiveId: imported.id,
        sessionId: imported.sessions[0].id,
        cwd,
      });
      assert.equal(
        (await client.invoke("pix:host:snapshot")).sessionId,
        continuedSnapshot.sessionId,
      );
      const storage = await client.invoke("pix:storage:state");
      assert.ok(existsSync(join(storage.archives, "attachments", imported.id)));
      assert.equal((await client.invoke("pix:archives:list")).length, 1);
      const again = await client.invoke("pix:archives:restore", {
        archiveId: imported.id,
        personal: true,
        project: true,
        cwd,
      });
      assert.deepEqual(again, { imported: 0, skipped: 2 });
      state = await client.invoke("pix:memory:state");
      await client.invoke(
        "pix:memory:preferences",
        { dailyTokenBudget: 100000 },
        state.preferences.revision,
      );
      await client.invoke("pix:agent:prompt", "Across all projects prefer short explanations.");
      for (let attempt = 0; attempt < 100; attempt++) {
        const learned = await client.invoke("pix:memory:list", { scope: "user" });
        if (learned.some((r) => r.content === "Prefer short explanations.")) break;
        if (attempt === 99) throw new Error("production_two_phase_learning_did_not_complete");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(JSON.stringify(modelRequests).includes("Compare the evidence-validated"));
      await client.invoke("pix:memory:forget", [personal.id]);
      state = await client.invoke("pix:memory:state");
      await client.invoke(
        "pix:memory:preferences",
        { longTerm: false, shortTerm: false },
        state.preferences.revision,
      );
      await client.close();
      client = launch();
      await client.ready;
      state = await client.invoke("pix:memory:state");
      assert.equal(state.preferences.longTerm, false);
      assert.equal(state.counts.user, 1);
      assert.equal(state.counts.project, 1);
      assert.equal((await client.invoke("pix:archives:list")).length, 1);
    } finally {
      await client?.close();
      await prepared.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  },
);
