import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
export async function validationSource(root) {
  const inputs = [
    "apps/desktop/src",
    "apps/desktop/src-tauri/src",
    "packages/agent-runtime/src",
    "packages/contracts/src",
    "apps/desktop/package.json",
    "apps/desktop/src-tauri/tauri.conf.json",
    "apps/desktop/src-tauri/Cargo.toml",
    "apps/desktop/src-tauri/Cargo.lock",
    "pnpm-lock.yaml",
  ];
  const files = [];
  async function walk(path) {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOTDIR") {
        files.push(path);
        return;
      }
      throw e;
    }
    for (const entry of entries) {
      if (["node_modules", ".git", ".vite", ".cache"].includes(entry.name)) continue;
      if (entry.isDirectory()) await walk(join(path, entry.name));
      else if (entry.isFile() && !/\.(test|spec)\./.test(entry.name))
        files.push(join(path, entry.name));
    }
  }
  for (const input of inputs) await walk(join(root, input));
  const hash = createHash("sha256");
  const ordered = files.map((file) => ({ file, name: relative(root, file).replaceAll("\\", "/") }));
  for (const { file, name } of ordered.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    hash.update(name);
    hash.update("\0");
    let text = (await readFile(file, "utf8")).replaceAll("\r\n", "\n");
    if (file.endsWith("package.json")) {
      const { scripts: _scripts, ...production } = JSON.parse(text);
      text = JSON.stringify(production);
    }
    hash.update(text);
    hash.update("\0");
  }
  return hash.digest("hex");
}
