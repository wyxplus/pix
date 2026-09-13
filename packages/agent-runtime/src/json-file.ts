import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObject(raw: string, name: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    // JSON.parse errors can include credential text. Never project it to the UI.
    throw new Error(`${name} is not valid JSON; the original file has been kept`);
  }
  if (!isRecord(value))
    throw new Error(`${name} root must be an object; the original file has been kept`);
  return value;
}

/** Read/modify/write under the same path lock used by pi AuthStorage. */
export async function updateJsonFile(
  file: string,
  initial: () => Record<string, unknown>,
  update: (root: Record<string, unknown>, exists: boolean) => boolean,
): Promise<boolean> {
  const path = resolve(file);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: 30_000,
    retries: { retries: 30, factor: 1.4, minTimeout: 10, maxTimeout: 1_000 },
    onCompromised: (error) => {
      compromised = error;
    },
  });
  let temporary: string | undefined;
  try {
    let root: Record<string, unknown>;
    let exists = true;
    try {
      root = parseJsonObject(await readFile(path, "utf8"), basename(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
      root = initial();
    }
    if (compromised) throw compromised;
    if (!update(root, exists)) return false;
    // Preserve a configured symlink and existing file mode. Replace only after
    // the complete document has reached disk, leaving the original on failure.
    const destination = exists ? await realpath(path) : path;
    const mode = exists ? (await stat(path)).mode & 0o777 : 0o600;
    temporary = `${destination}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(`${JSON.stringify(root, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (compromised) throw compromised;
    await rename(temporary, destination);
    temporary = undefined;
    return true;
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
    await release();
  }
}
