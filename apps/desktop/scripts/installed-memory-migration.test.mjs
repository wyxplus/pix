import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, stat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareLaunchEnv } from "./launch-env.mjs";
import { SidecarClient } from "./sidecar-client.mjs";
const exec = promisify(execFile);
const venvPython = (desktop) =>
  join(
    desktop,
    "runtimes",
    "python-venv",
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
await test(
  "installed Sidecar migrates durable memory, preferences and sessions, then writes only in new root",
  { timeout: 90000 },
  async () => {
    const prepared = await prepareLaunchEnv({ isolated: true });
    const root = await realpath(await mkdtemp(join(tmpdir(), "Pix migration 验收 "))),
      old = join(root, "old-profile"),
      destination = join(root, "new-parent"),
      locator = join(root, "location.json");
    await mkdir(join(old, "desktop"), { recursive: true });
    await mkdir(destination);
    await cp(prepared.environment.PI_CODING_AGENT_DIR, join(old, "agent"), { recursive: true });
    await writeFile(locator, JSON.stringify({ version: 1, root: old }));
    const env = {
      ...prepared.environment,
      PIX_DATA_DIR: join(root, "unused-desktop"),
      PIX_STORAGE_LOCATOR: locator,
      PIX_NO_AUTO_RESUME: "1",
    };
    delete env.PI_CODING_AGENT_DIR;
    delete env.PIX_STORAGE_DIR;
    const app = process.env.PIX_SMOKE_ROOT || resolve(import.meta.dirname, "..");
    let client;
    const launch = () =>
      new SidecarClient(app, env, async (method) =>
        method === "dialog.open" ? { canceled: false, filePaths: [destination] } : null,
      );
    try {
      client = launch();
      await client.ready;
      const cwd = prepared.environment.PIX_WORKSPACE;
      await client.invoke("pix:host:start", { cwd });
      await client.invoke("pix:trust:set", true);
      const python = venvPython(join(old, "desktop"));
      const pythonEnvironment = { ...process.env };
      delete pythonEnvironment.PYTHONHOME;
      delete pythonEnvironment.PYTHONPATH;
      const pythonOptions = { env: pythonEnvironment, timeout: 30000 };
      const site = JSON.parse(
        (
          await exec(
            python,
            ["-c", "import json,sysconfig; print(json.dumps(sysconfig.get_path('purelib')))"],
            pythonOptions,
          )
        ).stdout,
      );
      assert.ok(site.startsWith(join(old, "desktop")));
      await writeFile(join(site, "pix_migration_probe.py"), "CANARY = 'SITE_PACKAGE_EMERALD'\n");
      const state = await client.invoke("pix:memory:state");
      await client.invoke(
        "pix:memory:preferences",
        { longTerm: true, shortTerm: true },
        state.preferences.revision,
      );
      const project = await client.invoke("pix:memory:project", cwd);
      await client.invoke("pix:memory:create", {
        scope: "user",
        kind: "preference",
        content: "Retain USER_PEARL through storage migration.",
      });
      const forgotten = await client.invoke("pix:memory:create", {
        scope: "project",
        projectId: project.id,
        kind: "fact",
        content: "Forget PROJECT_OPAL before migration.",
      });
      await client.invoke("pix:memory:forget", [forgotten.id]);
      await client.invoke("pix:agent:prompt", "Installed migration history SESSION_QUARTZ.");
      const before = await client.invoke("pix:host:snapshot");
      const planned = await client.invoke("pix:storage:choose");
      assert.ok(planned.pendingRoot.startsWith(destination));
      await client.close();
      client = undefined;
      const oldDatabase = join(old, "memory", "memory.sqlite");
      const oldBytes = await readFile(oldDatabase);
      client = launch();
      await client.ready;
      const storage = await client.invoke("pix:storage:state");
      assert.equal(storage.root, planned.pendingRoot, storage.migrationError);
      assert.equal(storage.externalAgent, false);
      const nextPython = venvPython(storage.desktop);
      const pythonProof = JSON.parse(
        (
          await exec(
            nextPython,
            [
              "-c",
              "import json,sys,pix_migration_probe; print(json.dumps({'prefix':sys.prefix,'module':pix_migration_probe.__file__,'canary':pix_migration_probe.CANARY}))",
            ],
            pythonOptions,
          )
        ).stdout,
      );
      assert.equal(
        await realpath(pythonProof.prefix),
        await realpath(join(storage.desktop, "runtimes", "python-venv")),
      );
      assert.ok(pythonProof.module.startsWith(storage.desktop));
      assert.equal(pythonProof.canary, "SITE_PACKAGE_EMERALD");
      const pip = join(
        storage.desktop,
        "runtimes",
        "python-venv",
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "pip.exe" : "pip",
      );
      const pipProof = (await exec(pip, ["--version"], pythonOptions)).stdout;
      assert.ok(pipProof.includes(storage.desktop), pipProof);
      assert.ok(!pipProof.includes(join(old, "desktop")), pipProof);
      const personal = await client.invoke("pix:memory:list", { scope: "user" });
      assert.equal(personal.length, 1);
      assert.ok(personal[0].content.includes("USER_PEARL"));
      const p = await client.invoke("pix:memory:project", cwd);
      assert.equal(p.id, project.id);
      assert.deepEqual(
        await client.invoke("pix:memory:list", { scope: "project", projectId: p.id }),
        [],
      );
      await client.invoke("pix:host:start", { cwd });
      await client.invoke("pix:trust:set", true);
      await client.invoke("pix:memory:create", {
        scope: "project",
        projectId: p.id,
        kind: "fact",
        content: "New root only NEW_ROOT_TOPAZ.",
      });
      await client.invoke("pix:agent:prompt", "Post-migration history SESSION_TOURMALINE.");
      const after = await client.invoke("pix:host:snapshot");
      assert.ok(after.sessionFile.startsWith(join(storage.root, "agent")));
      assert.ok(before.sessionFile.startsWith(join(old, "agent")));
      const movedSource = before.sessionFile.replace(
        join(old, "agent"),
        join(storage.root, "agent"),
      );
      assert.ok((await readFile(movedSource, "utf8")).includes("SESSION_QUARTZ"));
      await client.close();
      client = undefined;
      assert.deepEqual(
        await readFile(oldDatabase),
        oldBytes,
        "old database changed after new profile activation",
      );
      assert.equal((await stat(old)).isDirectory(), true);
    } finally {
      await client?.close();
      await prepared.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  },
);
