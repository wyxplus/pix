import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Grants originate in native selection or persisted backend state, never IPC path strings. */
export class PathAccess {
  private readonly roots = new Set<string>();
  private readonly files = new Set<string>();
  private readonly outputs = new Set<string>();

  grant(path: string): string {
    const canonical = realpathSync(path);
    (statSync(canonical).isDirectory() ? this.roots : this.files).add(canonical);
    return canonical;
  }

  grantOutput(path: string): string {
    const canonical = this.outputPath(path);
    this.outputs.add(canonical);
    return canonical;
  }

  private outputPath(path: string): string {
    const absolute = resolve(path);
    return existsSync(absolute)
      ? realpathSync(absolute)
      : resolve(realpathSync(dirname(absolute)), relative(dirname(absolute), absolute));
  }

  assert(path: string, base?: string, writing = false): string {
    if (typeof path !== "string" || !path.trim() || path.includes("\0")) {
      throw new Error("Invalid file path");
    }
    const absolute = resolve(base ?? process.cwd(), path);
    const canonical = writing ? this.outputPath(absolute) : realpathSync(absolute);
    if (
      this.files.has(canonical) ||
      (writing && this.outputs.has(canonical)) ||
      [...this.roots].some((root) => isWithin(root, canonical))
    )
      return canonical;
    throw new Error("Path is not authorized. Select it with the file or folder picker first.");
  }

  directory(path: string, base?: string): string {
    const canonical = this.assert(path, base);
    if (!statSync(canonical).isDirectory()) throw new Error("Workspace must be a directory");
    return canonical;
  }
}
