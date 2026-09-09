import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runDevSession } from "./dev-session.mjs";

async function fixture(port = 0) {
  const cwd = await mkdtemp(join(tmpdir(), "pix-dev-session-"));
  const configFile = join(cwd, "vite.config.mjs");
  await writeFile(
    configFile,
    `export default ${JSON.stringify({
      root: cwd,
      logLevel: "silent",
      server: { host: "127.0.0.1", port, strictPort: true },
    })}`,
  );
  return { cwd, configFile, env: process.env, command: process.execPath };
}

async function listen(port = 0) {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return server;
}
async function assertPortReleased(port) {
  const server = await listen(port);
  await new Promise((resolve) => server.close(resolve));
}

await test("occupied dev port selects another URL and releases it after normal exit", async () => {
  const occupied = await listen();
  const options = await fixture(occupied.address().port);
  let devPort;
  try {
    const code = await runDevSession({
      ...options,
      args: (url) => {
        devPort = Number(new URL(url).port);
        return ["-e", "process.exit(0)"];
      },
    });
    assert.equal(code, 0);
    assert.notEqual(devPort, occupied.address().port);
    assert.ok(occupied.listening);
    await assertPortReleased(devPort);
  } finally {
    occupied.close();
    await rm(options.cwd, { recursive: true, force: true });
  }
});

await test("a failed native spawn also closes the frontend", async () => {
  const options = await fixture();
  let devPort;
  try {
    await assert.rejects(
      runDevSession({
        ...options,
        command: join(options.cwd, "missing-tauri"),
        args: (url) => {
          devPort = Number(new URL(url).port);
          return [];
        },
      }),
      /ENOENT/,
    );
    await assertPortReleased(devPort);
  } finally {
    await rm(options.cwd, { recursive: true, force: true });
  }
});

await test(
  "interrupting the launcher releases Vite and its native grandchild's port",
  {
    timeout: 20_000,
    skip: process.platform === "win32",
  },
  async () => {
    const options = await fixture();
    const grandchild = `process.on('SIGTERM', () => {}); require('node:net').createServer().listen(0, '127.0.0.1', function () { console.log('GRANDCHILD ' + this.address().port); });`;
    const native = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'inherit'}); setInterval(() => {}, 1000);`;
    const moduleUrl = pathToFileURL(join(import.meta.dirname, "dev-session.mjs")).href;
    const { env: _env, ...launchOptions } = options;
    const script = `import { runDevSession } from ${JSON.stringify(moduleUrl)}; process.exitCode = await runDevSession({ ...${JSON.stringify(launchOptions)}, env: process.env, args: url => { console.log('FRONTEND ' + new URL(url).port); return ['-e', ${JSON.stringify(native)}]; } });`;
    const launcher = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const exited = once(launcher, "close");
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 10_000);
        launcher.stdout.on("data", (chunk) => {
          output += chunk;
          if (/FRONTEND \d+/.test(output) && /GRANDCHILD \d+/.test(output)) {
            clearTimeout(timer);
            resolve();
          }
        });
        launcher.stderr.on("data", (chunk) => {
          output += chunk;
        });
      });
      launcher.kill("SIGTERM");
      const [code] = await exited;
      assert.equal(code, 0, output);
      await assertPortReleased(Number(output.match(/FRONTEND (\d+)/)[1]));
      await assertPortReleased(Number(output.match(/GRANDCHILD (\d+)/)[1]));
    } finally {
      launcher.kill("SIGTERM");
      await rm(options.cwd, { recursive: true, force: true });
    }
  },
);
