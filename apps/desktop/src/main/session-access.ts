import { closeSync, existsSync, openSync, readSync } from "node:fs";
import type { PathAccess } from "./path-access.ts";

/** Read only the session header before allowing the SDK to start in its embedded cwd. */
export function sessionWorkspace(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const size = readSync(descriptor, buffer, 0, buffer.length, 0);
    const first = buffer
      .subarray(0, size)
      .toString("utf8")
      .replace(/^\uFEFF/, "")
      .split("\n", 1)[0]!;
    const header = JSON.parse(first) as { type?: unknown; cwd?: unknown };
    if (header.type !== "session" || typeof header.cwd !== "string" || !header.cwd.trim())
      throw new Error("Invalid session header");
    return header.cwd;
  } finally {
    closeSync(descriptor);
  }
}

export function authorizeSession(
  path: string,
  sessions: PathAccess,
  workspaces: PathAccess,
  pending: ReadonlyMap<string, string> = new Map(),
): string {
  if (!existsSync(path)) {
    const canonical = sessions.assert(path, undefined, true);
    const cwd = pending.get(canonical);
    if (!cwd) throw new Error("Unknown pending session");
    workspaces.directory(cwd);
    return canonical;
  }
  let canonical: string;
  try {
    canonical = sessions.assert(path);
  } catch {
    canonical = workspaces.assert(path);
  }
  workspaces.directory(sessionWorkspace(canonical));
  return canonical;
}
