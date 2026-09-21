import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  lstat,
  copyFile,
  realpath,
  readlink,
  symlink,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { relocateManagedReferences } from "./references.ts";
import { relocateManagedRuntimes } from "./runtime-references.ts";

export interface StorageProfile {
  mode: "legacy" | "custom" | "portable" | "environment";
  root: string;
  desktop: string;
  agent: string;
  memory: string;
  archives: string;
  locator: string;
  externalAgent: boolean;
  pendingRoot?: string;
  migrationError?: string;
}
type Locator = {
  version: 1;
  root?: string;
  migrationError?: string;
  pending?: { id: string; root: string; desktop: string; agent?: string };
};
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function atomicJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: "wx", flush: true });
  await rename(temp, path);
}
async function loadLocator(path: string): Promise<Locator> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Locator;
    if (
      value.version !== 1 ||
      (value.root && !isAbsolute(value.root)) ||
      (value.pending && !isAbsolute(value.pending.root))
    )
      throw new Error("invalid_storage_locator");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw error;
  }
}
/** Copy verified files; only relocate explicitly allowed links within managed runtimes. */
export async function copyVerified(
  source: string,
  target: string,
  options: { managedRuntimeLinks?: boolean } = {},
): Promise<number> {
  let copied = 0;
  const inventory = new Map<string, string>();
  const directories = new Map<string, string>();
  const links = new Map<string, { raw: string; destination: string; expected: string }>();
  const runtimeRoot = join(source, "runtimes");
  const inside = (base: string, path: string) => {
    const part = relative(base, path);
    return part === "" || (!part.startsWith("..") && !isAbsolute(part));
  };
  const ignore = (directory: string, name: string) =>
    directory === source &&
    ["storage-location.json", "storage-migration.json", "tmp"].includes(name);
  async function copy(directory: string, destination: string) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const entries = await readdir(directory, { withFileTypes: true });
    directories.set(
      directory,
      entries
        .map((entry) => entry.name)
        .filter((name) => !ignore(directory, name))
        .sort()
        .join("\0"),
    );
    for (const entry of entries) {
      if (ignore(directory, entry.name)) continue;
      const from = join(directory, entry.name),
        to = join(destination, entry.name);
      if (entry.isSymbolicLink()) {
        if (!options.managedRuntimeLinks || from === runtimeRoot || !inside(runtimeRoot, from))
          throw new Error(`storage_symlink_requires_manual_migration: ${from}`);
        const raw = await readlink(from);
        const original = await realpath(from);
        if (!inside(await realpath(runtimeRoot), original))
          throw new Error(`storage_symlink_requires_manual_migration: ${from}`);
        const expected = resolve(target, relative(await realpath(source), original));
        const directory = (await stat(original)).isDirectory();
        await symlink(
          process.platform === "win32" && directory ? expected : relative(dirname(to), expected),
          to,
          directory ? (process.platform === "win32" ? "junction" : "dir") : "file",
        );
        links.set(from, { raw, destination: to, expected });
        copied++;
      } else if (entry.isDirectory()) await copy(from, to);
      else if (entry.isFile()) {
        const before = digest(await readFile(from));
        await copyFile(from, to, 1);
        if (digest(await readFile(to)) !== before) throw new Error("storage_copy_mismatch");
        inventory.set(from, before);
        copied++;
      } else throw new Error(`unsupported_storage_entry: ${from}`);
    }
  }
  await copy(source, target);
  for (const [path, hash] of inventory)
    if (digest(await readFile(path)) !== hash) throw new Error("storage_source_changed");
  for (const [path, link] of links) {
    if (
      (await readlink(path)) !== link.raw ||
      (await realpath(link.destination)) !== (await realpath(link.expected))
    )
      throw new Error("storage_source_changed");
  }
  for (const [directory, names] of directories) {
    if (
      (await readdir(directory))
        .filter((name) => !ignore(directory, name))
        .sort()
        .join("\0") !== names
    )
      throw new Error("storage_source_changed");
  }
  return copied;
}

export async function initializeStorage(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StorageProfile> {
  const desktopLegacy = resolve(env.PIX_DATA_DIR || join(homedir(), ".pix"));
  const locatorPath = env.PIX_STORAGE_LOCATOR || join(desktopLegacy, "storage-location.json");
  const locator = await loadLocator(locatorPath);
  const override = env.PIX_STORAGE_DIR;
  const portable =
    env.PIX_PORTABLE_ROOT && existsSync(join(env.PIX_PORTABLE_ROOT, "pix-portable.json"))
      ? join(env.PIX_PORTABLE_ROOT, "PixData")
      : undefined;
  if (!override && !portable && locator.pending) {
    const pending = locator.pending;
    const previousRoot = locator.root;
    try {
      // A fresh child directory is used so interruption never replaces existing data.
      if (existsSync(pending.root))
        throw new Error(
          `storage_migration_incomplete: inspect ${pending.root}; original data remains at ${pending.desktop}`,
        );
      await mkdir(pending.root, { recursive: true, mode: 0o700 });
      await atomicJson(join(pending.root, "storage-migration.json"), {
        id: pending.id,
        status: "copying",
        source: pending.desktop,
      });
      let copied = await copyVerified(pending.desktop, join(pending.root, "desktop"), {
        managedRuntimeLinks: true,
      });
      if (pending.agent && existsSync(pending.agent))
        copied += await copyVerified(pending.agent, join(pending.root, "agent"));
      // Previous unified layouts keep memory/archives alongside desktop.
      if (locator.root)
        for (const name of ["memory", "archives"]) {
          const source = join(locator.root, name);
          if (existsSync(source)) copied += await copyVerified(source, join(pending.root, name));
        }
      else
        for (const name of ["memory", "archives"]) {
          const source = join(pending.root, "desktop", name);
          if (existsSync(source)) await rename(source, join(pending.root, name));
        }
      const rewrittenReferences = await relocateManagedReferences({
        oldDesktop: pending.desktop,
        oldRoot: previousRoot ?? pending.desktop,
        ...(pending.agent ? { oldAgent: pending.agent } : {}),
        root: pending.root,
      });
      const rewrittenRuntimeFiles = await relocateManagedRuntimes(
        pending.desktop,
        join(pending.root, "desktop"),
      );
      await atomicJson(join(pending.root, "storage-migration.json"), {
        id: pending.id,
        status: "verified",
        files: copied,
        rewrittenReferences,
        rewrittenRuntimeFiles,
        source: pending.desktop,
      });
      locator.root = pending.root;
      delete locator.pending;
      delete locator.migrationError;
      await atomicJson(locatorPath, locator);
    } catch (error) {
      if (previousRoot) locator.root = previousRoot;
      else delete locator.root;
      locator.migrationError = `${error instanceof Error ? error.message : String(error)}. Original data retained; incomplete copy: ${pending.root}`;
      delete locator.pending;
      await atomicJson(locatorPath, locator);
    }
  }
  const chosen = override || portable || locator.root;
  if (chosen && !isAbsolute(chosen)) throw new Error("storage_root_must_be_absolute");
  if (locator.root && chosen === locator.root && !existsSync(chosen))
    throw new Error("configured_storage_unavailable");
  const root = resolve(chosen || desktopLegacy);
  const desktop = chosen ? join(root, "desktop") : desktopLegacy;
  const externalAgent = Boolean(env.PI_CODING_AGENT_DIR);
  const agent = resolve(
    env.PI_CODING_AGENT_DIR || (chosen ? join(root, "agent") : join(homedir(), ".pi", "agent")),
  );
  for (const directory of [
    desktop,
    join(root, "memory"),
    join(root, "archives"),
    join(root, "tmp"),
  ])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  const probe = join(root, `.pix-write-${randomUUID()}`);
  await writeFile(probe, "", { flag: "wx", mode: 0o600 });
  const { unlink } = await import("node:fs/promises");
  await unlink(probe);
  env.PIX_DATA_DIR = desktop;
  if (chosen) env.PI_CODING_AGENT_DIR = agent;
  env.PIX_STORAGE_PROFILE = JSON.stringify({
    mode: override ? "environment" : portable ? "portable" : chosen ? "custom" : "legacy",
    root,
    desktop,
    agent,
    memory: join(root, "memory"),
    archives: join(root, "archives"),
    locator: locatorPath,
    externalAgent,
    ...(locator.migrationError ? { migrationError: locator.migrationError } : {}),
  });
  env.PIX_TEMP_DIR = join(root, "tmp");
  return JSON.parse(env.PIX_STORAGE_PROFILE) as StorageProfile;
}

export function currentStorage(): StorageProfile {
  if (!process.env.PIX_STORAGE_PROFILE) throw new Error("storage_not_initialized");
  return JSON.parse(process.env.PIX_STORAGE_PROFILE) as StorageProfile;
}
export async function storageState(): Promise<StorageProfile> {
  const current = currentStorage();
  const locator = await loadLocator(current.locator);
  return {
    ...current,
    migrationError: locator.migrationError ?? "",
    ...(locator.pending ? { pendingRoot: locator.pending.root } : {}),
  };
}
export async function scheduleStorageMove(parent: string): Promise<StorageProfile> {
  const current = currentStorage();
  if (current.mode === "environment" || current.mode === "portable")
    throw new Error("storage_location_controlled_by_launcher");
  const canonical = await realpath(parent);
  const nested = (source: string) => {
    const part = relative(source, canonical);
    return part === "" || (!part.startsWith("..") && !isAbsolute(part));
  };
  if (nested(current.root) || nested(current.agent))
    throw new Error("storage_target_inside_source");
  if (!(await lstat(canonical)).isDirectory()) throw new Error("invalid_storage_target");
  const id = randomUUID();
  const root = join(canonical, `PixData-${id.slice(0, 8)}`);
  const locator = await loadLocator(current.locator);
  delete locator.migrationError;
  locator.pending = {
    id,
    root,
    desktop: current.desktop,
    ...(!current.externalAgent ? { agent: current.agent } : {}),
  };
  await atomicJson(current.locator, locator);
  return storageState();
}
export async function cancelStorageMove(): Promise<StorageProfile> {
  const current = currentStorage();
  const locator = await loadLocator(current.locator);
  delete locator.pending;
  await atomicJson(current.locator, locator);
  return storageState();
}

/** Same profile resolution as startup, used to keep two Pix processes from writing one data tree. */
export async function storageLockRoot(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const legacy = resolve(env.PIX_DATA_DIR || join(homedir(), ".pix"));
  const locator = await loadLocator(
    env.PIX_STORAGE_LOCATOR || join(legacy, "storage-location.json"),
  );
  const portable =
    env.PIX_PORTABLE_ROOT && existsSync(join(env.PIX_PORTABLE_ROOT, "pix-portable.json"))
      ? join(env.PIX_PORTABLE_ROOT, "PixData")
      : undefined;
  const chosen = env.PIX_STORAGE_DIR || portable || locator.root;
  if (chosen && !isAbsolute(chosen)) throw new Error("storage_root_must_be_absolute");
  if (locator.root && chosen === locator.root && !existsSync(chosen))
    throw new Error("configured_storage_unavailable");
  const root = resolve(chosen || legacy);
  await mkdir(root, { recursive: true, mode: 0o700 });
  return realpath(root);
}
