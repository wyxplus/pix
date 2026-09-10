import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { prepareLaunchEnv } from "./launch-env.mjs";
import { SidecarClient } from "./sidecar-client.mjs";

await test(
  "Node Sidecar: SDK, stream, sessions, settings, Git, abort, crash recovery and shutdown",
  { timeout: 120_000 },
  async () => {
    const prepared = await prepareLaunchEnv({ isolated: true });
    const nativeCalls = [];
    const client = new SidecarClient(
      process.env.PIX_SMOKE_ROOT || resolve(import.meta.dirname, ".."),
      { ...prepared.environment, PIX_NO_AUTO_RESUME: "1" },
      async (method, params) => {
        nativeCalls.push({ method, params });
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
      await client.invoke("pix:trust:set", true);
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
      assert.ok(await client.invoke("pix:settings:get"));
      assert.equal(await client.invoke("pix:appearance:set-app-scale", 120), 120);
      assert.ok(nativeCalls.some((c) => c.method === "window.scale" && c.params.scale === 1.2));
      assert.ok(
        await client.invoke("pix:workspace:get-git-context", prepared.environment.PIX_WORKSPACE),
      );
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
    }
  },
);
