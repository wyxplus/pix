import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyVerified, initializeStorage } from "./profile.ts";
import { relocateManagedRuntimes } from "./runtime-references.ts";
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "pix-storage-test-"));
  paths.push(path);
  return path;
}
it("preserves legacy desktop and explicit Agent directory semantics", async () => {
  const path = await root();
  const env = { PIX_DATA_DIR: join(path, "desktop"), PI_CODING_AGENT_DIR: join(path, "agent") };
  const profile = await initializeStorage(env);
  expect(profile.mode).toBe("legacy");
  expect(profile.desktop).toBe(env.PIX_DATA_DIR);
  expect(profile.agent).toBe(env.PI_CODING_AGENT_DIR);
  expect(profile.externalAgent).toBe(true);
});
it("resolves an explicit unified root before consumers import pi", async () => {
  const path = await root();
  const env: NodeJS.ProcessEnv = {
    PIX_DATA_DIR: join(path, "old"),
    PIX_STORAGE_DIR: join(path, "chosen"),
  };
  const profile = await initializeStorage(env);
  expect(profile.mode).toBe("environment");
  expect(env.PI_CODING_AGENT_DIR).toBe(join(path, "chosen", "agent"));
  expect(env.PIX_DATA_DIR).toBe(join(path, "chosen", "desktop"));
});
it("portable marker chooses a writable sibling data directory", async () => {
  const path = await root();
  await writeFile(join(path, "pix-portable.json"), "{}");
  const profile = await initializeStorage({
    PIX_DATA_DIR: join(path, "legacy"),
    PIX_PORTABLE_ROOT: path,
  });
  expect(profile.mode).toBe("portable");
  expect(profile.root).toBe(join(path, "PixData"));
});
it("copies and verifies on boot, then atomically activates without deleting sources", async () => {
  const path = await root(),
    desktop = join(path, "old-desktop"),
    agent = join(path, "old-agent"),
    target = join(path, "new"),
    locator = join(path, "storage-location.json");
  await mkdir(join(desktop, "memory"), { recursive: true });
  await mkdir(agent);
  await writeFile(join(desktop, "memory", "example"), "memory");
  await writeFile(join(agent, "settings.json"), "{}");
  await writeFile(
    locator,
    JSON.stringify({ version: 1, pending: { id: "migration", root: target, desktop, agent } }),
  );
  const profile = await initializeStorage({ PIX_DATA_DIR: desktop, PIX_STORAGE_LOCATOR: locator });
  expect(profile.root).toBe(target);
  expect(await readFile(join(target, "memory", "example"), "utf8")).toBe("memory");
  expect(await readFile(join(agent, "settings.json"), "utf8")).toBe("{}");
  expect(JSON.parse(await readFile(locator, "utf8"))).toEqual({ version: 1, root: target });
});
it("does not silently fall back when a configured custom disk is unavailable", async () => {
  const path = await root(),
    locator = join(path, "storage-location.json");
  await writeFile(locator, JSON.stringify({ version: 1, root: join(path, "missing") }));
  await expect(
    initializeStorage({ PIX_DATA_DIR: join(path, "old"), PIX_STORAGE_LOCATOR: locator }),
  ).rejects.toThrow("configured_storage_unavailable");
});
it("relocates managed attachment references in copied sessions without changing the retained source", async () => {
  const path = await root(),
    desktop = join(path, "old"),
    agent = join(path, "agent"),
    target = join(path, "new"),
    locator = join(path, "locator.json");
  await mkdir(join(desktop, "attachments"), { recursive: true });
  await mkdir(join(agent, "sessions"), { recursive: true });
  const image = join(desktop, "attachments", "image.png");
  await writeFile(image, "fixture");
  const jsonl =
    [
      { type: "session", version: 3, id: "test", cwd: "/project" },
      {
        type: "message",
        id: "e",
        parentId: null,
        message: {
          role: "user",
          content: `<attached-paths><path>${image}</path></attached-paths>`,
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n";
  const source = join(agent, "sessions", "test.jsonl");
  await writeFile(source, jsonl);
  await writeFile(
    locator,
    JSON.stringify({ version: 1, pending: { id: "m", root: target, desktop, agent } }),
  );
  const profile = await initializeStorage({ PIX_DATA_DIR: desktop, PIX_STORAGE_LOCATOR: locator });
  expect(profile.root).toBe(target);
  expect(await readFile(source, "utf8")).toBe(jsonl);
  // JSONL is JSON-encoded, so compare against parsed rows instead of raw bytes (backslashes are escaped on Windows).
  const copied = (await readFile(join(target, "agent", "sessions", "test.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { message?: { content?: string } });
  expect(
    copied.some((row) =>
      row.message?.content?.includes(join(target, "desktop", "attachments", "image.png")),
    ),
  ).toBe(true);
  expect(await readFile(join(target, "desktop", "attachments", "image.png"), "utf8")).toBe(
    "fixture",
  );
});
it("refuses symlinks instead of exporting an unrelated external tree", async () => {
  const path = await root(),
    source = join(path, "source"),
    outside = join(path, "outside");
  await mkdir(source);
  await writeFile(outside, "private");
  await symlink(outside, join(source, "link"));
  await expect(copyVerified(source, join(path, "target"))).rejects.toThrow(
    "storage_symlink_requires_manual_migration",
  );
});
it("relocates only internal managed-runtime links and keeps their content inside the copy", async () => {
  const path = await root(),
    source = join(path, "source"),
    target = join(path, "target");
  await mkdir(join(source, "runtimes", "python", "bin"), { recursive: true });
  await mkdir(join(source, "runtimes", "python-venv", "bin"), { recursive: true });
  await writeFile(join(source, "runtimes", "python", "bin", "python3"), "python fixture");
  await symlink(
    join(source, "runtimes", "python", "bin", "python3"),
    join(source, "runtimes", "python-venv", "bin", "python"),
  );
  await copyVerified(source, target, { managedRuntimeLinks: true });
  expect(await realpath(join(target, "runtimes", "python-venv", "bin", "python"))).toBe(
    await realpath(join(target, "runtimes", "python", "bin", "python3")),
  );
  await writeFile(join(path, "external"), "outside");
  await symlink(join(path, "external"), join(source, "runtimes", "outside"));
  await expect(
    copyVerified(source, join(path, "rejected"), { managedRuntimeLinks: true }),
  ).rejects.toThrow("storage_symlink_requires_manual_migration");
  const externalRoot = join(path, "external-runtime-root"),
    deceptive = join(path, "deceptive");
  await mkdir(externalRoot);
  await mkdir(deceptive);
  await symlink(
    externalRoot,
    join(deceptive, "runtimes"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(
    copyVerified(deceptive, join(path, "rejected-root"), { managedRuntimeLinks: true }),
  ).rejects.toThrow("storage_symlink_requires_manual_migration");
});
it("repairs venv configuration, POSIX wrappers and Windows launcher overlays without changing package payloads", async () => {
  const path = await root(),
    old = join(path, "old"),
    next = join(path, "new");
  const scripts = join(next, "runtimes", "python-venv", "Scripts");
  await mkdir(scripts, { recursive: true });
  const prior = join(old, "runtimes", "python-venv", "Scripts", "python.exe");
  const prefix = Buffer.from("MZ\0fake-launcher-stub\0"),
    payload = Buffer.from("PK\x03\x04unchanged ZIP payload");
  await writeFile(
    join(scripts, "pip.exe"),
    Buffer.concat([prefix, Buffer.from(`#!${prior}\r\n`), payload]),
  );
  await writeFile(join(scripts, "wrapper"), `#!/bin/sh\n'${prior}' "$@"\n`);
  const cfg = join(next, "runtimes", "python-venv", "pyvenv.cfg");
  await writeFile(cfg, `home = ${join(old, "runtimes", "python", "bin")}\n`);
  expect(await relocateManagedRuntimes(old, next)).toBe(3);
  const executable = await readFile(join(scripts, "pip.exe"));
  expect(executable.subarray(0, prefix.length)).toEqual(prefix);
  expect(executable.subarray(-payload.length)).toEqual(payload);
  expect(executable.toString()).toContain(
    join(next, "runtimes", "python-venv", "Scripts", "python.exe"),
  );
  expect(await readFile(cfg, "utf8")).not.toContain(old);
  expect(await readFile(join(scripts, "wrapper"), "utf8")).not.toContain(old);
});
it("failed migration keeps the previous profile and exposes a recovery message", async () => {
  const path = await root(),
    desktop = join(path, "desktop"),
    locator = join(path, "locator.json"),
    target = join(path, "target");
  await mkdir(desktop);
  await writeFile(join(desktop, "original"), "unchanged");
  await mkdir(target);
  await writeFile(
    locator,
    JSON.stringify({ version: 1, pending: { id: "partial", root: target, desktop } }),
  );
  const profile = await initializeStorage({ PIX_DATA_DIR: desktop, PIX_STORAGE_LOCATOR: locator });
  expect(profile.mode).toBe("legacy");
  expect(profile.migrationError).toContain("storage_migration_incomplete");
  expect(await readFile(join(desktop, "original"), "utf8")).toBe("unchanged");
});
