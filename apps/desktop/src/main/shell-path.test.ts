import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  augmentEnvPath,
  candidateCommandPaths,
  commonUserBinDirs,
  mergePathDirs,
  windowsUserBinDirs,
} from "./shell-path.ts";

describe("shell-path", () => {
  it("recovers native Windows tool locations from relocated system and profile directories", () => {
    const dirs = windowsUserBinDirs("E:\\Users\\中文", {
      SystemRoot: "D:\\Windows",
      ProgramFiles: "D:\\Program Files",
      APPDATA: "F:\\Roaming",
      LOCALAPPDATA: "F:\\Local",
    });
    expect(dirs).toContain("D:\\Program Files\\PowerShell\\7");
    expect(dirs).toContain("D:\\Windows\\System32");
    expect(dirs).toContain("D:\\Windows\\System32\\WindowsPowerShell\\v1.0");
    expect(dirs).toContain("F:\\Roaming\\npm");
    expect(dirs).toContain("F:\\Local\\Microsoft\\WinGet\\Links");
    expect(dirs).toContain("D:\\Program Files\\Git\\cmd");
    expect(dirs.some((dir) => /Git\\(?:usr|mingw)/i.test(dir))).toBe(false);
  });

  it("merges conflicting Windows PATH keys and normalizes quoted, trailing-slash duplicates", () => {
    const env = augmentEnvPath(
      {
        PATH: '"D:\\Tools\\";D:\\Node',
        Path: "d:/tools;E:\\Custom",
        path: "F:\\More",
      },
      ["G:\\Bundled"],
      "win32",
    );
    expect(env.PATH?.split(";")[0]).toBe("G:\\Bundled");
    expect(env.PATH).toBe(env.Path);
    expect(env.path).toBeUndefined();
    expect(env.PATH).toContain("D:\\Node");
    expect(env.PATH).toContain("E:\\Custom");
    expect(env.PATH).toContain("F:\\More");
    expect(env.PATH?.split(";").filter((dir) => /tools/i.test(dir))).toEqual(["D:\\Tools\\"]);
  });

  it("defaults Windows Python pipes to UTF-8 while honoring explicit encodings", () => {
    expect(augmentEnvPath({}, [], "win32")).toMatchObject({
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
    });
    expect(
      augmentEnvPath({ PYTHONUTF8: "0", PYTHONIOENCODING: "gb18030" }, [], "win32"),
    ).toMatchObject({ PYTHONUTF8: "0", PYTHONIOENCODING: "gb18030" });
    expect(augmentEnvPath({}, [], "darwin").PYTHONUTF8).toBeUndefined();
  });

  it.runIf(process.platform === "win32")("finds system PowerShell with an empty GUI PATH", () => {
    const env = augmentEnvPath({
      USERPROFILE: process.env.USERPROFILE,
      SystemRoot: process.env.SystemRoot,
      PATH: "",
    });
    expect(
      candidateCommandPaths("powershell.exe", env).some((file) => /WindowsPowerShell/i.test(file)),
    ).toBe(true);
    expect(candidateCommandPaths("where.exe", env).length).toBeGreaterThan(0);
  });

  it("mergePathDirs prepends extras and dedupes", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    const merged = mergePathDirs(`/usr/bin${sep}/bin`, ["/opt/homebrew/bin", "/usr/bin"]);
    const parts = merged.split(sep);
    expect(parts[0]).toBe("/opt/homebrew/bin");
    expect(parts.filter((p) => p === "/usr/bin")).toHaveLength(1);
  });

  it("augmentEnvPath keeps existing PATH entries and sets PATH", () => {
    const env = augmentEnvPath({
      HOME: process.env.HOME || process.env.USERPROFILE || tmpdir(),
      PATH: "/usr/bin:/bin",
    });
    expect(env.PATH).toBeTruthy();
    expect(env.PATH).toContain("/usr/bin");
    expect(env.PATH).toContain("/bin");
  });

  it("augmentEnvPath prepends extraBinDirs (bundled runtimes) before user bins", () => {
    const sep = process.platform === "win32" ? ";" : ":";
    const bundled = join(tmpdir(), "pix-bundled-bin-xyz");
    mkdirSync(bundled, { recursive: true });
    const env = augmentEnvPath(
      {
        HOME: process.env.HOME || process.env.USERPROFILE || tmpdir(),
        PATH: `/usr/bin${sep}/bin`,
      },
      [bundled],
    );
    const parts = (env.PATH || "").split(sep);
    expect(parts[0]).toBe(bundled);
    expect(env.PATH).toContain("/usr/bin");
  });

  it("candidateCommandPaths finds binaries under a home bin dir", () => {
    const root = mkdtempSync(join(tmpdir(), "pix-shell-path-"));
    const bin =
      process.platform === "win32"
        ? join(root, "AppData", "Roaming", "npm")
        : join(root, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const piPath = join(bin, "pi");
    writeFileSync(piPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });

    const found = candidateCommandPaths("pi", {
      HOME: root,
      PATH: bin,
    });
    expect(found).toContain(piPath);
  });

  it("commonUserBinDirs only returns existing directories", () => {
    const dirs = commonUserBinDirs(join(tmpdir(), "pix-missing-home-dir-xyz"));
    for (const dir of dirs) {
      // System paths like /usr/local/bin may exist; user-home ones for missing home must not.
      expect(dir.includes("pix-missing-home-dir-xyz")).toBe(false);
    }
  });
});
