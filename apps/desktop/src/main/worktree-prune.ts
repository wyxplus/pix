import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { normalizeHostCwdKey } from "./host-park-policy.ts";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  return (
    await exec("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
  ).stdout;
}

function isProtected(path: string, protectedPaths: readonly string[]): boolean {
  const candidate = normalizeHostCwdKey(resolve(path));
  return protectedPaths.some((active) => {
    const activeKey = normalizeHostCwdKey(resolve(active));
    return activeKey === candidate || activeKey.startsWith(`${candidate}/`);
  });
}

/** Shared by automatic cleanup and the Settings delete action. Never force. */
export async function removeWorktreeSafely(options: {
  repoCwd: string;
  path: string;
  protectedPaths: () => readonly string[];
}): Promise<void> {
  const checkActive = () => {
    if (isProtected(options.path, options.protectedPaths()))
      throw new Error("工作树仍被会话或终端使用，请先关闭相关任务。");
  };
  checkActive();
  const status = await git(options.path, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored",
  ]);
  if (status) throw new Error("工作树包含未提交、未跟踪或忽略的文件，请先保存或移走这些文件。");
  // A detached tip may be the only reference to committed work.
  await git(options.path, ["symbolic-ref", "--quiet", "HEAD"]);
  checkActive();
  await git(options.repoCwd, ["worktree", "remove", "--", options.path]);
}

/** The limit is soft: never sacrifice user files or a live runtime to meet it. */
export async function pruneManagedWorktreesSafely(options: {
  repoCwd: string;
  root: string;
  limit: number;
  protectedPaths: () => readonly string[];
}): Promise<string[]> {
  const key = (path: string) => normalizeHostCwdKey(resolve(path));
  const rootKey = key(options.root);
  // -z preserves spaces, quotes, newlines and non-ASCII paths without Git quoting.
  const listing = await git(options.repoCwd, ["worktree", "list", "--porcelain", "-z"]);
  const managed = listing
    .split("\0\0")
    .map((block, index) => {
      const fields = block.split("\0");
      const path = fields.find((line) => line.startsWith("worktree "))?.slice(9);
      return {
        path,
        main: index === 0,
        locked: fields.some((line) => line === "locked" || line.startsWith("locked ")),
        bare: fields.includes("bare"),
        detached: fields.includes("detached"),
      };
    })
    .filter(
      (item) => item.path && !item.main && !item.bare && key(item.path).startsWith(`${rootKey}/`),
    );
  let remaining = managed.length;
  const ranked = await Promise.all(
    managed.map(async (item) => {
      const info = await lstat(item.path!).catch(() => undefined);
      return {
        ...item,
        path: item.path!,
        mtime: info?.mtimeMs ?? Infinity,
        directory: info?.isDirectory() === true,
      };
    }),
  );
  ranked.sort((a, b) => a.mtime - b.mtime);
  const protectedPaths = () => [options.repoCwd, ...options.protectedPaths()];
  const removed: string[] = [];
  for (const item of ranked) {
    if (remaining <= options.limit) break;
    if (!item.directory || item.locked || item.detached || isProtected(item.path, protectedPaths()))
      continue;
    try {
      // Git permits deleting ignored files even without --force. Count those as
      // user data too (analysis output, environments, build artifacts, etc.).
      await removeWorktreeSafely({ repoCwd: options.repoCwd, path: item.path, protectedPaths });
      removed.push(item.path);
      remaining -= 1;
    } catch {
      // A lock, new changes or a Git error makes this candidate ineligible.
    }
  }
  return removed;
}
