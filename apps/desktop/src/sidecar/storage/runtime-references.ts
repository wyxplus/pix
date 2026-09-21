import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Repair launch metadata after a verified same-platform copy, preserving installed packages. */
export async function relocateManagedRuntimes(
  oldDesktop: string,
  newDesktop: string,
): Promise<number> {
  const oldRoot = join(oldDesktop, "runtimes"),
    newRoot = join(newDesktop, "runtimes");
  const replacements = [...new Set([oldRoot, oldRoot.replaceAll("\\", "/")])].map((old) => [
    old,
    old.includes("\\") ? newRoot : newRoot.replaceAll("\\", "/"),
  ]);
  const remap = (text: string) =>
    replacements.reduce((value, [old, next]) => value.replaceAll(old!, next!), text);
  let changed = 0;
  async function visit(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    for (const entry of entries) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__pycache__") await visit(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const launchDirectory = /[\\/](?:bin|Scripts)(?:[\\/]|$)/.test(file);
      if (!launchDirectory && !["pyvenv.cfg"].includes(entry.name) && !entry.name.endsWith(".pth"))
        continue;
      const bytes = await readFile(file);
      if (!replacements.some(([old]) => bytes.includes(Buffer.from(old!)))) continue;
      let next: Buffer;
      if (bytes.subarray(0, 2).toString() === "MZ") {
        // distlib Windows launchers append a shebang and ZIP overlay to an unchanged PE stub.
        const zip = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
        const bang = zip >= 0 ? bytes.lastIndexOf(Buffer.from("#!"), zip) : -1;
        if (bang < 0 || zip - bang > 8192)
          throw new Error(`runtime_launcher_requires_manual_migration: ${file}`);
        const line = bytes.subarray(bang, zip).toString("utf8");
        if (!/^#![^\r\n]+\r?\n$/.test(line))
          throw new Error(`runtime_launcher_requires_manual_migration: ${file}`);
        next = Buffer.concat([
          bytes.subarray(0, bang),
          Buffer.from(remap(line)),
          bytes.subarray(zip),
        ]);
      } else {
        if (bytes.includes(0)) throw new Error(`runtime_binary_requires_manual_migration: ${file}`);
        next = Buffer.from(remap(bytes.toString("utf8")));
      }
      await writeFile(file, next, { flush: true });
      changed++;
    }
  }
  await visit(join(newRoot, "python-venv"));
  await visit(join(newRoot, "npm-prefix", "bin"));
  return changed;
}
