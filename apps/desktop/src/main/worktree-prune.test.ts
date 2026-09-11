import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";
import { pruneManagedWorktreesSafely, removeWorktreeSafely } from "./worktree-prune.ts";
import { normalizeHostCwdKey } from "./host-park-policy.ts";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", args, { cwd, windowsHide: true })).stdout;
}

describe("safe managed worktree cleanup", () => {
  it("protects user data, locked/detached worktrees and running workspaces while deleting clean idle ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pix-prune-"));
    const repo = join(dir, "main");
    const root = join(dir, "managed");
    await mkdir(repo);
    try {
      await git(repo, "init");
      await writeFile(join(repo, "tracked.txt"), "committed\n");
      await writeFile(join(repo, ".gitignore"), "*.csv\n");
      await git(repo, "add", ".");
      await git(
        repo,
        "-c",
        "user.name=Pix Test",
        "-c",
        "user.email=pix@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "fixture",
      );
      const paths: Record<string, string> = {};
      for (const name of [
        "tracked",
        "untracked",
        "ignored",
        "locked",
        "active",
        "newest",
        "detached",
        "clean 数据",
      ]) {
        const path = join(root, name);
        await git(repo, "worktree", "add", "-b", `branch-${Object.keys(paths).length}`, path);
        paths[name] = path;
      }
      await writeFile(join(paths.tracked!, "tracked.txt"), "uncommitted research\n");
      await writeFile(join(paths.untracked!, "notes.txt"), "analysis\n");
      await writeFile(join(paths.ignored!, "results.csv"), "cost,100\n");
      await git(repo, "worktree", "lock", paths.locked!);
      await git(paths.detached!, "checkout", "--detach");
      // Even the oldest directory is protected when it was just created for the caller.
      await utimes(paths.newest!, new Date(0), new Date(0));
      const protectedPaths = () => [join(paths.active!, "subfolder"), paths.newest!];
      for (const name of ["tracked", "untracked", "ignored", "locked", "active", "detached"]) {
        await expect(
          removeWorktreeSafely({ repoCwd: repo, path: paths[name]!, protectedPaths }),
          `manual deletion must refuse ${name}`,
        ).rejects.toThrow();
      }
      const removed = await pruneManagedWorktreesSafely({
        repoCwd: repo,
        root,
        limit: 1,
        protectedPaths,
      });
      expect(removed.map((path) => normalizeHostCwdKey(path))).toEqual([
        normalizeHostCwdKey(paths["clean 数据"]!),
      ]);
      for (const [name, path] of Object.entries(paths)) {
        if (name === "clean 数据") await expect(access(path)).rejects.toThrow();
        else await expect(access(path)).resolves.toBeUndefined();
      }
      expect(await readFile(join(paths.tracked!, "tracked.txt"), "utf8")).toBe(
        "uncommitted research\n",
      );
      expect(await readFile(join(paths.ignored!, "results.csv"), "utf8")).toBe("cost,100\n");
      expect(
        await pruneManagedWorktreesSafely({ repoCwd: repo, root, limit: 1, protectedPaths }),
      ).toEqual([]);
      await expect(access(join(repo, ".git"))).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
