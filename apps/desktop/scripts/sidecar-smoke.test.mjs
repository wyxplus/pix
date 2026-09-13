import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { prepareLaunchEnv } from "./launch-env.mjs";
import { SidecarClient } from "./sidecar-client.mjs";

if (process.argv.includes("--staged")) {
  const desktop = resolve(import.meta.dirname, "..");
  process.env.PIX_SMOKE_NODE = join(
    desktop,
    "src-tauri/binaries",
    process.platform === "win32" ? "node.exe" : "node",
  );
  process.env.PIX_SMOKE_ROOT = join(desktop, "src-tauri/resources/sidecar");
  process.env.PIX_RESOURCES_DIR = join(desktop, "src-tauri/resources");
  process.env.PIX_PACKAGED = "1";
}

await test(
  "Node Sidecar: SDK, stream, sessions, settings, Git, abort, crash recovery and shutdown",
  { timeout: 120_000 },
  async () => {
    const prepared = await prepareLaunchEnv({ isolated: true });
    const extensionDir = join(prepared.environment.PI_CODING_AGENT_DIR, "extensions");
    const extensionProof = join(prepared.environment.PIX_WORKSPACE, "extension-node.json");
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(
      join(extensionDir, "shared-node-smoke.ts"),
      `
import { writeFileSync } from "node:fs";
export default function (pi: any) {
  pi.on("session_start", () => writeFileSync(${JSON.stringify(extensionProof)}, JSON.stringify({ node: process.execPath, version: process.version })));
}
`,
    );
    const nativeCalls = [];
    let pickerPaths = [];
    const outside = mkdtempSync(join(tmpdir(), "pix-ipc-security-"));
    const outsideImage = join(outside, "private.png");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(outsideImage, png);
    const client = new SidecarClient(
      process.env.PIX_SMOKE_ROOT || resolve(import.meta.dirname, ".."),
      { ...prepared.environment, PIX_NO_AUTO_RESUME: "1" },
      async (method, params) => {
        nativeCalls.push({ method, params });
        if (method === "dialog.open") return { canceled: false, filePaths: pickerPaths };
        if (method === "paths.was-dropped") return false;
        return null;
      },
    );
    const events = [];
    client.on("event", (event) => events.push(event));
    try {
      await client.ready;
      const runtime = await client.invoke("pix:app:get-runtime");
      assert.match(runtime.appVersion, /^\d+\.\d+\.\d+/);
      assert.equal(runtime.isPackaged, process.env.PIX_PACKAGED === "1");
      const sdk = await client.invoke("pix:pi-sdk:get-status");
      assert.ok(
        sdk.candidates.some((candidate) => candidate.source === "builtin" && candidate.available),
      );
      await assert.rejects(client.invoke("pix:not-a-real-command"), /Unknown RPC channel/);
      const snapshot = await client.invoke("pix:host:start", {
        cwd: prepared.environment.PIX_WORKSPACE,
      });
      assert.ok(snapshot.runtimeId);
      // A fresh session need not have been flushed to disk yet.
      if (snapshot.sessionFile) await client.invoke("pix:session:switch", snapshot.sessionFile);
      await assert.rejects(
        client.invoke("pix:workspace:save-clipboard-image", {
          ext: "../../../escape",
          bytes: [65],
        }),
        /extension/,
      );
      const pasted = await client.invoke("pix:workspace:save-clipboard-image", {
        ext: "png",
        bytes: [...png],
      });
      assert.ok(
        (await client.invoke("pix:workspace:read-attachment-preview", pasted)).startsWith(
          "data:image/png;base64,",
        ),
      );
      await assert.rejects(
        client.invoke("pix:workspace:read-attachment-preview", outsideImage),
        /not authorized/,
      );
      await assert.rejects(client.invoke("pix:workspace:open-path", outside), /not authorized/);
      await assert.rejects(client.invoke("pix:workspace:git-status", outside), /not authorized/);
      await assert.rejects(
        client.invoke("pix:agent:prompt", "Image", undefined, [outsideImage]),
        /not authorized/,
      );
      const executable = join(prepared.environment.PIX_WORKSPACE, "evil.exe");
      writeFileSync(executable, "MZ");
      await assert.rejects(client.invoke("pix:workspace:open-file", executable), /Executable/);
      assert.ok(
        !nativeCalls.some(
          (call) => call.method === "shell.open-path" && call.params.path === executable,
        ),
      );
      pickerPaths = [outsideImage];
      await client.invoke("pix:workspace:pick-attachments", { mode: "files" });
      assert.ok(
        (await client.invoke("pix:workspace:read-attachment-preview", outsideImage)).startsWith(
          "data:image/png;base64,",
        ),
      );
      await client.invoke("pix:trust:set", true);
      await client.invoke("pix:runtime:reload");
      const extensionNode = JSON.parse(readFileSync(extensionProof, "utf8"));
      assert.match(extensionNode.version, /^v24\./);
      assert.equal(
        realpathSync(extensionNode.node),
        realpathSync(process.env.PIX_SMOKE_NODE || process.execPath),
      );
      if (process.env.PIX_PACKAGED === "1") {
        const tools = await client.invoke("pix:runtimes:get-status");
        assert.equal(realpathSync(tools.node.path), realpathSync(extensionNode.node));
        assert.equal(tools.node.version, extensionNode.version.slice(1));
      }
      assert.ok(await client.invoke("pix:models:list"));
      const [models, modelConfig, settings] = await Promise.all([
        client.invoke("pix:models:refresh-catalog"),
        client.invoke("pix:models:get-config"),
        client.invoke("pix:settings:get"),
      ]);
      assert.ok(models.some((model) => model.provider === "pix-fake" && model.id === "pix-fake"));
      assert.ok(modelConfig);
      assert.ok(settings);
      await client.invoke("pix:models:set", "pix-fake", "pix-fake");
      await client.invoke("pix:agent:prompt", "Read fixture.txt and explain the result.");
      assert.ok(
        events.some((e) => e.channel === "pix:host:event" && e.payload.type === "runtime.event"),
      );
      const sessions = await client.invoke("pix:session:list");
      assert.ok(sessions.threads.length >= 1);
      const active = sessions.threads.find((thread) => thread.active) ?? sessions.threads[0];
      const opened = await client.invoke("pix:session:switch", active.path);
      const streamed = events
        .filter(
          (event) => event.channel === "pix:host:event" && event.payload.type === "runtime.event",
        )
        .map((event) => event.payload.event);
      const textIds = [
        ...new Set(
          streamed
            .filter((event) => event.type === "message.delta")
            .map((event) => event.messageId),
        ),
      ];
      assert.ok(textIds.length > 0 && textIds.every((id) => typeof id === "string"));
      for (const id of textIds)
        assert.ok(
          opened.history.some((row) => row.messageId === id),
          "Live assistant identity must survive session promotion into persisted history",
        );
      for (const event of streamed.filter((event) => event.type === "tool.completed"))
        assert.ok(
          opened.history.some((row) => row.toolCallId === event.toolCallId),
          "History must retain the exact tool call identity",
        );
      assert.ok(await client.invoke("pix:settings:get"));
      assert.equal(await client.invoke("pix:appearance:set-app-scale", 120), 120);
      assert.ok(nativeCalls.some((c) => c.method === "window.scale" && c.params.scale === 1.2));
      assert.ok(
        await client.invoke("pix:workspace:get-git-context", prepared.environment.PIX_WORKSPACE),
      );
      const repo = join(prepared.environment.PIX_WORKSPACE, "security-git");
      mkdirSync(repo);
      const git = (...args) =>
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
          cwd: repo,
          stdio: "pipe",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid",
          },
        });
      git("init", "-b", "main");
      writeFileSync(join(repo, "file"), "first");
      git("add", ".");
      git("commit", "-m", "first");
      const linked = join(repo, "linked");
      await assert.rejects(
        client.invoke("pix:workspace:create-git-worktree", {
          cwd: repo,
          path: linked,
          newBranch: "trial",
          branch: "-f",
        }),
        /Invalid start ref/,
      );
      const worktree = await client.invoke("pix:workspace:create-git-worktree", {
        cwd: repo,
        path: linked,
        newBranch: "trial",
        branch: "HEAD",
      });
      assert.equal(realpathSync(worktree.path), realpathSync(linked));
      assert.equal(git("branch", "--list", "pix/trial").toString().trim(), "+ pix/trial");
      const exportedPath = join(prepared.environment.PIX_WORKSPACE, "export.jsonl");
      await client.invoke("pix:session:export", "jsonl", exportedPath);
      await assert.rejects(
        client.invoke("pix:session:export", "jsonl", join(outside, "export.jsonl")),
        /not authorized/,
      );
      await client.invoke("pix:session:import", exportedPath);
      await client.invoke("pix:agent:abort");
      await client.invoke("pix:test:crash-host").catch(() => {});
      const recovered = await client.invoke("pix:host:start", {
        cwd: prepared.environment.PIX_WORKSPACE,
      });
      assert.ok(recovered.runtimeId);
      assert.notEqual(recovered.runtimeId, snapshot.runtimeId);
      await client.invoke("pix:host:stop");
    } finally {
      await client.close();
      await prepared.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  },
);
