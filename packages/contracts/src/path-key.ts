export type PathPlatform = "win32" | "darwin" | "linux";

function currentPlatform(): PathPlatform {
  const node = (globalThis as { process?: { platform?: string; versions?: { node?: string } } })
    .process;
  if (node?.versions?.node) {
    return node.platform === "win32" ? "win32" : node.platform === "darwin" ? "darwin" : "linux";
  }
  const platform = typeof navigator !== "undefined" ? navigator.platform : "";
  return /Win/i.test(platform) ? "win32" : /Mac/i.test(platform) ? "darwin" : "linux";
}

/** A shared equality key for workspaces, sessions, terminal ownership and prefs. */
export function normalizePathKey(
  raw: string | undefined | null,
  platform: PathPlatform = currentPlatform(),
): string {
  if (!raw) return "";
  let path = raw.trim();
  // Recognize absolute Windows paths in imported snapshots and cross-platform tests.
  const windowsPath = platform === "win32" || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
  if (windowsPath) path = path.replace(/\\/g, "/").toLowerCase();
  path = path.replace(/\/+$/, "") || (path.startsWith("/") ? "/" : "");
  // Only these macOS system directories have the /private alias. Other /private
  // paths and case-distinct POSIX paths must remain distinct.
  if (platform === "darwin" && /^\/private\/(?:var|tmp|etc)(?:\/|$)/.test(path))
    path = path.slice(8);
  return path;
}
