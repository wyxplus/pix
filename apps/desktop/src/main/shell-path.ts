/**
 * A GUI-launched desktop app can inherit a minimal PATH.
 * Dev launches from a shell keep full PATH — that is why packaged Pix fails to
 * find `pi` / `node` / `npm` and falls into slow npm install / tool re-download.
 *
 * Pure, sync helpers: scan well-known user bin dirs and prepend them.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, win32 } from "node:path";

function windowsEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** Known native Windows tool locations; do not prepend Git's Unix utility directory. */
export function windowsUserBinDirs(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const systemRoot = windowsEnvValue(env, "SystemRoot") || "C:\\Windows";
  const programFiles =
    windowsEnvValue(env, "ProgramW6432") ||
    windowsEnvValue(env, "ProgramFiles") ||
    "C:\\Program Files";
  const programFilesX86 = windowsEnvValue(env, "ProgramFiles(x86)") || "C:\\Program Files (x86)";
  const localAppData = windowsEnvValue(env, "LOCALAPPDATA") || win32.join(home, "AppData", "Local");
  const appData = windowsEnvValue(env, "APPDATA") || win32.join(home, "AppData", "Roaming");
  return [
    win32.join(programFiles, "PowerShell", "7"),
    win32.join(localAppData, "Microsoft", "PowerShell", "7"),
    win32.join(systemRoot, "System32"),
    win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    win32.join(appData, "npm"),
    win32.join(localAppData, "Microsoft", "WinGet", "Links"),
    win32.join(localAppData, "Microsoft", "WindowsApps"),
    win32.join(home, "scoop", "shims"),
    win32.join(localAppData, "Programs", "cursor", "resources", "app", "bin"),
    win32.join(programFiles, "nodejs"),
    win32.join(programFilesX86, "nodejs"),
    win32.join(programFiles, "Git", "cmd"),
    win32.join(localAppData, "Programs", "Git", "cmd"),
  ];
}

function pathValue(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return env.PATH || env.Path || "";
  // Plain env objects can contain conflicting PATH/Path keys. Keep both sets of
  // entries before normalizing, rather than losing one at Node's spawn boundary.
  return Object.entries(env)
    .filter(([key]) => key.toLowerCase() === "path")
    .map(([, value]) => value || "")
    .filter(Boolean)
    .join(";");
}

/** Directories that commonly hold node / npm / pi when launched outside a login shell. */
export function commonUserBinDirs(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (process.platform === "win32") {
    return uniqueExistingDirs(windowsUserBinDirs(home, env));
  }

  const dirs: string[] = [
    // Real Node from vite-plus runtimes (prefer over ~/.vite-plus/bin wrappers).
    ...vitePlusRuntimeBinDirs(home),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    join(home, ".vite-plus", "bin"),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".volta", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "fnm", "aliases", "default", "bin"),
    join(home, ".nvm", "current", "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".pi", "agent", "bin"),
  ];

  // nvm: ~/.nvm/versions/node/<ver>/bin — pick newest existing without spawning nvm.
  const nvmVersions = join(home, ".nvm", "versions", "node");
  if (existsSync(nvmVersions)) {
    try {
      const versions = readdirSync(nvmVersions)
        .filter((name) => !name.startsWith("."))
        .sort()
        .reverse();
      for (const ver of versions) {
        const bin = join(nvmVersions, ver, "bin");
        if (existsSync(bin)) dirs.push(bin);
      }
    } catch {
      // ignore
    }
  }

  return uniqueExistingDirs(dirs);
}

function vitePlusRuntimeBinDirs(home: string): string[] {
  const root = join(home, ".vite-plus", "js_runtime", "node");
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((name) => !name.startsWith("."))
      .sort()
      .reverse()
      .map((ver) => join(root, ver, "bin"))
      .filter((bin) => existsSync(bin));
  } catch {
    return [];
  }
}

function uniqueExistingDirs(dirs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

/** Prepend extra dirs to a PATH string (deduped, extras first). */
export function mergePathDirs(
  existing: string | undefined,
  extraDirs: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  const sep = platform === "win32" ? ";" : ":";
  const parts = [...extraDirs, ...(existing ?? "").split(sep).filter(Boolean)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const part = platform === "win32" ? raw.trim().replace(/^"(.*)"$/, "$1") : raw;
    if (!part) continue;
    const normalized = platform === "win32" ? win32.normalize(part) : part;
    const key =
      platform === "win32"
        ? (normalized.length > win32.parse(normalized).root.length
            ? normalized.replace(/\\+$/, "")
            : normalized
          ).toLowerCase()
        : part;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join(sep);
}

/**
 * Return a copy of env with PATH (and Windows Path) augmented.
 * `extraBinDirs` are prepended first (e.g. bundled Node/Python).
 */
export function augmentEnvPath(
  env: NodeJS.ProcessEnv = process.env,
  extraBinDirs: string[] = [],
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const home =
    platform === "win32" ? env.USERPROFILE || env.HOME || homedir() : env.HOME || homedir();
  const existing = pathValue(env, platform);
  const commonDirs =
    platform === "win32"
      ? windowsUserBinDirs(home, env).filter((dir) => existsSync(dir))
      : commonUserBinDirs(home, env);
  // Bundled runtimes first, then well-known user bins, then existing PATH.
  const merged = mergePathDirs(existing, [...extraBinDirs, ...commonDirs], platform);
  const next: NodeJS.ProcessEnv = { ...env, PATH: merged };
  if (platform === "win32") {
    for (const key of Object.keys(next)) {
      if (key.toLowerCase() === "path" && key !== "PATH") delete next[key];
    }
    next.Path = merged;
    // Python's redirected stdio otherwise follows the legacy Windows codepage.
    next.PYTHONUTF8 = windowsEnvValue(env, "PYTHONUTF8") ?? "1";
    next.PYTHONIOENCODING = windowsEnvValue(env, "PYTHONIOENCODING") ?? "utf-8";
  }
  if (!next.HOME && home) next.HOME = home;
  if (platform === "win32" && !next.USERPROFILE) next.USERPROFILE = home;
  return next;
}

/**
 * Mutate process.env.PATH so main, utilityProcess, and child spawns see user tools.
 * Safe to call multiple times (idempotent merge).
 * @param extraBinDirs optional dirs prepended (bundled Node/Python bins)
 */
export function applyProcessPathAugmentation(extraBinDirs: string[] = []): void {
  const next = augmentEnvPath(process.env, extraBinDirs);
  if (next.PATH) process.env.PATH = next.PATH;
  if (process.platform === "win32" && next.Path) process.env.Path = next.Path;
  if (process.platform === "win32") {
    process.env.PYTHONUTF8 = next.PYTHONUTF8;
    process.env.PYTHONIOENCODING = next.PYTHONIOENCODING;
  }
  if (next.HOME && !process.env.HOME) process.env.HOME = next.HOME;
  if (process.platform === "win32" && next.USERPROFILE && !process.env.USERPROFILE) {
    process.env.USERPROFILE = next.USERPROFILE;
  }
}

/** Absolute candidate paths for a command name under common bin dirs (+ optional env PATH). */
export function candidateCommandPaths(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = env.HOME || env.USERPROFILE || homedir();
  const dirs = commonUserBinDirs(home, env);
  const pathDirs = mergePathDirs(pathValue(env), []).split(delimiter).filter(Boolean);
  const allDirs = uniqueExistingDirs([...dirs, ...pathDirs]);
  const names =
    process.platform === "win32"
      ? /\.(?:cmd|exe|bat|ps1)$/i.test(command)
        ? [command]
        : [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
      : [command];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of allDirs) {
    for (const name of names) {
      const full = join(dir, name);
      const key = process.platform === "win32" ? full.toLowerCase() : full;
      if (seen.has(key) || !existsSync(full)) continue;
      seen.add(key);
      out.push(full);
    }
  }
  return out;
}
