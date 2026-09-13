import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PathAccess } from "./path-access.ts";
import { AttachmentStore } from "./attachments.ts";
import {
  macTerminalScript,
  terminalDirectoryCommand,
  windowsEditorExecutable,
} from "./external-launch.ts";
import { switchGitBranch } from "./git-branches.ts";
import { editorArguments, openWorkspaceFile, validateOpenFile } from "./open-file.ts";
import { authorizeSession } from "./session-access.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pix-security-test-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("path grants and clipboard attachments", () => {
  it("checks embedded session cwd and permits only backend-known pending sessions", () => {
    const workspace = join(root, "work");
    const storage = join(root, "sessions");
    mkdirSync(workspace);
    mkdirSync(storage);
    const sessions = new PathAccess();
    sessions.grant(storage);
    const workspaces = new PathAccess();
    workspaces.grant(workspace);
    const path = join(storage, "session.jsonl");
    writeFileSync(path, JSON.stringify({ type: "session", cwd: root }) + "\n");
    expect(() => authorizeSession(path, sessions, workspaces)).toThrow("not authorized");
    writeFileSync(path, JSON.stringify({ type: "session", cwd: workspace }) + "\n");
    expect(authorizeSession(path, sessions, workspaces)).toBe(path);
    const pendingPath = join(storage, "pending.jsonl");
    const pending = new Map([[sessions.grantOutput(pendingPath), workspace]]);
    expect(authorizeSession(pendingPath, sessions, workspaces, pending)).toBe(pendingPath);
    expect(() =>
      authorizeSession(join(storage, "unknown.jsonl"), sessions, workspaces, pending),
    ).toThrow("Unknown pending");
  });
  it("rejects traversal, sibling-prefix paths, and symlinks leaving an authorized root", () => {
    const workspace = join(root, "work");
    const outside = join(root, "work-other");
    mkdirSync(workspace);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.png"), "secret");
    const scope = new PathAccess();
    scope.grant(workspace);
    expect(() => scope.assert("../work-other/secret.png", workspace)).toThrow("not authorized");
    symlinkSync(outside, join(workspace, "link"), "junction");
    expect(() => scope.assert(join(workspace, "link/secret.png"))).toThrow("not authorized");
    scope.grant(join(outside, "secret.png"));
    expect(scope.assert(join(outside, "secret.png"))).toBe(join(outside, "secret.png"));
  });

  it("checks real parents for writes and grants only the selected save destination", () => {
    const workspace = join(root, "work");
    mkdirSync(workspace);
    const scope = new PathAccess();
    scope.grant(workspace);
    expect(scope.assert(join(workspace, "new.jsonl"), undefined, true)).toBe(
      join(workspace, "new.jsonl"),
    );
    const output = join(root, "export.jsonl");
    scope.grantOutput(output);
    expect(scope.assert(output, undefined, true)).toBe(output);
    expect(() => scope.assert(join(root, "another.jsonl"), undefined, true)).toThrow();
    const secret = join(root, "secret");
    writeFileSync(secret, "secret");
    symlinkSync(secret, output);
    expect(() => scope.assert(output, undefined, true)).toThrow("not authorized");
  });

  it("uses private unique directories and refuses extension traversal and malformed bytes", () => {
    const store = new AttachmentStore(root);
    const other = new AttachmentStore(root);
    expect(store.directory).not.toBe(other.directory);
    for (const ext of ["../../../escape", "png/../../escape", "png\\..\\escape", "exe"])
      expect(() => store.save([65], ext)).toThrow("extension");
    expect(() => store.save([256], "png")).toThrow("Invalid");
    expect(() => store.save([], "png")).toThrow("Invalid");
    const one = store.save([1, 2, 3], ".PNG");
    const two = store.save([4], "png");
    expect(one).not.toBe(two);
    expect(readFileSync(one)).toEqual(Buffer.from([1, 2, 3]));
    if (process.platform !== "win32") {
      expect(statSync(store.directory).mode & 0o777).toBe(0o700);
      expect(statSync(one).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(join(root, "escape"))).toBe(false);
  });
});

describe("external launches", () => {
  it.skipIf(process.platform === "win32")(
    "quotes shell metacharacters and spaces as one directory",
    () => {
      const cwd = join(root, "O'Brien;printf injected>marker;# $HOME `pwd` (space)");
      mkdirSync(cwd);
      const output = execFileSync("/bin/sh", ["-c", `${terminalDirectoryCommand(cwd)} && pwd`], {
        cwd: root,
        encoding: "utf8",
      });
      expect(output.trim()).toBe(cwd);
      expect(existsSync(join(root, "marker"))).toBe(false);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "preserves shell quoting through AppleScript string decoding",
    () => {
      const cwd = join(root, "double\" and O'Brien;printf injected>marker;#");
      mkdirSync(cwd);
      for (const app of ["Terminal", "iTerm"] as const) {
        const script = macTerminalScript(app, cwd);
        const literal = script.match(/(?:do script|write text) ("(?:\\.|[^"\\])*")/)![1]!;
        const command = execFileSync("osascript", ["-e", `return ${literal}`], {
          encoding: "utf8",
        }).trim();
        const output = execFileSync("/bin/sh", ["-c", `${command} && pwd`], {
          cwd: root,
          encoding: "utf8",
        });
        expect(output.trim()).toBe(cwd);
        expect(existsSync(join(root, "marker"))).toBe(false);
      }
    },
  );

  it("resolves Windows editor shims to EXEs and rejects unknown shims", () => {
    const expected = "C:\\Program Files\\VS Code\\Code.exe";
    expect(
      windowsEditorExecutable(
        "C:\\Program Files\\VS Code\\bin\\code.cmd",
        (path) => path === expected,
      ),
    ).toBe(expected);
    expect(() => windowsEditorExecutable("C:\\unknown.cmd", () => false)).toThrow("safely");
    const pycharm = "C:\\Program Files\\PyCharm\\bin\\pycharm64.exe";
    expect(
      windowsEditorExecutable(
        "C:\\Program Files\\PyCharm\\bin\\pycharm.bat",
        (path) => path === pycharm,
      ),
    ).toBe(pycharm);
    expect(editorArguments("C:\\work & other\\app.ts", { line: 20, column: 3 })).toEqual([
      "--goto",
      "C:\\work & other\\app.ts:20:3",
    ]);
    expect(() => editorArguments("/file", { line: -1 })).toThrow("location");
  });

  it("refuses executable content and routes ordinary text to an explicit text editor", async () => {
    const binary = join(root, "evil.exe");
    writeFileSync(binary, "MZ");
    expect(() => validateOpenFile(binary)).toThrow("Executable");
    const bundle = join(root, "evil.app");
    mkdirSync(bundle);
    expect(() => validateOpenFile(bundle)).toThrow("Executable");
    const source = join(root, "script.sh");
    writeFileSync(source, "echo hello");
    const native = vi.fn(async () => undefined);
    await openWorkspaceFile(source, undefined, [], native);
    expect(native).toHaveBeenCalledWith("shell.open-text", { path: source });
    await expect(openWorkspaceFile(source, { line: 3 }, [], native)).rejects.toThrow(
      "specific line",
    );
  });
});

describe("branch switching with a real repository", () => {
  function git(...args: string[]) {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
      },
    }).trim();
  }
  const run = async (_cwd: string, args: string[]) => git(...args);
  function setup() {
    git("init", "-b", "main");
    writeFileSync(join(root, "file"), "first");
    git("add", ".");
    git("commit", "-m", "first");
  }
  it("refuses options and filenames without discarding local modifications", async () => {
    setup();
    writeFileSync(join(root, "file"), "uncommitted");
    await expect(switchGitBranch(run, root, "--detach")).rejects.toThrow();
    await expect(switchGitBranch(run, root, "file")).rejects.toThrow("does not exist");
    expect(readFileSync(join(root, "file"), "utf8")).toBe("uncommitted");
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
  });
  it("creates a tracking branch without detaching HEAD", async () => {
    setup();
    git("remote", "add", "origin", "https://example.invalid/repo");
    git("update-ref", "refs/remotes/origin/feature", "HEAD");
    await switchGitBranch(run, root, "origin/feature");
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("feature");
    expect(git("rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature");
  });
  it("does not reset another local branch when a branch is in use by a worktree", async () => {
    setup();
    git("branch", "team/foo");
    writeFileSync(join(root, "file"), "second");
    git("commit", "-am", "second");
    git("branch", "foo");
    const before = git("rev-parse", "foo");
    git("worktree", "add", join(root, "linked"), "team/foo");
    await expect(switchGitBranch(run, root, "team/foo")).rejects.toThrow();
    expect(git("rev-parse", "foo")).toBe(before);
  });
});
