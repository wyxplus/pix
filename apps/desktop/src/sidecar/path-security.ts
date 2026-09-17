import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { PathAccess } from "../main/path-access.ts";
import { AttachmentStore } from "../main/attachments.ts";
import { nativeRequest } from "./transport.ts";

export const workspaceAccess = new PathAccess();
export const selectedAccess = new PathAccess();
export const sessionAccess = new PathAccess();
export const pendingSessionCwds = new Map<string, string>();
export const exportAccess = new PathAccess();
export const attachments = new AttachmentStore();
selectedAccess.grant(attachments.directory);

export function rememberSession(path: string, cwd: string): void {
  if (existsSync(path)) sessionAccess.grant(path);
  pendingSessionCwds.set(sessionAccess.grantOutput(path), cwd);
}

export function grantSelected(path: string): void {
  selectedAccess.grant(path);
  if (statSync(path).isDirectory()) workspaceAccess.grant(path);
  else sessionAccess.grant(path);
}

async function grantNativeDrop(path: string): Promise<void> {
  // Rust checks paths captured from the actual OS drop event, not renderer event data.
  if (await nativeRequest<boolean>("paths.was-dropped", { path })) grantSelected(path);
}

export async function authorizeWorkspace(path: string): Promise<string> {
  path = resolve(path);
  try {
    return workspaceAccess.directory(path);
  } catch {
    await grantNativeDrop(path);
    return workspaceAccess.directory(path);
  }
}

export async function authorizeFile(path: string, cwd?: string): Promise<string> {
  path = resolve(cwd ?? process.cwd(), path);
  const current = new PathAccess();
  if (cwd && existsSync(cwd)) current.grant(cwd);
  try {
    return current.assert(path, cwd);
  } catch {
    /* try explicit selection */
  }
  try {
    return selectedAccess.assert(path, cwd);
  } catch {
    await grantNativeDrop(path);
    return selectedAccess.assert(path, cwd);
  }
}

/** Preserve project-root reveal actions and also accept individually selected files. */
export async function authorizeReveal(path: string, cwd?: string): Promise<string> {
  try {
    return workspaceAccess.assert(path, cwd);
  } catch {
    return authorizeFile(path, cwd);
  }
}

export async function preparePromptImages(
  paths: string[] | undefined,
  cwd?: string,
): Promise<string[] | undefined> {
  if (paths === undefined) return undefined;
  if (!Array.isArray(paths) || paths.length > 12) throw new Error("Invalid image attachments");
  return Promise.all(paths.map(async (path) => attachments.copy(await authorizeFile(path, cwd))));
}
