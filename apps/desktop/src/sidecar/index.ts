import {
  IPC_PROTOCOL_VERSION,
  type ExtensionUiResponse,
  type CatalogPackage,
  type DetectedApp,
  type GitBranchInfo,
  type GitChangeItem,
  type GitContextInfo,
  type GitStatusSummary,
  type GitWorktreeInfo,
  type HostCommand,
  type HostEvent,
  type HostSnapshot,
  type ModelSummary,
  type ModelsJsonConfigView,
  type PhotonProbeResult,
  type PackageSummary,
  type PackageUpdateInfo,
  type PiSettingsPatch,
  type PiSettingsPatchResult,
  type PiSettingsView,
  type ProjectTrustSummary,
  type ProviderAuthSummary,
  type ProviderUsageSnapshot,
  type ResourceSummary,
  type ScopedModelView,
  type SessionBashResult,
  type SessionExportResult,
  type SessionHistoryMessage,
  type SessionInfoView,
  type SessionShareResult,
  type SessionThreadSummary,
  type SessionTreeView,
  type UpsertCustomProviderInput,
  isHostEvent,
} from "@pix/contracts";
import { app, dialog, shell } from "./native.ts";
import { nativeImage, type NativeImage } from "./image.ts";
import { rpc, renderer, nativeRequest, markReady, type RendererConnection } from "./transport.ts";
import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import { forkAgent } from "./agent-process.ts";
import type { ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  lstatSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  findParkedSessionKeyByCwd,
  idleParkedCount,
  MAX_PARKED_HOSTS,
  normalizeHostCwdKey,
  PARKED_IDLE_TTL_MS,
  pickParkedEvictionKey,
  shouldForwardParkedRuntimeEvent,
  shouldParkForeground,
} from "../main/host-park-policy.ts";
import { formatHostExitError, resolveAgentHostEntry } from "../main/host-spawn.ts";
import { ensurePiCli, type PiCliProgressEvent } from "../main/pi-cli-ensure.ts";
import {
  buildPiSdkActivity,
  buildPiSdkStatus,
  defaultAgentDir,
  fetchLatestPiSdkVersion,
  formatPiSdkBusyError,
  listPiConfigFiles,
  normalizePiSdkPrefs,
  normalizePiSdkSource,
  piSdkSpawnEnv,
  resolveActiveCliPath,
  resolveBuiltinSdk,
  resolveGlobalSdk,
  type PiSdkPrefs,
  type ResolvedPiSdk,
} from "../main/pi-sdk.ts";
import { createNodePtySpawn, PiTuiPtyController } from "../main/pi-tui-pty.ts";
import { PiTuiExclusiveGuard, planPiTuiLaunch } from "../main/pi-tui-session.ts";
import {
  applyProxyChannelToEnv,
  normalizeProxyPrefs,
  withNodeEnvProxyFlag,
  type ProxyChannelPrefs,
  type ProxyPrefs,
} from "../main/proxy-prefs.ts";
import { discoverLocalProxies } from "../main/proxy-discover.ts";
import {
  applyManagedRuntimeToProcessEnv,
  captureManagedPathBase,
  configureBundledRuntimes,
  getActiveBundledRuntimeStatus,
  normalizeBundledRuntimePrefs,
  type BundledRuntimePrefs,
} from "../main/bundled-runtimes.ts";
import { ensureProvisionedRuntimes } from "../main/runtime-provision.ts";
import { augmentEnvPath } from "../main/shell-path.ts";
import { ThemeLibrary } from "../main/theme-library.ts";

/**
 * WorkBuddy-style managed runtimes:
 * archives in Resources → extract to userData → PATH + npm prefix + python venv.
 * Default ON. Safe before app.ready (userData/resourcesPath available in Electron main).
 */
function bootstrapBundledRuntimesAndPath(): void {
  // Snapshot host PATH before any managed prepend so toggles can rebuild cleanly.
  captureManagedPathBase(process.env);

  let prefs = normalizeBundledRuntimePrefs(undefined);
  try {
    prefs = normalizeBundledRuntimePrefs(loadDesktopPrefs().bundledRuntimes);
  } catch {
    // Prefs may be unavailable in unit-test hosts; keep defaults.
  }

  let userDataPath: string | undefined;
  try {
    userDataPath = app.getPath("userData");
  } catch {
    userDataPath = undefined;
  }

  const provisionOpts: {
    userDataPath: string;
    resourcesPath?: string;
    mainModuleUrl?: string;
  } = {
    userDataPath: userDataPath || join(homedir(), ".pix-runtimes-fallback"),
    mainModuleUrl: import.meta.url,
  };
  if (typeof process.env.PIX_RESOURCES_DIR === "string" && process.env.PIX_RESOURCES_DIR) {
    provisionOpts.resourcesPath = process.env.PIX_RESOURCES_DIR;
  }

  let roots;
  let isolation: { npmPrefix?: string; pythonVenv?: string; source?: string } | undefined;

  try {
    const provisioned = ensureProvisionedRuntimes(provisionOpts);
    if (provisioned) {
      roots = provisioned.roots;
      isolation = {
        npmPrefix: provisioned.npmPrefix,
        pythonVenv: provisioned.pythonVenv,
        source: provisioned.source,
      };
    }
  } catch (error) {
    console.warn("[pix] runtime provision failed:", error);
  }

  configureBundledRuntimes({
    roots,
    prefs,
    ...(isolation ? { isolation } : {}),
  });
  // PATH + NODE_BINARY + isolation env, gated by prefs (OFF → clean host).
  applyManagedRuntimeToProcessEnv(process.env);
}

// Prefs helpers below are function declarations (hoisted). Configure bundled
// runtimes + PATH before LAUNCH_ENV snapshots / child spawns.
bootstrapBundledRuntimesAndPath();

/** Embedded pi TUI (terminal mode) — exclusive with host chat prompts. */
const piTuiGuard = new PiTuiExclusiveGuard();
let piTuiController: PiTuiPtyController | undefined;
let piTuiControllerInit: Promise<PiTuiPtyController> | undefined;
/** Source last applied to a spawned Agent Host (Settings needsRestart). */
let appliedPiSdkSource: "builtin" | "global" = "builtin";
let cachedBuiltinSdk: ResolvedPiSdk | undefined;
let cachedGlobalSdk: ResolvedPiSdk | undefined;

function resolveBuiltinSdkCached(): ResolvedPiSdk {
  if (cachedBuiltinSdk) return cachedBuiltinSdk;
  const opts: {
    mainModuleUrl?: string;
    appPath?: string;
    resourcesPath?: string;
    extractedRoot?: string;
  } = { mainModuleUrl: import.meta.url };
  try {
    if (app.isReady()) opts.appPath = app.getAppPath();
  } catch {
    // app may not be ready
  }
  if (typeof process.env.PIX_RESOURCES_DIR === "string" && process.env.PIX_RESOURCES_DIR) {
    opts.resourcesPath = process.env.PIX_RESOURCES_DIR;
  }
  cachedBuiltinSdk = resolveBuiltinSdk(opts);
  return cachedBuiltinSdk;
}

async function resolveGlobalSdkCached(force = false): Promise<ResolvedPiSdk> {
  if (!force && cachedGlobalSdk) return cachedGlobalSdk;
  cachedGlobalSdk = await resolveGlobalSdk();
  return cachedGlobalSdk;
}

function getPiSdkPrefs(): PiSdkPrefs {
  return normalizePiSdkPrefs(loadDesktopPrefs().piSdk);
}

function setPiSdkPrefs(next: PiSdkPrefs): PiSdkPrefs {
  const normalized = normalizePiSdkPrefs(next);
  const prefs = loadDesktopPrefs();
  saveDesktopPrefs({ ...prefs, piSdk: normalized });
  return normalized;
}

function collectPiSdkActivity(): import("@pix/contracts").PiSdkActivity {
  const host = supervisor?.getSdkSwitchActivity() ?? {
    agentBusy: false,
    parkedBusyCount: 0,
  };
  let terminalLive = false;
  try {
    const tui = piTuiController?.status();
    terminalLive = Boolean(tui?.live && !tui.live.suspended);
  } catch {
    terminalLive = false;
  }
  return buildPiSdkActivity({
    agentBusy: host.agentBusy,
    parkedBusyCount: host.parkedBusyCount,
    terminalLive,
  });
}

async function collectPiSdkStatus(options?: {
  forceLatest?: boolean;
}): Promise<import("@pix/contracts").PiSdkStatus> {
  const preference = getPiSdkPrefs();
  const builtin = resolveBuiltinSdkCached();
  const global = await resolveGlobalSdkCached(true);
  let agentDir = defaultAgentDir();
  try {
    const snap = await supervisor?.snapshot();
    if (snap?.agentDir) agentDir = snap.agentDir;
  } catch {
    // host may be down
  }
  const latest = await fetchLatestPiSdkVersion({ force: options?.forceLatest === true });
  return buildPiSdkStatus({
    preference,
    appliedSource: appliedPiSdkSource,
    builtin,
    global,
    agentDir,
    activity: collectPiSdkActivity(),
    ...(latest.version ? { latestVersion: latest.version } : {}),
    latestCheckedAt: latest.checkedAt,
    ...(latest.error ? { latestError: latest.error } : {}),
  });
}

async function getPiTuiController(): Promise<PiTuiPtyController> {
  if (piTuiController) return piTuiController;
  if (!piTuiControllerInit) {
    piTuiControllerInit = (async () => {
      const spawn = await createNodePtySpawn();
      const controller = new PiTuiPtyController(spawn, async () => {
        const preference = getPiSdkPrefs();
        const builtin = resolveBuiltinSdkCached();
        if (preference.source === "builtin") {
          const active = await resolveActiveCliPath(preference, { builtin });
          if (active.path?.trim()) return active.path;
          throw new Error(active.error || "Builtin pi CLI entry not found");
        }
        // Global SDK: detect only — never auto-install from the terminal path.
        const ensured = await ensurePiCli();
        if (ensured.path?.trim()) return ensured.path;
        const active = await resolveActiveCliPath(preference, { builtin });
        if (active.path?.trim()) return active.path;
        throw new Error(
          ensured.error ||
            active.error ||
            "Global pi CLI not found. Click Install global pi, or switch to builtin SDK.",
        );
      });
      piTuiController = controller;
      return controller;
    })();
  }
  return piTuiControllerInit;
}

const execFileAsync = promisify(execFile);
const currentDirectory = dirname(fileURLToPath(import.meta.url));
const HOST_EVENT_CHANNEL = "pix:host:event";
const PI_PROGRESS_CHANNEL = "pix:pi:progress";

/** Best-effort branch / worktree labels for composer chrome (no git binary required). */
function readGitContext(cwd: string | undefined): GitContextInfo {
  if (!cwd || !existsSync(cwd)) return {};
  try {
    const gitEntry = join(cwd, ".git");
    if (!existsSync(gitEntry)) return {};
    let gitDir = gitEntry;
    let isMainWorktree = true;
    let worktree = "本地";
    let mainWorktreePath = cwd;
    const stat = lstatSync(gitEntry);
    if (stat.isFile()) {
      // Linked worktree: `.git` is a file `gitdir: /path/to/main/.git/worktrees/name`
      const raw = readFileSync(gitEntry, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/m.exec(raw);
      if (match?.[1]) {
        gitDir = resolve(cwd, match[1].trim());
        isMainWorktree = false;
        worktree = basename(gitDir) || "工作树";
        // .../.git/worktrees/<name> → main git dir is .../.git → main root is parent of .git
        const mainGitDir = resolve(gitDir, "../..");
        mainWorktreePath = dirname(mainGitDir);
      }
    }
    const headPath = join(gitDir, "HEAD");
    if (!existsSync(headPath)) {
      return {
        worktree,
        isMainWorktree,
        mainWorktreePath,
        worktreePath: cwd,
      };
    }
    const head = readFileSync(headPath, "utf8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    const branch = ref?.[1]?.trim() || (head.length >= 7 ? head.slice(0, 7) : head) || undefined;
    return {
      ...(branch ? { branch } : {}),
      worktree,
      isMainWorktree,
      mainWorktreePath,
      worktreePath: cwd,
    };
  } catch {
    return {};
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  const err = String(stderr ?? "").trim();
  // git writes some progress to stderr; only treat as failure when exit would have thrown.
  void err;
  return String(stdout ?? "");
}

const WORKSPACE_SEARCH_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "release",
]);

/**
 * Paths for the `@` mention menu: prefer `git ls-files`, fall back to a shallow walk.
 */
async function searchWorkspacePaths(
  cwd: string,
  query: string,
  limit = 24,
): Promise<Array<{ path: string; relative: string; kind: "file" | "folder" }>> {
  if (!cwd || !existsSync(cwd)) return [];
  const needle = query.trim().toLocaleLowerCase();
  const cap = Math.max(1, Math.min(limit, 80));

  let candidates: string[] = [];
  try {
    const tracked = await runGit(cwd, ["ls-files", "-z"]);
    const others = await runGit(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]);
    const seen = new Set<string>();
    for (const block of [tracked, others]) {
      for (const rel of block.split("\0")) {
        const r = rel.trim().replace(/\\/g, "/");
        if (!r || seen.has(r)) continue;
        seen.add(r);
        candidates.push(r);
      }
    }
  } catch {
    candidates = [];
  }

  if (candidates.length === 0) {
    // Shallow fallback walk (depth-limited).
    const walk = (dir: string, prefix: string, depth: number) => {
      if (depth > 4 || candidates.length >= 2000) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name.startsWith(".") || WORKSPACE_SEARCH_SKIP.has(name)) continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        const abs = join(dir, name);
        let isDir = false;
        try {
          isDir = lstatSync(abs).isDirectory();
        } catch {
          continue;
        }
        candidates.push(rel.replace(/\\/g, "/"));
        if (isDir) walk(abs, rel.replace(/\\/g, "/"), depth + 1);
      }
    };
    walk(cwd, "", 0);
  }

  const scored = candidates
    .filter((rel) => {
      if (!needle) return true;
      return rel.toLocaleLowerCase().includes(needle);
    })
    .map((rel) => {
      const base = rel.split("/").pop() ?? rel;
      const lower = rel.toLocaleLowerCase();
      const baseLower = base.toLocaleLowerCase();
      let score = 2;
      if (needle) {
        if (baseLower.startsWith(needle)) score = 0;
        else if (baseLower.includes(needle)) score = 1;
        else if (lower.includes(needle)) score = 2;
      }
      return { rel, score, base };
    })
    .sort((a, b) => a.score - b.score || a.rel.localeCompare(b.rel))
    .slice(0, cap);

  const out: Array<{ path: string; relative: string; kind: "file" | "folder" }> = [];
  for (const item of scored) {
    const abs = resolve(cwd, item.rel);
    if (!existsSync(abs)) continue;
    let kind: "file" | "folder" = "file";
    try {
      kind = lstatSync(abs).isDirectory() ? "folder" : "file";
    } catch {
      continue;
    }
    out.push({ path: abs, relative: item.rel, kind });
  }
  return out;
}

function resolveWorkspaceCwd(cwd: string | undefined, fallback?: string): string {
  const path = (typeof cwd === "string" && cwd.trim() ? cwd : fallback)?.trim();
  if (!path || !existsSync(path)) throw new Error("工作区路径无效");
  return path;
}

async function listGitBranches(cwd: string): Promise<GitBranchInfo[]> {
  // Local branches
  const localOut = await runGit(cwd, [
    "for-each-ref",
    "--format=%(refname:short)%00%(HEAD)",
    "refs/heads",
  ]);
  const remoteOut = await runGit(cwd, [
    "for-each-ref",
    "--format=%(refname:short)%00%(HEAD)",
    "refs/remotes",
  ]);
  const seen = new Set<string>();
  const branches: GitBranchInfo[] = [];
  for (const [block, remote] of [
    [localOut, false],
    [remoteOut, true],
  ] as const) {
    for (const line of block.split("\n")) {
      const raw = line.trim();
      if (!raw) continue;
      const [name, headMark] = raw.split("\0");
      if (!name || name.endsWith("/HEAD")) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      branches.push({
        name,
        current: headMark === "*",
        ...(remote ? { remote: true } : {}),
      });
    }
  }
  // Prefer current first, then local alpha, then remote alpha.
  branches.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    if (Boolean(a.remote) !== Boolean(b.remote)) return a.remote ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  return branches;
}

async function checkoutGitBranch(cwd: string, branch: string): Promise<GitContextInfo> {
  const name = branch.trim();
  if (!name) throw new Error("分支名不能为空");
  // Remote-tracking: origin/foo → create/switch local foo tracking it when needed.
  if (name.includes("/") && !existsSync(join(cwd, ".git"))) {
    // still fine — git handles it
  }
  try {
    await runGit(cwd, ["checkout", name]);
  } catch (error) {
    // origin/feature → checkout -b feature --track origin/feature
    if (name.includes("/")) {
      const short = name.replace(/^[^/]+\//, "");
      await runGit(cwd, ["checkout", "-B", short, "--track", name]);
    } else {
      throw error;
    }
  }
  return readGitContext(cwd);
}

async function createGitBranch(
  cwd: string,
  branch: string,
  checkout = true,
): Promise<GitContextInfo> {
  const name = applyBranchPrefix(branch);
  if (!name) throw new Error("分支名不能为空");
  if (checkout) await runGit(cwd, ["checkout", "-b", name]);
  else await runGit(cwd, ["branch", name]);
  return readGitContext(cwd);
}

async function listGitWorktrees(cwd: string): Promise<GitWorktreeInfo[]> {
  const out = await runGit(cwd, ["worktree", "list", "--porcelain"]);
  const items: GitWorktreeInfo[] = [];
  let current: Partial<GitWorktreeInfo> = {};
  const flush = () => {
    if (!current.path) return;
    const item: GitWorktreeInfo = {
      path: current.path,
      main: items.length === 0,
    };
    if (current.branch) item.branch = current.branch;
    if (current.bare) item.bare = true;
    items.push(item);
    current = {};
  };
  for (const line of out.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed) {
      flush();
      continue;
    }
    if (trimmed.startsWith("worktree ")) {
      if (current.path) flush();
      current.path = trimmed.slice("worktree ".length).trim();
    } else if (trimmed.startsWith("branch ")) {
      const ref = trimmed.slice("branch ".length).trim();
      current.branch = ref.replace(/^refs\/heads\//, "");
    } else if (trimmed === "bare") {
      current.bare = true;
    }
  }
  flush();
  return items;
}

/** True when dir is a linked git worktree (`.git` is a `gitdir:` file). */
function isLinkedWorktreeDirectory(dir: string): boolean {
  try {
    const gitEntry = join(dir, ".git");
    if (!existsSync(gitEntry)) return false;
    if (!lstatSync(gitEntry).isFile()) return false;
    const raw = readFileSync(gitEntry, "utf8");
    return /^gitdir:\s*/m.test(raw);
  } catch {
    return false;
  }
}

function pixWorktreesBaseDir(): string {
  return join(app.getPath("documents"), "Pix", "worktrees");
}

/**
 * All linked worktrees Pix manages: under the configured root and/or
 * Documents/Pix/worktrees[/<repo>]/… — not limited to the currently open project.
 */
async function listAllManagedWorktrees(): Promise<GitWorktreeInfo[]> {
  const prefs = loadDesktopPrefs();
  const scanRoots: string[] = [];
  const configured = prefs.worktreeRoot?.trim();
  if (configured) scanRoots.push(configured);
  const defaultBase = pixWorktreesBaseDir();
  if (!configured || normalizeRecentPathKey(configured) !== normalizeRecentPathKey(defaultBase)) {
    scanRoots.push(defaultBase);
  }

  const byKey = new Map<string, GitWorktreeInfo>();
  const addDir = (dir: string) => {
    if (!isLinkedWorktreeDirectory(dir)) return;
    const key = normalizeRecentPathKey(dir);
    if (byKey.has(key)) return;
    const ctx = readGitContext(dir);
    byKey.set(key, {
      path: dir,
      main: false,
      ...(ctx.branch ? { branch: ctx.branch } : {}),
    });
  };

  const scanOneLevel = (root: string) => {
    if (!existsSync(root)) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      return;
    }
    for (const name of entries) {
      const child = join(root, name);
      try {
        if (!lstatSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      // Direct child is a worktree, or a per-repo folder containing worktrees.
      if (isLinkedWorktreeDirectory(child)) {
        addDir(child);
        continue;
      }
      let nested: string[] = [];
      try {
        nested = readdirSync(child);
      } catch {
        continue;
      }
      for (const n of nested) {
        const deep = join(child, n);
        try {
          if (lstatSync(deep).isDirectory()) addDir(deep);
        } catch {
          // skip
        }
      }
    }
  };

  for (const root of scanRoots) scanOneLevel(root);

  // Also harvest from every known project via `git worktree list`.
  const cwdHints = [
    ...prefs.recentWorkspaces,
    ...(typeof prefs.lastWorkspace === "string" ? [prefs.lastWorkspace] : []),
  ];
  for (const cwd of cwdHints) {
    if (!cwd?.trim() || isNonProjectWorkspacePath(cwd)) continue;
    try {
      const items = await listGitWorktrees(cwd);
      for (const w of items) {
        if (w.main || w.bare || !w.path) continue;
        const key = normalizeRecentPathKey(w.path);
        if (byKey.has(key)) continue;
        // Prefer managed roots; still include linked worktrees discovered via git.
        if (isLinkedWorktreeDirectory(w.path)) {
          byKey.set(key, {
            path: w.path,
            main: false,
            ...(w.branch ? { branch: w.branch } : {}),
          });
        }
      }
    } catch {
      // skip dead cwd
    }
  }

  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function repoFolderName(repoCwd: string): string {
  return basename(repoCwd.replace(/\\/g, "/").replace(/\/+$/, "")) || "repo";
}

function defaultWorktreeRootForRepo(repoCwd: string): string {
  return join(app.getPath("documents"), "Pix", "worktrees", repoFolderName(repoCwd));
}

function resolveWorktreeRoot(repoCwd: string, configured?: string): string {
  const custom = configured?.trim();
  if (custom) return custom;
  return defaultWorktreeRootForRepo(repoCwd);
}

function sanitizeWorktreeFolderName(raw: string): string {
  return raw.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

/**
 * Auto name: `<main-project>-1`, `<main-project>-2`, …
 * Uses the primary worktree folder name when cwd is already a linked worktree.
 */
function nextSequencedWorktreeName(repoCwd: string, root: string): string {
  const ctx = readGitContext(repoCwd);
  const mainRoot = ctx.mainWorktreePath?.trim() || repoCwd;
  const base = sanitizeWorktreeFolderName(repoFolderName(mainRoot));
  mkdirSync(root, { recursive: true });
  let n = 1;
  while (existsSync(join(root, `${base}-${n}`))) n += 1;
  return `${base}-${n}`;
}

function uniqueWorktreePath(root: string, baseName: string): string {
  mkdirSync(root, { recursive: true });
  const safe = sanitizeWorktreeFolderName(baseName) || localDateFolderName();
  // Already sequenced as name-N and free → use as-is.
  let path = join(root, safe);
  if (!existsSync(path)) return path;
  // Collision: bump numeric suffix (foo → foo-2, foo-1 → foo-2, …).
  const sequenced = /^(.*)-(\d+)$/.exec(safe);
  if (sequenced) {
    const stem = sequenced[1] || safe;
    let n = Math.max(1, Number(sequenced[2]) || 1) + 1;
    while (existsSync(join(root, `${stem}-${n}`))) n += 1;
    return join(root, `${stem}-${n}`);
  }
  let n = 2;
  while (existsSync(join(root, `${safe}-${n}`))) n += 1;
  return join(root, `${safe}-${n}`);
}

function getWorktreePrefsView(repoCwd?: string): WorktreePrefs {
  const prefs = loadDesktopPrefs();
  const configured = prefs.worktreeRoot?.trim() ?? "";
  const sampleCwd = repoCwd?.trim() || app.getPath("documents");
  const defaultRoot = defaultWorktreeRootForRepo(sampleCwd);
  const limit =
    typeof prefs.worktreeAutoDeleteLimit === "number" &&
    Number.isFinite(prefs.worktreeAutoDeleteLimit)
      ? Math.min(100, Math.max(1, Math.floor(prefs.worktreeAutoDeleteLimit)))
      : 10;
  return {
    root: resolveWorktreeRoot(sampleCwd, configured),
    rootConfigured: configured,
    // Default ON (recommended) when never set.
    autoDelete: prefs.worktreeAutoDelete !== false,
    autoDeleteLimit: limit,
    defaultRoot,
  };
}

function setWorktreePrefs(patch: {
  rootConfigured?: string;
  autoDelete?: boolean;
  autoDeleteLimit?: number;
}): WorktreePrefs {
  const prefs = loadDesktopPrefs();
  if (patch.rootConfigured !== undefined) {
    const v = patch.rootConfigured.trim();
    if (v) prefs.worktreeRoot = v;
    else delete prefs.worktreeRoot;
  }
  if (patch.autoDelete !== undefined) prefs.worktreeAutoDelete = patch.autoDelete;
  if (patch.autoDeleteLimit !== undefined) {
    prefs.worktreeAutoDeleteLimit = Math.min(100, Math.max(1, Math.floor(patch.autoDeleteLimit)));
  }
  saveDesktopPrefs(prefs);
  return getWorktreePrefsView();
}

function getGitPrefs(): GitPrefs {
  const prefs = loadDesktopPrefs();
  return {
    branchPrefix: prefs.gitBranchPrefix?.trim() || "pix/",
    pullMode: prefs.gitPullMode === "squash" ? "squash" : "merge",
    forcePush: prefs.gitForcePush === true,
    draftPr: prefs.gitDraftPr === true,
    customCommitCommand: prefs.gitCustomCommitCommand?.trim() ?? "",
    customPrCommand: prefs.gitCustomPrCommand?.trim() ?? "",
    modelProvider: prefs.gitModelProvider?.trim() ?? "",
    modelId: prefs.gitModelId?.trim() ?? "",
  };
}

function setGitPrefs(patch: Partial<GitPrefs>): GitPrefs {
  const prefs = loadDesktopPrefs();
  if (patch.branchPrefix !== undefined) {
    const v = patch.branchPrefix.trim();
    if (v) prefs.gitBranchPrefix = v;
    else delete prefs.gitBranchPrefix;
  }
  if (patch.pullMode !== undefined) {
    prefs.gitPullMode = patch.pullMode === "squash" ? "squash" : "merge";
  }
  if (patch.forcePush !== undefined) prefs.gitForcePush = patch.forcePush;
  if (patch.draftPr !== undefined) prefs.gitDraftPr = patch.draftPr;
  if (patch.customCommitCommand !== undefined) {
    const v = patch.customCommitCommand.trim();
    if (v) prefs.gitCustomCommitCommand = v;
    else delete prefs.gitCustomCommitCommand;
  }
  if (patch.customPrCommand !== undefined) {
    const v = patch.customPrCommand.trim();
    if (v) prefs.gitCustomPrCommand = v;
    else delete prefs.gitCustomPrCommand;
  }
  if (patch.modelProvider !== undefined || patch.modelId !== undefined) {
    const provider = (patch.modelProvider ?? prefs.gitModelProvider ?? "").trim();
    const id = (patch.modelId ?? prefs.gitModelId ?? "").trim();
    if (provider && id) {
      prefs.gitModelProvider = provider;
      prefs.gitModelId = id;
    } else {
      delete prefs.gitModelProvider;
      delete prefs.gitModelId;
    }
  }
  saveDesktopPrefs(prefs);
  return getGitPrefs();
}

function applyBranchPrefix(name: string): string {
  const raw = name.trim();
  if (!raw) return raw;
  const prefix = getGitPrefs().branchPrefix;
  if (!prefix) return raw;
  if (raw.startsWith(prefix)) return raw;
  return `${prefix}${raw}`;
}

/** Remove oldest managed linked worktrees under root until count <= limit. Never removes main. */
async function pruneManagedWorktrees(repoCwd: string): Promise<void> {
  const prefs = loadDesktopPrefs();
  // Default ON when unset; only skip when user explicitly disabled.
  if (prefs.worktreeAutoDelete === false) return;
  const limit =
    typeof prefs.worktreeAutoDeleteLimit === "number" &&
    Number.isFinite(prefs.worktreeAutoDeleteLimit)
      ? Math.min(100, Math.max(1, Math.floor(prefs.worktreeAutoDeleteLimit)))
      : 10;
  const root = normalizeRecentPathKey(resolveWorktreeRoot(repoCwd, prefs.worktreeRoot));
  const items = await listGitWorktrees(repoCwd);
  const managed = items
    .filter((w) => !w.main && !w.bare)
    .map((w) => ({
      path: w.path,
      key: normalizeRecentPathKey(w.path),
    }))
    .filter((w) => w.key === root || w.key.startsWith(`${root}/`));
  if (managed.length <= limit) return;
  // Prefer removing oldest by directory mtime when available.
  const ranked = managed
    .map((w) => {
      let mtime = 0;
      try {
        mtime = lstatSync(w.path).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { ...w, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime);
  const toRemove = ranked.slice(0, Math.max(0, ranked.length - limit));
  for (const item of toRemove) {
    try {
      await runGit(repoCwd, ["worktree", "remove", "--force", item.path]);
    } catch {
      // best-effort
    }
  }
}

async function createGitWorktree(
  cwd: string,
  options: { path?: string; branch?: string; newBranch?: string; name?: string },
): Promise<{ path: string; context: GitContextInfo }> {
  const prefs = loadDesktopPrefs();
  const root = resolveWorktreeRoot(cwd, prefs.worktreeRoot);
  let target = options.path?.trim() ?? "";
  // Folder + default branch stem: explicit name → newBranch → sequenced project-N.
  const autoName = nextSequencedWorktreeName(cwd, root);
  const folderStem = options.name?.trim() || options.newBranch?.trim() || autoName;
  if (!target) {
    target = uniqueWorktreePath(root, folderStem);
  }
  if (!target) throw new Error("工作树路径不能为空");
  mkdirSync(dirname(target), { recursive: true });
  const args = ["worktree", "add"];
  const startPoint = options.branch?.trim();
  // Literal "HEAD" (or omit) = current tip of the source checkout — not the same as master/main.
  const explicitStart = startPoint && startPoint.toUpperCase() !== "HEAD" ? startPoint : undefined;
  // Always create a new branch for the worktree (folder stem / auto project-N).
  const newBranchName = (options.newBranch?.trim() || options.name?.trim() || autoName).trim();
  args.push("-b", applyBranchPrefix(newBranchName), target);
  if (explicitStart) args.push(explicitStart);
  await runGit(cwd, args);
  await pruneManagedWorktrees(cwd);
  // Surface in the sidebar project rail immediately (even before openPath).
  rememberWorkspace(target);
  return { path: target, context: readGitContext(target) };
}

/** Remove a linked worktree. Never removes the primary worktree. */
async function removeGitWorktree(
  worktreePath: string,
  cwdHint?: string,
): Promise<{ removed: string }> {
  const targetRaw = worktreePath.trim();
  if (!targetRaw) throw new Error("工作树路径不能为空");
  const targetKey = normalizeRecentPathKey(targetRaw);
  if (!isLinkedWorktreeDirectory(targetRaw) && !existsSync(targetRaw)) {
    throw new Error("未找到该工作树");
  }
  const ctx = readGitContext(targetRaw);
  if (ctx.isMainWorktree !== false) {
    // If .git is a directory, this is a primary checkout — refuse.
    const gitEntry = join(targetRaw, ".git");
    if (existsSync(gitEntry) && lstatSync(gitEntry).isDirectory()) {
      throw new Error("不能删除主工作树");
    }
  }
  // Run remove from the worktree itself or any repo path that shares the gitdir.
  const gitCwd =
    (cwdHint?.trim() && existsSync(cwdHint) ? cwdHint : undefined) ||
    ctx.mainWorktreePath ||
    targetRaw;
  await runGit(gitCwd, ["worktree", "remove", "--force", targetRaw]);
  // Drop from recent rail if present.
  try {
    const prefs = loadDesktopPrefs();
    const recent = prefs.recentWorkspaces.filter(
      (item) => normalizeRecentPathKey(item) !== targetKey,
    );
    const next: DesktopPrefs = { ...prefs, recentWorkspaces: recent };
    if (prefs.lastWorkspace && normalizeRecentPathKey(prefs.lastWorkspace) === targetKey) {
      delete next.lastWorkspace;
    }
    saveDesktopPrefs(next);
  } catch {
    // best-effort
  }
  return { removed: targetRaw };
}

async function gitStatus(cwd: string): Promise<GitStatusSummary> {
  const branchOut = (
    await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")
  ).trim();
  const porcelain = await runGit(cwd, ["status", "--porcelain", "-b"]).catch(() => "");
  const lines = porcelain.split("\n").filter(Boolean);
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;
  const changes: GitChangeItem[] = [];
  for (const line of lines) {
    if (line.startsWith("## ")) {
      // ## main...origin/main [ahead 1, behind 2]
      const head = line.slice(3);
      const dots = head.indexOf("...");
      const branchPart = dots >= 0 ? head.slice(0, dots) : head.split(" ")[0];
      void branchPart;
      if (dots >= 0) {
        const rest = head.slice(dots + 3);
        const up = rest.split(/[\s[]/)[0]?.trim();
        if (up) upstream = up;
      }
      const aheadM = /ahead (\d+)/.exec(head);
      const behindM = /behind (\d+)/.exec(head);
      if (aheadM) ahead = Number(aheadM[1]);
      if (behindM) behind = Number(behindM[1]);
      continue;
    }
    // XY path  or XY orig -> path
    const code = line.slice(0, 2);
    let path = line.slice(3).trim();
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) path = path.slice(arrow + 4);
    const staged = code[0] !== " " && code[0] !== "?";
    const status =
      code.trim() === "??"
        ? "??"
        : code[0] !== " " && code[0] !== "?"
          ? code[0]
          : code[1] || code[0];
    changes.push({ path, status: status || "M", staged });
  }
  let insertions = 0;
  let deletions = 0;
  try {
    const numstat = await runGit(cwd, ["diff", "--numstat", "HEAD"]);
    for (const line of numstat.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const a = parts[0] === "-" ? 0 : Number(parts[0]);
      const d = parts[1] === "-" ? 0 : Number(parts[1]);
      if (Number.isFinite(a)) insertions += a;
      if (Number.isFinite(d)) deletions += d;
    }
    // Untracked files not in HEAD diff — count roughly as additions via status ??
    const untracked = changes.filter((c) => c.status === "??").length;
    if (untracked > 0 && insertions === 0 && deletions === 0) {
      // leave zeros; file list still shows under expanded changes
    }
  } catch {
    // no commits yet or not a repo
  }

  const summary: GitStatusSummary = {
    ahead,
    behind,
    changes,
    clean: changes.length === 0,
    insertions,
    deletions,
  };
  if (branchOut && branchOut !== "HEAD") summary.branch = branchOut;
  if (upstream) summary.upstream = upstream;
  return summary;
}

const DEFAULT_COMMIT_INSTRUCTION =
  "Write a concise git commit message for the changes below. Prefer conventional commits when appropriate. Output only the commit message text — no quotes, markdown fences, or commentary.";

async function generateCommitMessage(cwd: string): Promise<string> {
  if (!supervisor) throw new Error("Agent Host is not ready");
  const git = getGitPrefs();
  const instruction = git.customCommitCommand.trim() || DEFAULT_COMMIT_INSTRUCTION;
  const branch = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  const status = await gitStatus(cwd);
  const fileList =
    status.changes.length > 0
      ? status.changes.map((c) => `${c.status} ${c.path}`).join("\n")
      : "(no listed changes)";
  // Prefer unstaged+staged combined view; keep size bounded for the model.
  const diff =
    (await runGit(cwd, ["diff", "HEAD"]).catch(async () =>
      runGit(cwd, ["diff"]).catch(() => ""),
    )) || "";
  const truncatedDiff = diff.length > 14_000 ? `${diff.slice(0, 14_000)}\n…(truncated)` : diff;
  const prompt = [
    instruction,
    "",
    `Repository: ${cwd}`,
    `Branch: ${branch || "(unknown)"}`,
    "",
    "Changed files:",
    fileList,
    "",
    "Diff:",
    truncatedDiff || "(empty diff)",
    "",
    "Reply with ONLY the commit message.",
  ].join("\n");

  const text = await supervisor.completeText(prompt, {
    systemPrompt:
      "You write git commit messages. Follow the user instruction carefully. Output only the commit message text.",
    ...(git.modelProvider && git.modelId
      ? { model: { provider: git.modelProvider, id: git.modelId } }
      : {}),
  });
  // Strip accidental fences / quotes
  return text
    .replace(/^```[\w]*\n?/, "")
    .replace(/\n?```$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

async function gitCommit(cwd: string, message: string): Promise<GitStatusSummary> {
  let msg = message.trim();
  if (!msg) {
    msg = await generateCommitMessage(cwd);
  }
  if (!msg) throw new Error("无法生成提交说明");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", msg]);
  return gitStatus(cwd);
}

async function gitPull(cwd: string): Promise<GitStatusSummary> {
  const mode = getGitPrefs().pullMode;
  if (mode === "squash") {
    await runGit(cwd, ["pull", "--squash"]);
  } else {
    // Merge strategy (allow non-ff merges).
    await runGit(cwd, ["pull", "--no-rebase", "--no-ff"]);
  }
  return gitStatus(cwd);
}

async function gitPush(cwd: string): Promise<GitStatusSummary> {
  const force = getGitPrefs().forcePush;
  if (force) {
    await runGit(cwd, ["push", "--force", "-u", "origin", "HEAD"]);
  } else {
    await runGit(cwd, ["push", "-u", "origin", "HEAD"]);
  }
  return gitStatus(cwd);
}

async function gitCommitAndPush(cwd: string, message: string): Promise<GitStatusSummary> {
  await gitCommit(cwd, message);
  return gitPush(cwd);
}

async function openCreatePullRequest(cwd: string): Promise<void> {
  const git = getGitPrefs();
  const remote = (await runGit(cwd, ["remote", "get-url", "origin"]).catch(() => "")).trim();
  const branch = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  // customPrCommand is an AI prompt for PR helpers — not a shell command.
  if (!remote) throw new Error("未配置 origin 远程");
  let url = remote;
  if (url.startsWith("git@")) {
    // git@github.com:org/repo.git
    url = url.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
  } else {
    url = url.replace(/\.git$/, "");
  }
  if (url.includes("github.com") && branch) {
    const draft = git.draftPr ? "&draft=true" : "";
    url = `${url}/compare/${encodeURIComponent(branch)}?expand=1${draft}`;
  } else if (url.includes("gitlab") && branch) {
    const draft = git.draftPr ? "&merge_request[draft]=true" : "";
    url = `${url}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(branch)}${draft}`;
  }
  await shell.openExternal(url);
}

/** Resolve a macOS .app bundle path (Applications + System Utilities + ~/Applications). */
function resolveMacAppPath(appName: string): string | undefined {
  const names = [appName];
  // Common aliases
  if (appName === "iTerm") names.push("iTerm2");
  if (appName === "iTerm2") names.push("iTerm");
  const roots = [
    "/Applications",
    "/System/Applications",
    "/System/Applications/Utilities",
    join(homedir(), "Applications"),
  ];
  for (const root of roots) {
    for (const name of names) {
      const p = join(root, `${name}.app`);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

function isUsableIconDataUrl(data: string | undefined): data is string {
  // Reject empty / tiny payloads (broken extract) so UI can fall back to lucide icons.
  return Boolean(data && data.startsWith("data:image/") && data.length > 200);
}

function nativeImageToPngDataUrl(img: NativeImage): string | undefined {
  if (img.isEmpty()) return undefined;
  try {
    const size = img.getSize();
    if (!size.width || !size.height) return undefined;
    // Normalize chip size — some ICNS frames are huge / multi-resolution.
    let out = img;
    if (size.width > 64 || size.height > 64) {
      out = img.resize({ width: 64, height: 64, quality: "best" });
    } else if (size.width > 0 && size.width < 32) {
      out = img.resize({ width: 32, height: 32, quality: "best" });
    }
    const png = out.toPNG();
    if (!png?.length) {
      const url = out.toDataURL();
      return isUsableIconDataUrl(url) ? url : undefined;
    }
    const data = `data:image/png;base64,${png.toString("base64")}`;
    return isUsableIconDataUrl(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

async function fileIconDataUrl(filePath: string): Promise<string | undefined> {
  if (process.platform === "darwin") return qlmanageAppIconDataUrl(filePath);
  return undefined;
}

/** Convert .icns/.png via macOS `sips` — more reliable than nativeImage for some ICNS. */
async function sipsIconDataUrl(iconPath: string): Promise<string | undefined> {
  const out = join(tmpdir(), `pix-icon-${randomUUID()}.png`);
  try {
    await execFileAsync("sips", ["-s", "format", "png", "-z", "64", "64", iconPath, "--out", out], {
      windowsHide: true,
      timeout: 4_000,
    });
    if (!existsSync(out)) return undefined;
    const buf = readFileSync(out);
    if (!buf.length) return undefined;
    const data = `data:image/png;base64,${buf.toString("base64")}`;
    return isUsableIconDataUrl(data) ? data : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(out);
    } catch {
      // ignore
    }
  }
}

/** Read CFBundleIconFile / CFBundleIconName from a macOS .app Info.plist. */
async function macBundleIconBaseName(appPath: string): Promise<string | undefined> {
  const plist = join(appPath, "Contents", "Info.plist");
  if (!existsSync(plist)) return undefined;
  for (const key of ["CFBundleIconFile", "CFBundleIconName"] as const) {
    try {
      const { stdout } = await execFileAsync("plutil", ["-extract", key, "raw", "-o", "-", plist], {
        windowsHide: true,
      });
      const name = stdout.trim();
      if (name) return name;
    } catch {
      // key missing
    }
  }
  return undefined;
}

function resolveMacIcnsPath(appPath: string, iconBase: string): string | undefined {
  const resources = join(appPath, "Contents", "Resources");
  const base = iconBase.replace(/\.icns$/i, "");
  const candidates = [
    join(resources, iconBase),
    join(resources, `${base}.icns`),
    join(resources, `${base}.png`),
    join(resources, `${base}.ico`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Prefer the largest .icns under Contents/Resources (real app art, not generic). */
function findLargestMacIcns(appPath: string): string | undefined {
  const resources = join(appPath, "Contents", "Resources");
  if (!existsSync(resources)) return undefined;
  let best: { path: string; size: number } | undefined;
  try {
    for (const name of readdirSync(resources)) {
      if (!name.toLowerCase().endsWith(".icns")) continue;
      const p = join(resources, name);
      try {
        const st = lstatSync(p);
        if (!st.isFile()) continue;
        if (!best || st.size > best.size) best = { path: p, size: st.size };
      } catch {
        // skip
      }
    }
  } catch {
    return undefined;
  }
  return best?.path;
}

/** Successful icon data URLs only — never cache failures forever. */
const macAppIconCache = new Map<string, string>();

/**
 * Quick Look thumbnail of the .app (works for asset-catalog icons that have no loose .icns).
 * Hard-capped: never block the env panel for seconds per app.
 */
async function qlmanageAppIconDataUrl(appPath: string): Promise<string | undefined> {
  const outDir = join(tmpdir(), "pix-app-icons");
  try {
    mkdirSync(outDir, { recursive: true });
    await execFileAsync("qlmanage", ["-t", "-s", "64", "-o", outDir, appPath], {
      windowsHide: true,
      timeout: 2_500,
    });
    const expected = join(outDir, `${basename(appPath)}.png`);
    let pngPath = existsSync(expected) ? expected : undefined;
    if (!pngPath) {
      const stem = basename(appPath, ".app").toLowerCase();
      const hit = readdirSync(outDir).find(
        (f) => f.toLowerCase().includes(stem) && f.endsWith(".png"),
      );
      if (hit) pngPath = join(outDir, hit);
    }
    if (!pngPath || !existsSync(pngPath)) return undefined;
    // Prefer raw file bytes (reliable) over nativeImage re-encode.
    const buf = readFileSync(pngPath);
    if (!buf.length) return undefined;
    const data = `data:image/png;base64,${buf.toString("base64")}`;
    return isUsableIconDataUrl(data) ? data : undefined;
  } catch {
    return undefined;
  }
}

async function iconFromFilePath(iconPath: string): Promise<string | undefined> {
  // 1) Electron nativeImage
  const fromNi = nativeImageToPngDataUrl(nativeImage.createFromPath(iconPath));
  if (fromNi) return fromNi;
  // 2) sips re-encode (handles many ICNS cases nativeImage mishandles)
  return sipsIconDataUrl(iconPath);
}

/**
 * Real macOS app icons for "Open in…".
 * Order: ICNS/sips → getFileIcon(.app) → Quick Look.
 */
async function macAppIconDataUrl(appPath: string): Promise<string | undefined> {
  if (!appPath || !existsSync(appPath)) return undefined;
  const cached = macAppIconCache.get(appPath);
  if (cached) return cached;

  try {
    // 1) Info.plist → Resources icon file
    const iconBase = await macBundleIconBaseName(appPath);
    const fromPlist = iconBase ? resolveMacIcnsPath(appPath, iconBase) : undefined;
    if (fromPlist) {
      const data = await iconFromFilePath(fromPlist);
      if (data) {
        macAppIconCache.set(appPath, data);
        return data;
      }
    }

    // 2) Largest loose .icns (skip tiny utility icons when possible)
    const largest = findLargestMacIcns(appPath);
    if (largest && largest !== fromPlist) {
      const data = await iconFromFilePath(largest);
      if (data) {
        macAppIconCache.set(appPath, data);
        return data;
      }
    }

    // 3) OS icon for the .app bundle (correct for most modern apps)
    const fromOs = await fileIconDataUrl(appPath);
    if (fromOs) {
      macAppIconCache.set(appPath, fromOs);
      return fromOs;
    }

    // 4) Quick Look fallback
    const ql = await qlmanageAppIconDataUrl(appPath);
    if (ql) {
      macAppIconCache.set(appPath, ql);
      return ql;
    }
  } catch {
    // leave uncached so a later call can retry
  }
  return undefined;
}

async function listOpenTargets(cwd: string): Promise<DetectedApp[]> {
  const apps: DetectedApp[] = [];
  const push = (item: DetectedApp) => {
    if (!apps.some((a) => a.id === item.id)) apps.push(item);
  };

  if (process.platform === "darwin") {
    type Cand = {
      id: string;
      name: string;
      kind: DetectedApp["kind"];
      app: string;
      appPath: string;
    };
    const pending: Cand[] = [];

    const finderPath = resolveMacAppPath("Finder") ?? "/System/Library/CoreServices/Finder.app";
    if (existsSync(finderPath)) {
      pending.push({
        id: "finder",
        name: "Finder",
        kind: "finder",
        app: "Finder",
        appPath: finderPath,
      });
    }

    const candidates: Array<{
      id: string;
      name: string;
      kind: DetectedApp["kind"];
      app: string;
    }> = [
      { id: "cursor", name: "Cursor", kind: "ide", app: "Cursor" },
      { id: "vscode", name: "Visual Studio Code", kind: "ide", app: "Visual Studio Code" },
      {
        id: "vscode-insiders",
        name: "VS Code Insiders",
        kind: "ide",
        app: "Visual Studio Code - Insiders",
      },
      { id: "zed", name: "Zed", kind: "ide", app: "Zed" },
      { id: "webstorm", name: "WebStorm", kind: "ide", app: "WebStorm" },
      { id: "intellij", name: "IntelliJ IDEA", kind: "ide", app: "IntelliJ IDEA" },
      { id: "terminal", name: "Terminal", kind: "terminal", app: "Terminal" },
      { id: "iterm", name: "iTerm", kind: "terminal", app: "iTerm" },
      { id: "iterm2", name: "iTerm2", kind: "terminal", app: "iTerm2" },
      { id: "warp", name: "Warp", kind: "terminal", app: "Warp" },
      { id: "ghostty", name: "Ghostty", kind: "terminal", app: "Ghostty" },
      { id: "alacritty", name: "Alacritty", kind: "terminal", app: "Alacritty" },
      { id: "kitty", name: "Kitty", kind: "terminal", app: "kitty" },
      { id: "hyper", name: "Hyper", kind: "terminal", app: "Hyper" },
      { id: "wezterm", name: "WezTerm", kind: "terminal", app: "WezTerm" },
    ];

    const seenBundles = new Set<string>();
    for (const c of candidates) {
      const appPath = resolveMacAppPath(c.app);
      if (!appPath) continue;
      const bundleKey = appPath.replace(/\\/g, "/").toLowerCase();
      if (seenBundles.has(bundleKey)) continue;
      seenBundles.add(bundleKey);
      pending.push({ ...c, appPath });
    }

    // Resolve icons in parallel; isolate failures so one app cannot blank all icons.
    const resolved = await Promise.all(
      pending.map(async (c) => {
        let iconDataUrl: string | undefined;
        try {
          iconDataUrl = await macAppIconDataUrl(c.appPath);
        } catch {
          iconDataUrl = undefined;
        }
        const launchName = basename(c.appPath, ".app");
        const item: DetectedApp = {
          id: c.id,
          name: c.name === "iTerm2" || c.name === "iTerm" ? launchName : c.name,
          kind: c.kind,
          target: c.kind === "finder" ? "Finder" : launchName,
          ...(iconDataUrl ? { iconDataUrl } : {}),
        };
        return item;
      }),
    );
    for (const item of resolved) push(item);
  } else if (process.platform === "win32") {
    push({ id: "explorer", name: "Explorer", kind: "finder", target: "explorer" });
    // Only list apps that resolve on PATH or known install dirs (do not advertise missing IDEs).
    const winCandidates: Array<{
      id: string;
      name: string;
      kind: DetectedApp["kind"];
      target: string;
      /** Extra absolute paths to check when `where` fails (e.g. Cursor not on PATH). */
      extraPaths?: string[];
    }> = [
      {
        id: "cursor",
        name: "Cursor",
        kind: "ide",
        target: "cursor",
        extraPaths: [
          join(homedir(), "AppData", "Local", "Programs", "cursor", "Cursor.exe"),
          join(homedir(), "AppData", "Local", "cursor", "Cursor.exe"),
          "C:\\Program Files\\Cursor\\Cursor.exe",
        ],
      },
      {
        id: "vscode",
        name: "Visual Studio Code",
        kind: "ide",
        target: "code",
        extraPaths: [
          join(homedir(), "AppData", "Local", "Programs", "Microsoft VS Code", "Code.exe"),
          "C:\\Program Files\\Microsoft VS Code\\Code.exe",
          "C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd",
        ],
      },
      {
        id: "goland",
        name: "GoLand",
        kind: "ide",
        target: "goland",
        extraPaths: [
          join(homedir(), "AppData", "Local", "Programs", "GoLand", "bin", "goland64.exe"),
        ],
      },
      {
        id: "pycharm",
        name: "PyCharm",
        kind: "ide",
        target: "pycharm",
        extraPaths: [
          join(homedir(), "AppData", "Local", "Programs", "PyCharm", "bin", "pycharm64.exe"),
        ],
      },
      { id: "wt", name: "Windows Terminal", kind: "terminal", target: "wt" },
      { id: "cmd", name: "Command Prompt", kind: "terminal", target: "cmd" },
      { id: "powershell", name: "PowerShell", kind: "terminal", target: "powershell" },
    ];

    await Promise.all(
      winCandidates.map(async (c) => {
        let exe: string | undefined;
        try {
          const { stdout } = await execFileAsync("where.exe", [c.target], {
            windowsHide: true,
            timeout: 8_000,
            maxBuffer: 1024 * 1024,
          });
          exe = stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .find((line) => line.length > 0 && existsSync(line));
        } catch {
          exe = undefined;
        }
        if (!exe) {
          exe = (c.extraPaths ?? []).find((p) => existsSync(p));
        }
        if (!exe) return; // not installed — omit from menu
        let iconDataUrl: string | undefined;
        try {
          iconDataUrl = await fileIconDataUrl(exe);
        } catch {
          iconDataUrl = undefined;
        }
        // Prefer resolved absolute path so open works even when the shim is not on PATH.
        push({
          id: c.id,
          name: c.name,
          kind: c.kind,
          target: exe,
          ...(iconDataUrl ? { iconDataUrl } : {}),
        });
      }),
    );
  } else {
    push({ id: "files", name: "Files", kind: "finder", target: "xdg-open" });
    await Promise.all(
      [
        { id: "cursor", name: "Cursor", kind: "ide" as const, target: "cursor" },
        { id: "vscode", name: "Visual Studio Code", kind: "ide" as const, target: "code" },
        {
          id: "terminal",
          name: "Terminal",
          kind: "terminal" as const,
          target: "x-terminal-emulator",
        },
        {
          id: "gnome-terminal",
          name: "GNOME Terminal",
          kind: "terminal" as const,
          target: "gnome-terminal",
        },
        { id: "konsole", name: "Konsole", kind: "terminal" as const, target: "konsole" },
      ].map(async (c) => {
        try {
          await execFileAsync("which", [c.target], { timeout: 5_000, maxBuffer: 256 * 1024 });
          push({ ...c });
        } catch {
          // not installed
        }
      }),
    );
  }

  void cwd;
  return apps;
}

/** Official gallery: npm registry search for keyword `pi-package` (same as pi.dev/packages). */
async function searchPiPackageCatalog(
  query?: string,
  size = 20,
  from = 0,
): Promise<{ packages: CatalogPackage[]; total: number }> {
  const q = query?.trim() ?? "";
  const text = q ? `keywords:pi-package ${q}` : "keywords:pi-package";
  const limit = Math.min(100, Math.max(1, Math.floor(size)));
  const offset = Math.max(0, Math.floor(from));
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${limit}&from=${offset}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "pix-desktop" },
  });
  if (!res.ok) {
    throw new Error(`插件目录请求失败 (${res.status})`);
  }
  const data = (await res.json()) as {
    total?: number;
    objects?: Array<{
      package?: {
        name?: string;
        description?: string;
        version?: string;
        date?: string;
        keywords?: string[];
        publisher?: { username?: string };
      };
      downloads?: { weekly?: number };
    }>;
  };
  const items: CatalogPackage[] = [];
  for (const obj of data.objects ?? []) {
    const pkg = obj.package;
    if (!pkg?.name) continue;
    const entry: CatalogPackage = {
      name: pkg.name,
      description: pkg.description?.trim() || "",
      version: pkg.version || "latest",
      source: `npm:${pkg.name}`,
    };
    if (pkg.publisher?.username) entry.publisher = pkg.publisher.username;
    if (typeof obj.downloads?.weekly === "number") entry.weeklyDownloads = obj.downloads.weekly;
    if (pkg.date) entry.updatedAt = pkg.date;
    if (Array.isArray(pkg.keywords))
      entry.keywords = pkg.keywords.filter((k) => typeof k === "string");
    items.push(entry);
  }
  const total =
    typeof data.total === "number" && Number.isFinite(data.total)
      ? Math.max(data.total, items.length + offset)
      : offset + items.length;
  return { packages: items, total };
}

async function openInApp(appId: string, cwd: string): Promise<void> {
  const apps = await listOpenTargets(cwd);
  const found = apps.find((a) => a.id === appId);
  if (!found) throw new Error(`未找到应用: ${appId}`);

  if (found.kind === "finder") {
    // Open folder itself (not "reveal file") for project roots.
    if (process.platform === "darwin") {
      await execFileAsync("open", [cwd], { windowsHide: true });
      return;
    }
    if (process.platform === "win32") {
      await execFileAsync("explorer", [cwd], { windowsHide: true });
      return;
    }
    await execFileAsync("xdg-open", [cwd], { windowsHide: true });
    return;
  }

  if (process.platform === "darwin") {
    // Terminal apps: open with working directory
    if (found.kind === "terminal") {
      if (found.id === "terminal") {
        // Apple Terminal via AppleScript so cwd is applied.
        const script = `tell application "Terminal" to do script "cd ${cwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
        await execFileAsync("osascript", ["-e", script], { windowsHide: true });
        return;
      }
      if (found.id === "iterm" || found.id === "iterm2") {
        const script = `tell application "iTerm"
  activate
  try
    tell current window
      create tab with default profile
      tell current session
        write text "cd ${cwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
      end tell
    end tell
  on error
    create window with default profile
    tell current session of current window
      write text "cd ${cwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
    end tell
  end try
end tell`;
        await execFileAsync("osascript", ["-e", script], { windowsHide: true });
        return;
      }
    }
    await execFileAsync("open", ["-a", found.target, cwd], { windowsHide: true });
    return;
  }
  if (process.platform === "win32") {
    if (found.id === "wt") {
      await execFileAsync("wt", ["-d", cwd], { windowsHide: true, shell: true });
      return;
    }
    if (found.id === "cmd") {
      await execFileAsync("cmd", ["/c", "start", "cmd", "/k", `cd /d ${cwd}`], {
        windowsHide: true,
        shell: true,
      });
      return;
    }
    if (found.id === "powershell") {
      await execFileAsync(
        "powershell",
        ["-NoExit", "-Command", `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`],
        { windowsHide: true, shell: true },
      );
      return;
    }
    await execFileAsync(found.target, [cwd], { windowsHide: true, shell: true });
    return;
  }
  if (found.kind === "terminal") {
    await execFileAsync(found.target, ["--working-directory", cwd], { windowsHide: true }).catch(
      async () => {
        await execFileAsync(found.target, [cwd], { windowsHide: true });
      },
    );
    return;
  }
  await execFileAsync(found.target, [cwd], { windowsHide: true });
}

/** Restored RendererConnection geometry (userData/pix-desktop.json). */
interface WindowBoundsPrefs {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

interface DesktopPrefs {
  recentWorkspaces: string[];
  lastWorkspace?: string;
  /** Last main window position / size. */
  window?: WindowBoundsPrefs;
  /** Whole-app renderer scale as a percentage. */
  appScale?: number;
  /** Absolute root for new git worktrees; empty/undefined = Documents/Pix/worktrees/<repo>. */
  worktreeRoot?: string;
  /** When false, disable auto-prune. Default / unset = enabled (recommended). */
  worktreeAutoDelete?: boolean;
  /** Max managed worktrees to keep when auto-delete is on (default 10). */
  worktreeAutoDeleteLimit?: number;
  /** Prefixed onto new branch names when not already present. */
  gitBranchPrefix?: string;
  /** How `git pull` merges remote changes. */
  gitPullMode?: "merge" | "squash";
  /** Always force-push (uses --force). */
  gitForcePush?: boolean;
  /** Open create-PR links as draft when supported. */
  gitDraftPr?: boolean;
  /**
   * AI prompt for commit-message helpers (not a shell command).
   * Empty = default AI / manual message strategy.
   */
  gitCustomCommitCommand?: string;
  /**
   * AI prompt for PR title/body helpers (not a shell command).
   * Empty = default AI / browser create-PR flow.
   */
  gitCustomPrCommand?: string;
  /** Model used for AI-assisted git ops (commit message / PR helpers). Empty = session default. */
  gitModelProvider?: string;
  gitModelId?: string;
  /**
   * Independent proxies:
   * - ai: agent-host / models / OAuth (Node fetch)
   * - app: Electron session (renderer loads, shell.openExternal helpers, etc.)
   */
  proxy?: ProxyPrefs;
  /**
   * Which pi SDK powers Agent Host + terminal (desktop-only; not ~/.pi/agent).
   * builtin = packaged dependency; global = npm -g / PATH pi.
   */
  piSdk?: PiSdkPrefs;
  /**
   * Bundled Node/Python under Resources/runtimes. Default ON when unset.
   */
  bundledRuntimes?: Partial<BundledRuntimePrefs>;
}

const WINDOW_MIN_WIDTH = 760;
const WINDOW_MIN_HEIGHT = 560;
const APP_SCALE_DEFAULT = 100;
const APP_SCALE_MIN = 80;
const APP_SCALE_MAX = 150;

export type WorktreePrefs = {
  root: string;
  /** Empty string means default. */
  rootConfigured: string;
  autoDelete: boolean;
  autoDeleteLimit: number;
  defaultRoot: string;
};

export type GitPrefs = {
  branchPrefix: string;
  pullMode: "merge" | "squash";
  forcePush: boolean;
  draftPr: boolean;
  customCommitCommand: string;
  customPrCommand: string;
  /** Empty provider/id = use current session / pi default model. */
  modelProvider: string;
  modelId: string;
};

function prefsPath(): string {
  return join(app.getPath("userData"), "pix-desktop.json");
}

function isEphemeralWorkspacePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  return (
    normalized.includes("/tmp/") ||
    normalized.includes("/var/folders/") ||
    normalized.includes("/pix-e2e-") ||
    normalized.includes("/pix-fake-") ||
    normalized.includes("/pix-test-") ||
    normalized.includes("/pix-p0") ||
    normalized.includes("/fork-probe") ||
    normalized.includes("/recent-ws-") ||
    normalized.includes("/other-workspace") ||
    /\/t\/pix-/.test(normalized)
  );
}

/**
 * Auto scratch from ensureDefault: …/Pix/YYYY-MM-DD[ -N].
 * Not a user project — must not land in recent/last or the sidebar 项目 list.
 */
function isAutoDefaultWorkspacePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /\/Pix\/\d{4}-\d{2}-\d{2}(-\d+)?$/i.test(normalized);
}

/** Pure-conversation home: …/Pix/conversations[/…] — never a sidebar project. */
function isConversationWorkspacePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /\/Pix\/conversations(?:\/|$)/i.test(normalized);
}

function isNonProjectWorkspacePath(path: string): boolean {
  return (
    isEphemeralWorkspacePath(path) ||
    isAutoDefaultWorkspacePath(path) ||
    isConversationWorkspacePath(path)
  );
}

function durableWorkspacePath(cwd: string | undefined): string | undefined {
  if (!cwd || typeof cwd !== "string") return undefined;
  if (isNonProjectWorkspacePath(cwd)) return undefined;
  try {
    if (!existsSync(cwd)) return undefined;
  } catch {
    return undefined;
  }
  return cwd;
}

/** Local calendar date as YYYY-MM-DD (no timezone suffix). */
function localDateFolderName(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Default project root: Documents/Pix/<YYYY-MM-DD>.
 * Reuses today's folder when it already exists as a directory.
 */
function ensureDefaultWorkspacePath(): string {
  const root = join(app.getPath("documents"), "Pix");
  mkdirSync(root, { recursive: true });
  const base = localDateFolderName();
  const path = join(root, base);
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
    return path;
  }
  try {
    if (lstatSync(path).isDirectory()) return path;
  } catch {
    // fall through to a unique suffix
  }
  let n = 2;
  while (existsSync(join(root, `${base}-${n}`))) n += 1;
  const unique = join(root, `${base}-${n}`);
  mkdirSync(unique, { recursive: true });
  return unique;
}

/**
 * Global「新建会话」home — pure conversations, never listed as a project.
 * Documents/Pix/conversations
 */
function ensureConversationWorkspacePath(): string {
  const path = join(app.getPath("documents"), "Pix", "conversations");
  mkdirSync(path, { recursive: true });
  return path;
}

function saveDesktopPrefs(prefs: DesktopPrefs): void {
  const path = prefsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
}

/**
 * Load prefs and scrub fixture/temp paths left by older isolated launches.
 * If lastWorkspace is dead, fall back to the first durable recent project.
 * Preserves unrelated fields (git, window bounds, worktree, …).
 */
function loadDesktopPrefs(): DesktopPrefs {
  try {
    const path = prefsPath();
    if (!existsSync(path)) return { recentWorkspaces: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DesktopPrefs;
    const rawRecent = Array.isArray(parsed.recentWorkspaces)
      ? parsed.recentWorkspaces.filter((item) => typeof item === "string")
      : [];
    const recentSeen = new Set<string>();
    const recentWorkspaces: string[] = [];
    for (const item of rawRecent) {
      const durable = durableWorkspacePath(item);
      if (!durable) continue;
      const key = normalizeRecentPathKey(durable);
      if (recentSeen.has(key)) continue;
      recentSeen.add(key);
      recentWorkspaces.push(durable);
      if (recentWorkspaces.length >= 12) break;
    }
    const lastWorkspace =
      durableWorkspacePath(
        typeof parsed.lastWorkspace === "string" ? parsed.lastWorkspace : undefined,
      ) ?? recentWorkspaces[0];
    const windowBounds = normalizeWindowBoundsPrefs(parsed.window);
    const cleaned: DesktopPrefs = {
      ...parsed,
      recentWorkspaces,
      ...(lastWorkspace ? { lastWorkspace } : {}),
      ...(windowBounds ? { window: windowBounds } : {}),
    };
    if (!lastWorkspace) delete cleaned.lastWorkspace;
    if (!windowBounds) delete cleaned.window;
    // Persist scrub so a deleted /tmp workspace cannot keep blocking send/start.
    const dirty =
      JSON.stringify(parsed.recentWorkspaces ?? []) !== JSON.stringify(recentWorkspaces) ||
      parsed.lastWorkspace !== lastWorkspace;
    if (dirty) saveDesktopPrefs(cleaned);
    return cleaned;
  } catch {
    return { recentWorkspaces: [] };
  }
}

function normalizeAppScale(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return APP_SCALE_DEFAULT;
  return Math.min(APP_SCALE_MAX, Math.max(APP_SCALE_MIN, Math.round(raw)));
}

function getAppScale(): number {
  return normalizeAppScale(loadDesktopPrefs().appScale);
}

function applyAppScale(_win: RendererConnection | null | undefined, scale: number): void {
  void nativeRequest("window.scale", { scale: scale / 100 }).catch((error) => console.warn(error));
}

function setAppScale(raw: unknown): number {
  const scale = normalizeAppScale(raw);
  saveDesktopPrefs({ ...loadDesktopPrefs(), appScale: scale });
  applyAppScale(mainWindow, scale);
  return scale;
}

function normalizeRecentPathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.startsWith("/private/var/") ? normalized.slice("/private".length) : normalized;
}

function rememberWorkspace(cwd: string): void {
  const prefs = loadDesktopPrefs();
  const key = normalizeRecentPathKey(cwd);
  // Keep lastWorkspace for resume; only grow "recent" with durable project paths.
  // Compare with normalized keys so Windows slash/trailing variants do not fork entries
  // or drop siblings when switching projects from the composer picker.
  const cleaned = prefs.recentWorkspaces.filter((item) => {
    if (typeof item !== "string" || !item.trim()) return false;
    if (isNonProjectWorkspacePath(item)) return false;
    return normalizeRecentPathKey(item) !== key;
  });
  // Fixture / temp / auto date folders must not become the cold-start resume target
  // or pollute the sidebar 项目 list (e.g. Documents/Pix/2026-07-21).
  if (isNonProjectWorkspacePath(cwd)) {
    const last = durableWorkspacePath(prefs.lastWorkspace) ?? cleaned[0];
    const next: DesktopPrefs = {
      ...prefs,
      recentWorkspaces: cleaned.slice(0, 12),
    };
    if (last) next.lastWorkspace = last;
    else delete next.lastWorkspace;
    saveDesktopPrefs(next);
    return;
  }
  saveDesktopPrefs({
    ...prefs,
    recentWorkspaces: [cwd, ...cleaned].slice(0, 12),
    lastWorkspace: cwd,
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Validate stored window geometry; drop off-screen / nonsense values. */
function normalizeWindowBoundsPrefs(raw: unknown): WindowBoundsPrefs | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (
    !isFiniteNumber(o.x) ||
    !isFiniteNumber(o.y) ||
    !isFiniteNumber(o.width) ||
    !isFiniteNumber(o.height)
  ) {
    return undefined;
  }
  const width = Math.max(WINDOW_MIN_WIDTH, Math.round(o.width));
  const height = Math.max(WINDOW_MIN_HEIGHT, Math.round(o.height));
  const x = Math.round(o.x);
  const y = Math.round(o.y);
  return {
    x,
    y,
    width,
    height,
    ...(o.isMaximized === true ? { isMaximized: true } : {}),
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

interface ActiveHost {
  child: ChildProcess;
  hostId: string;
  hello: Deferred<void>;
  exit: Deferred<number>;
  ignoreMessages: boolean;
  stopping: boolean;
  stderr: string;
}

type PendingWaiter = {
  resolve: (event: HostEvent) => void;
  reject: (error: Error) => void;
  /** Undefined when the command has no wait budget (e.g. agent.prompt). */
  timeout: NodeJS.Timeout | undefined;
  commandType: string;
};

function clearPendingTimeout(waiter: Pick<PendingWaiter, "timeout">): void {
  if (waiter.timeout !== undefined) clearTimeout(waiter.timeout);
}

/**
 * Wait budgets for host command RPC. `agent.prompt` is unbounded: a turn may stream
 * and tool-call for far longer than any fixed IPC budget. Timing it out orphans the
 * UI (running=false) while the host keeps processing, so later prompts fail with
 * "Agent is already processing". Users abort explicitly via agent.abort.
 *
 * `agent.abort` is soft-bounded in the host (~10s idle wait after signalling). Give
 * the IPC layer a small margin so a healthy abort always resolves; a hard-stuck
 * host still times out and is recycled in Supervisor.abort().
 */
function hostCommandTimeoutMs(commandType: string): number | undefined {
  switch (commandType) {
    case "agent.prompt":
      return undefined;
    case "agent.abort":
      return 20_000;
    case "providers.oauth.start":
      return 300_000;
    case "providers.usage":
      return 25_000;
    case "packages.install":
    case "packages.remove":
    case "packages.update":
      return 180_000;
    default:
      return 15_000;
  }
}

/**
 * A live utility-process host that is not the UI foreground.
 * Busy parks keep generating; idle parks stay warm for promote until TTL / cap.
 */
interface ParkedHost {
  host: ActiveHost;
  snapshot: HostSnapshot;
  lastSequence: number;
  pending: Map<string, PendingWaiter>;
  sessionKey: string;
  workspaceCwd?: string;
  parkedAt: number;
  idleSince?: number | undefined;
  idleTimer?: ReturnType<typeof setTimeout> | undefined;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Snapshot at module load so AI “system” mode is not polluted by app proxy mutations. */
const LAUNCH_ENV: NodeJS.ProcessEnv = { ...process.env };

function processEnvironment(): Record<string, string> {
  // Re-augment on each spawn: ensurePiCli may prepend npm global bin after install.
  const launch = augmentEnvPath({ ...LAUNCH_ENV, ...pickLivePathEnv() });
  const base = Object.fromEntries(
    Object.entries(launch).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const proxy = getProxyPrefs();
  // AI channel only — app proxy uses Electron session, not agent-host env.
  const withProxy = withNodeEnvProxyFlag(applyProxyChannelToEnv(base, proxy.ai, launch));
  const preference = getPiSdkPrefs();
  const builtin = resolveBuiltinSdkCached();
  const global = cachedGlobalSdk ?? { source: "global" as const, available: false };
  const sdkEnv = piSdkSpawnEnv(preference, builtin, global);
  appliedPiSdkSource = sdkEnv.PIX_PI_SDK_SOURCE === "global" ? "global" : "builtin";
  return { ...withProxy, ...sdkEnv };
}

/** Live PATH from process.env (may gain npm global bin after pi ensure). */
function pickLivePathEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  if (process.env.PATH) out.PATH = process.env.PATH;
  if (process.env.Path) out.Path = process.env.Path;
  return out;
}

function getProxyPrefs(): ProxyPrefs {
  return normalizeProxyPrefs(loadDesktopPrefs().proxy);
}

function setProxyPrefs(next: ProxyPrefs): ProxyPrefs {
  const normalized = normalizeProxyPrefs(next);
  const prefs = loadDesktopPrefs();
  saveDesktopPrefs({ ...prefs, proxy: normalized });
  return normalized;
}

/** Apply app-channel proxy to Chromium network stack only (not agent-host). */
async function applyAppSessionProxy(channel?: ProxyChannelPrefs): Promise<void> {
  const prefs = channel ?? getProxyPrefs().app;
  // App HTTP requests execute in Node; the WebView only loads bundled frontend assets.
  const next = applyProxyChannelToEnv({}, prefs, LAUNCH_ENV);
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: next.HTTP_PROXY || next.http_proxy || "",
      httpsProxy: next.HTTPS_PROXY || next.https_proxy || "",
      noProxy: next.NO_PROXY || next.no_proxy || "",
    }),
  );
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    if (next[key]) process.env[key] = next[key];
    else delete process.env[key];
  }
}

function normalizeHostCwd(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function normalizeSessionKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function sessionKeyFromSnapshot(snapshot: HostSnapshot | undefined): string | undefined {
  if (!snapshot) return undefined;
  const raw = snapshot.sessionFile?.trim() || snapshot.sessionId?.trim();
  return raw ? normalizeSessionKey(raw) : undefined;
}

function pendingHasPrompt(pending: Map<string, PendingWaiter>): boolean {
  for (const waiter of pending.values()) {
    if (waiter.commandType === "agent.prompt") return true;
  }
  return false;
}

class HostSupervisor {
  #host: ActiveHost | undefined;
  #snapshot: HostSnapshot | undefined;
  /**
   * Single-flight lifecycle queue. clearActive / start / stop / newSession must not
   * interleave — rapid「新建会话」clicks previously killed mid-start hosts (exit 0).
   */
  #opQueue: Promise<unknown> = Promise.resolve();
  #previousRuntimeId: string | undefined;
  #sessionFile: string | undefined;
  #workspaceCwd: string | undefined;
  /**
   * When true, host.start() will not fall back to prefs.lastWorkspace.
   * Used for global "新建任务" blank state — user must pick a project first.
   */
  #requireExplicitWorkspace = false;
  #resumeRecent = false;
  #lastSequence = 0;
  #crashOnEvent: string | undefined;
  #eventCounts = new Map<string, number>();
  #pending = new Map<string, PendingWaiter>();
  /**
   * Detached live hosts keyed by session file / session id.
   * Foreground is just the promoted pointer; every parked runtime stays first-class.
   * Busy parks are never evicted. Idle parks are capped and reaped after TTL.
   */
  #parked = new Map<string, ParkedHost>();

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#opQueue.then(fn, fn);
    this.#opQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  constructor(private readonly window: RendererConnection) {
    const prefs = loadDesktopPrefs();
    // Env fixture wins for isolated/e2e. Otherwise restore last durable workspace
    // (loadDesktopPrefs already falls back to first recent real project).
    this.#workspaceCwd =
      process.env.PIX_WORKSPACE ?? durableWorkspacePath(prefs.lastWorkspace) ?? undefined;
  }

  activeSessionFile(): string | undefined {
    return this.#snapshot?.sessionFile?.trim() || undefined;
  }

  #isForegroundBusy(): boolean {
    return pendingHasPrompt(this.#pending);
  }

  /** Busy work that an SDK switch would interrupt (foreground + parked generators). */
  getSdkSwitchActivity(): { agentBusy: boolean; parkedBusyCount: number } {
    const agentBusy = this.#isForegroundBusy();
    let parkedBusyCount = 0;
    for (const parked of this.#parked.values()) {
      if (pendingHasPrompt(parked.pending)) parkedBusyCount += 1;
    }
    return { agentBusy, parkedBusyCount };
  }

  #findParkedByHost(host: ActiveHost): ParkedHost | undefined {
    for (const parked of this.#parked.values()) {
      if (parked.host === host) return parked;
    }
    return undefined;
  }

  #findParkedBySession(sessionPath: string): ParkedHost | undefined {
    const key = normalizeSessionKey(sessionPath);
    const direct = this.#parked.get(key);
    if (direct) return direct;
    for (const parked of this.#parked.values()) {
      if (normalizeSessionKey(parked.sessionKey) === key) return parked;
      const file = parked.snapshot.sessionFile;
      if (file && normalizeSessionKey(file) === key) return parked;
      if (normalizeSessionKey(parked.snapshot.sessionId) === key) return parked;
    }
    return undefined;
  }

  #findParkedByCwd(cwd: string): ParkedHost | undefined {
    const sessionKey = findParkedSessionKeyByCwd(this.#parkedRefs(), cwd);
    return sessionKey ? this.#findParkedBySession(sessionKey) : undefined;
  }

  #parkedRefs() {
    return [...this.#parked.values()].map((p) => ({
      sessionKey: p.sessionKey,
      ...(p.workspaceCwd ? { workspaceCwd: p.workspaceCwd } : {}),
      ...(p.snapshot.cwd ? { snapshotCwd: p.snapshot.cwd } : {}),
      busy: pendingHasPrompt(p.pending),
      parkedAt: p.parkedAt,
      ...(p.idleSince !== undefined ? { idleSince: p.idleSince } : {}),
    }));
  }

  #disarmIdleReap(parked: ParkedHost): void {
    if (!parked.idleTimer) return;
    clearTimeout(parked.idleTimer);
    parked.idleTimer = undefined;
  }

  #armIdleReap(parked: ParkedHost): void {
    this.#disarmIdleReap(parked);
    if (pendingHasPrompt(parked.pending)) {
      parked.idleSince = undefined;
      return;
    }
    const idleSince = parked.idleSince ?? parked.parkedAt;
    parked.idleSince = idleSince;
    const wait = Math.max(0, PARKED_IDLE_TTL_MS - (Date.now() - idleSince));
    parked.idleTimer = setTimeout(() => {
      const live = this.#findParkedBySession(parked.sessionKey);
      if (live !== parked || pendingHasPrompt(live.pending)) return;
      void this.#killParked(live, "idle-ttl");
    }, wait);
    parked.idleTimer.unref();
  }

  /** Evict oldest idle parks while idle count is over the warm cap. Never evict busy. */
  #evictParkedIfNeeded(): void {
    while (idleParkedCount(this.#parkedRefs()) > MAX_PARKED_HOSTS) {
      const key = pickParkedEvictionKey(this.#parkedRefs());
      if (!key) break;
      const victim = this.#findParkedBySession(key);
      if (!victim) {
        this.#parked.delete(key);
        continue;
      }
      if (pendingHasPrompt(victim.pending)) break;
      void this.#killParked(victim, "evict");
    }
  }

  /**
   * Detach the foreground host without aborting.
   * - busy: always park (in-flight prompt keeps writing)
   * - idle + allowIdle: park for later promote (cross-project switch)
   * - idle without allowIdle: caller should stop instead
   */
  #parkForeground(options?: { allowIdle?: boolean }): boolean {
    const host = this.#host;
    const snapshot = this.#snapshot;
    const allowIdle = options?.allowIdle === true;
    const busy = this.#isForegroundBusy();
    const sessionKey = sessionKeyFromSnapshot(snapshot);
    if (
      !shouldParkForeground({
        hasHost: Boolean(host),
        hasSnapshot: Boolean(snapshot),
        hostStopping: Boolean(host?.stopping || host?.ignoreMessages),
        allowIdle,
        busy,
        sessionKey,
      })
    ) {
      return false;
    }
    if (!host || !snapshot || !sessionKey) return false;

    // Replace any older park for the same session.
    const existing = this.#parked.get(sessionKey);
    if (existing && existing.host !== host) {
      void this.#killParked(existing, "replaced");
    }

    // Re-insert so Map order tracks recency; idle cap is applied after insert.
    this.#parked.delete(sessionKey);
    const now = Date.now();
    const parked: ParkedHost = {
      host,
      snapshot,
      lastSequence: this.#lastSequence,
      pending: this.#pending,
      sessionKey,
      parkedAt: now,
      ...(busy ? {} : { idleSince: now }),
      ...(this.#workspaceCwd ? { workspaceCwd: this.#workspaceCwd } : {}),
    };
    this.#parked.set(sessionKey, parked);
    this.#host = undefined;
    this.#snapshot = undefined;
    this.#lastSequence = 0;
    this.#pending = new Map();
    if (busy) this.#disarmIdleReap(parked);
    else this.#armIdleReap(parked);
    this.#evictParkedIfNeeded();
    return true;
  }

  async #killParked(parked: ParkedHost, reason: string): Promise<void> {
    this.#disarmIdleReap(parked);
    this.#parked.delete(parked.sessionKey);
    // Also delete by any alias keys that might differ.
    for (const [key, value] of this.#parked) {
      if (value === parked) this.#parked.delete(key);
    }
    parked.host.stopping = true;
    parked.host.ignoreMessages = true;
    for (const waiter of parked.pending.values()) {
      clearPendingTimeout(waiter);
      waiter.reject(new Error(`Parked Agent Host was stopped (${reason})`));
    }
    parked.pending.clear();
    try {
      parked.host.child.kill();
    } catch {
      // already dead
    }
    await parked.host.exit.promise.catch(() => undefined);
  }

  /**
   * Bring a parked host (busy or idle) back to the UI foreground.
   * Parks the current foreground (idle or busy) first so it can be reused later.
   */
  async #promoteParked(sessionPath: string): Promise<boolean> {
    const parked = this.#findParkedBySession(sessionPath);
    if (!parked) return false;

    // Detach current foreground without aborting; prefer park over kill for reuse.
    if (this.#host) {
      if (!this.#parkForeground({ allowIdle: true })) {
        await this.#stopExclusive().catch(() => undefined);
      }
    }

    // Re-find after possible re-park (map stable by identity).
    const live = this.#findParkedBySession(sessionPath);
    if (!live) return false;
    this.#disarmIdleReap(live);
    this.#parked.delete(live.sessionKey);
    for (const [key, value] of this.#parked) {
      if (value === live) this.#parked.delete(key);
    }

    this.#host = live.host;
    this.#snapshot = live.snapshot;
    this.#lastSequence = live.lastSequence;
    this.#pending = live.pending;
    this.#sessionFile = live.snapshot.sessionFile ?? sessionPath;
    if (live.workspaceCwd) {
      this.#workspaceCwd = live.workspaceCwd;
      this.#requireExplicitWorkspace = false;
    } else if (live.snapshot.cwd) {
      this.#workspaceCwd = live.snapshot.cwd;
      this.#requireExplicitWorkspace = false;
    }
    return true;
  }

  /** Promote any parked host bound to this workspace cwd (project or conversation). */
  async #promoteParkedByCwd(cwd: string): Promise<boolean> {
    const parked = this.#findParkedByCwd(cwd);
    if (!parked) return false;
    return this.#promoteParked(parked.sessionKey);
  }

  /**
   * Leave the foreground host: park when possible (idle or busy), otherwise stop.
   * Used before openWorkspace / new blank / force spawn.
   */
  async #detachForeground(): Promise<void> {
    if (!this.#host) return;
    if (this.#parkForeground({ allowIdle: true })) return;
    await this.#stopExclusive().catch(() => undefined);
  }

  async #openCurrentSessionProjection(): Promise<{
    snapshot: HostSnapshot;
    threads: SessionThreadSummary[];
    history: SessionHistoryMessage[];
  }> {
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.current",
      requestId: randomUUID(),
    });
    if (event.type !== "session.opened") {
      throw new Error("Agent Host returned an unexpected session.current response");
    }
    this.#acceptSnapshot(event.snapshot);
    return { snapshot: event.snapshot, threads: event.threads, history: event.history };
  }

  getWorkspaceCwd(): string | undefined {
    return this.#workspaceCwd;
  }

  removeRecentWorkspace(cwd: string): string[] {
    const prefs = loadDesktopPrefs();
    const normalized = normalizeRecentPathKey(cwd);
    const samePath = (item: string) => normalizeRecentPathKey(item) === normalized;
    // Case-insensitive on Windows so D:\a and d:\a both drop.
    const samePathWin =
      process.platform === "win32"
        ? (item: string) => normalizeRecentPathKey(item).toLowerCase() === normalized.toLowerCase()
        : samePath;
    const match = process.platform === "win32" ? samePathWin : samePath;
    const recent = prefs.recentWorkspaces.filter((item) => !match(item));
    const next: DesktopPrefs = {
      ...prefs,
      recentWorkspaces: recent,
    };
    if (prefs.lastWorkspace && match(prefs.lastWorkspace)) {
      delete next.lastWorkspace;
    }
    // If removing the live project, detach so it leaves the sidebar "current" slot.
    const active = this.#workspaceCwd ? normalizeRecentPathKey(this.#workspaceCwd) : "";
    const activeMatch =
      process.platform === "win32"
        ? active.toLowerCase() === normalized.toLowerCase()
        : active === normalized;
    if (activeMatch) {
      void this.clearActiveWorkspace().catch(() => undefined);
    }
    saveDesktopPrefs(next);
    return recent;
  }

  listRecentWorkspaces(): string[] {
    const prefs = loadDesktopPrefs();
    // Return the full durable recent list **including** the live project.
    // The renderer rail already dedupes with workspacePath; excluding "current" here
    // caused sibling projects to vanish when switching from the composer project menu
    // (refresh replaced state with a list that dropped the previous current before it
    // was re-merged).
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of prefs.recentWorkspaces) {
      if (typeof item !== "string" || !item.trim()) continue;
      if (isNonProjectWorkspacePath(item)) continue;
      const key = normalizeRecentPathKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= 12) break;
    }
    return out;
  }

  start(options?: {
    cwd?: string;
    sessionFile?: string;
    resumeRecent?: boolean;
    force?: boolean;
  }): Promise<HostSnapshot> {
    return this.#exclusive(() => this.#startExclusive(options));
  }

  async #startExclusive(options?: {
    cwd?: string;
    sessionFile?: string;
    resumeRecent?: boolean;
    force?: boolean;
  }): Promise<HostSnapshot> {
    if (options?.cwd) {
      this.#workspaceCwd = options.cwd;
      this.#requireExplicitWorkspace = false;
      // Workspace change invalidates a pinned session unless the caller supplies one.
      if (options.sessionFile === undefined) this.#sessionFile = undefined;
    }
    if (options?.sessionFile !== undefined) this.#sessionFile = options.sessionFile;
    if (options?.resumeRecent !== undefined) this.#resumeRecent = options.resumeRecent;

    const live = this.#host && this.#snapshot && !this.#host.ignoreMessages && !this.#host.stopping;
    if (
      !options?.force &&
      live &&
      options?.sessionFile === undefined &&
      (!options?.cwd || normalizeHostCwd(this.#snapshot!.cwd) === normalizeHostCwd(options.cwd))
    ) {
      return this.#snapshot!;
    }

    // Only kill when explicitly forced or the workspace actually changes.
    const forceSpawn =
      Boolean(options?.force) ||
      Boolean(
        this.#host &&
        options?.cwd &&
        this.#snapshot &&
        normalizeHostCwd(this.#snapshot.cwd) !== normalizeHostCwd(options.cwd),
      );

    return this.#start(forceSpawn);
  }

  /**
   * Ensure utility process is up AND runtime handle exists (host.ready received).
   * Checking only `#host` is insufficient: the process can be mid-start with no handle yet.
   */
  async #ensureHostReady(): Promise<void> {
    if (this.#host && this.#snapshot && !this.#host.ignoreMessages && !this.#host.stopping) {
      return;
    }
    const zombie =
      Boolean(this.#host) &&
      !this.#snapshot &&
      !this.#host!.stopping &&
      !this.#host!.ignoreMessages;
    await this.#startExclusive({
      ...(this.#workspaceCwd ? { cwd: this.#workspaceCwd } : {}),
      force: zombie,
    });
  }

  async openWorkspace(
    cwd: string,
    options?: { resumeRecent?: boolean; sessionFile?: string },
  ): Promise<HostSnapshot> {
    return this.#exclusive(async () => {
      rememberWorkspace(cwd);

      // Already on this workspace host — no detach/restart.
      if (
        this.#host &&
        this.#snapshot &&
        !this.#host.stopping &&
        !this.#host.ignoreMessages &&
        normalizeHostCwdKey(this.#snapshot.cwd || this.#workspaceCwd || "") ===
          normalizeHostCwdKey(cwd)
      ) {
        this.#workspaceCwd = cwd;
        this.#requireExplicitWorkspace = false;
        if (options?.sessionFile) this.#sessionFile = options.sessionFile;
        return this.#snapshot;
      }

      // Re-focus a parked host for this exact session (busy or idle).
      if (options?.sessionFile) {
        const promoted = await this.#promoteParked(options.sessionFile);
        if (promoted && this.#snapshot) {
          this.#workspaceCwd = this.#snapshot.cwd || cwd;
          this.#requireExplicitWorkspace = false;
          this.#sessionFile = options.sessionFile;
          return this.#snapshot;
        }
      }

      // Re-focus any parked host for this cwd (same project / conversation home).
      // Renderer will session.switch to the target file if needed — no cold start.
      if (await this.#promoteParkedByCwd(cwd)) {
        if (this.#snapshot) {
          this.#workspaceCwd = this.#snapshot.cwd || cwd;
          this.#requireExplicitWorkspace = false;
          if (options?.sessionFile) this.#sessionFile = options.sessionFile;
          return this.#snapshot;
        }
      }

      this.#workspaceCwd = cwd;
      this.#requireExplicitWorkspace = false;
      // Prefer explicit session when switching into a project (avoids open→default→switch flicker).
      this.#sessionFile = options?.sessionFile;
      this.#resumeRecent = options?.resumeRecent === true && !options?.sessionFile;
      // Park current host (idle or busy) for later promote instead of killing it.
      await this.#detachForeground();
      // stop/park may have cleared pointers; re-assert intent.
      this.#sessionFile = options?.sessionFile;
      this.#resumeRecent = options?.resumeRecent === true && !options?.sessionFile;
      return this.#startExclusive({
        cwd,
        ...(options?.sessionFile ? { sessionFile: options.sessionFile } : {}),
        resumeRecent: options?.resumeRecent === true && !options?.sessionFile,
        force: true,
      });
    });
  }

  /**
   * Global "新建会话": detach from the live project session.
   * - Product: clear cwd so the next start requires an explicit project pick.
   * - Isolated/e2e (`PIX_WORKSPACE`): keep the fixture cwd for subsequent session.create.
   * Keeps the project on the recent list so it stays visible in the sidebar groups.
   */
  async clearActiveWorkspace(): Promise<void> {
    return this.#exclusive(() => this.#clearActiveExclusive());
  }

  async #clearActiveExclusive(): Promise<void> {
    const previous = this.#workspaceCwd;
    // Keep generating sessions alive in the background.
    await this.#detachForeground();
    this.#sessionFile = undefined;
    this.#snapshot = undefined;
    this.#host = undefined;
    this.#resumeRecent = false;
    const fixture = process.env.PIX_WORKSPACE;
    if (fixture) {
      this.#workspaceCwd = fixture;
      this.#requireExplicitWorkspace = false;
    } else {
      this.#workspaceCwd = undefined;
      this.#requireExplicitWorkspace = true;
      // Ensure the project remains in recent (was often only shown as "current").
      if (previous && !isNonProjectWorkspacePath(previous)) {
        rememberWorkspace(previous);
      }
    }
  }

  /**
   * Atomic「新建会话」for pure conversation: stop if needed, ensure conversation host,
   * create a new session. Rapid clicks serialize on #opQueue — no mid-start kills.
   */
  createBlankConversation(): Promise<{
    snapshot: HostSnapshot;
    threads: SessionThreadSummary[];
    history: SessionHistoryMessage[];
  }> {
    return this.#exclusive(async () => {
      const convCwd = process.env.PIX_WORKSPACE?.trim() || ensureConversationWorkspacePath();
      const alreadyOnConv =
        Boolean(this.#host && this.#snapshot) &&
        !this.#host!.stopping &&
        !this.#host!.ignoreMessages &&
        isConversationWorkspacePath(this.#snapshot!.cwd) &&
        normalizeHostCwd(this.#snapshot!.cwd) === normalizeHostCwd(convCwd);

      if (!alreadyOnConv) {
        // Park generating project sessions; do not abort them for a blank chat.
        await this.#clearActiveExclusive();
        // Fixture workspace (e2e) wins over conversation home when set.
        if (process.env.PIX_WORKSPACE?.trim()) {
          this.#workspaceCwd = process.env.PIX_WORKSPACE.trim();
          this.#requireExplicitWorkspace = false;
        } else {
          this.#workspaceCwd = convCwd;
          this.#requireExplicitWorkspace = false;
        }
        await this.#startExclusive({
          cwd: this.#workspaceCwd,
        });
      } else if (this.#isForegroundBusy()) {
        // Same conversation home but mid-turn: park and spawn a fresh host for new session.
        this.#parkForeground();
        await this.#startExclusive({
          cwd: this.#workspaceCwd ?? convCwd,
          force: true,
        });
      }

      return this.#newSessionExclusive();
    });
  }

  async #start(forceSpawn = false): Promise<HostSnapshot> {
    if (forceSpawn && this.#host) {
      // Prefer parking a generating host over killing mid-turn.
      if (!(this.#isForegroundBusy() && this.#parkForeground())) {
        this.#host.stopping = true;
        this.#host.ignoreMessages = true;
        this.#host.child.kill();
        await this.#host.exit.promise.catch(() => undefined);
        this.#host = undefined;
        this.#snapshot = undefined;
      }
    }
    const host = this.#host ?? this.#spawn();
    await Promise.race([
      host.hello.promise,
      delay(5_000).then(() => {
        throw new Error("Agent Host handshake timed out");
      }),
    ]);

    // Pi home state (packages/resources/settings) must work without a user project.
    // Prefer supervisor workspace (set by openPath / start options) over PIX_WORKSPACE
    // so e2e/product can switch projects even when PIX_WORKSPACE is set for fixtures.
    // Fallback: PIX_WORKSPACE → last durable project → Documents/Pix/YYYY-MM-DD scratch.
    const cwd =
      this.#workspaceCwd ??
      process.env.PIX_WORKSPACE ??
      (this.#requireExplicitWorkspace
        ? undefined
        : durableWorkspacePath(loadDesktopPrefs().lastWorkspace)) ??
      ensureDefaultWorkspacePath();
    this.#workspaceCwd = cwd;
    rememberWorkspace(cwd);
    const command: HostCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "host.start",
      requestId: randomUUID(),
      cwd,
    };
    // Share CLI config: only override agentDir/model/tools when explicitly set
    // (isolated/e2e). Product omits them → pi getAgentDir() + default tools/models.
    if (process.env.PI_CODING_AGENT_DIR) command.agentDir = process.env.PI_CODING_AGENT_DIR;
    const modelProvider = process.env.PIX_MODEL_PROVIDER;
    const modelId = process.env.PIX_MODEL_ID;
    if (modelProvider && modelId) command.model = { provider: modelProvider, id: modelId };
    if (process.env.PIX_TOOLS) {
      command.tools = process.env.PIX_TOOLS.split(",").map((tool) => tool.trim());
    }
    if (this.#sessionFile) command.sessionFile = this.#sessionFile;
    // Persist sessions like the CLI unless explicitly disabled.
    else if (process.env.PIX_PERSIST_SESSION !== "0") command.persistSession = true;
    if (this.#resumeRecent && !this.#sessionFile) command.resumeRecent = true;

    const event = await this.#request(command);
    if (event.type !== "host.ready")
      throw new Error("Agent Host returned an unexpected start response");
    this.#acceptSnapshot(event.snapshot);
    this.#resumeRecent = false;

    if (this.#previousRuntimeId) {
      const restarted: HostEvent = {
        protocolVersion: IPC_PROTOCOL_VERSION,
        type: "host.restarted",
        hostId: host.hostId,
        previousRuntimeId: this.#previousRuntimeId,
        snapshot: event.snapshot,
      };
      this.#previousRuntimeId = undefined;
      this.#emit(restarted);
    }
    return event.snapshot;
  }

  async snapshot(): Promise<HostSnapshot> {
    if (!this.#host) return this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "host.snapshot",
      requestId: randomUUID(),
    });
    if (event.type !== "runtime.snapshot")
      throw new Error("Agent Host returned an unexpected snapshot response");
    this.#acceptSnapshot(event.snapshot);
    return event.snapshot;
  }

  async prompt(
    message: string,
    streamingBehavior?: "steer" | "followUp",
    imagePaths?: string[],
  ): Promise<HostSnapshot> {
    if (!this.#host) await this.start();
    const boundHost = this.#host;
    const command: HostCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "agent.prompt",
      requestId: randomUUID(),
      message,
    };
    if (streamingBehavior) command.streamingBehavior = streamingBehavior;
    if (imagePaths?.length) command.imagePaths = imagePaths.slice(0, 12);
    const event = await this.#request(command);
    if (event.type !== "runtime.snapshot")
      throw new Error("Agent Host returned an unexpected prompt response");
    // If the user switched away mid-turn, this host may now be parked — do not
    // clobber the foreground snapshot with the background session's result.
    if (this.#host === boundHost) {
      this.#acceptSnapshot(event.snapshot);
    }
    return event.snapshot;
  }

  async clearQueue(): Promise<HostSnapshot> {
    if (!this.#host) throw new Error("Agent Host is not running");
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "agent.queue.clear",
      requestId: randomUUID(),
    });
    if (event.type !== "runtime.snapshot")
      throw new Error("Agent Host returned an unexpected queue response");
    this.#acceptSnapshot(event.snapshot);
    return event.snapshot;
  }

  async abort(): Promise<HostSnapshot> {
    if (!this.#host) throw new Error("Agent Host is not running");
    try {
      const event = await this.#request({
        protocolVersion: IPC_PROTOCOL_VERSION,
        type: "agent.abort",
        requestId: randomUUID(),
      });
      if (event.type !== "runtime.snapshot")
        throw new Error("Agent Host returned an unexpected abort response");
      this.#acceptSnapshot(event.snapshot);
      return event.snapshot;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : "";
      if (!/timed out/i.test(message)) throw error;
      // Host is hard-stuck (event loop blocked or abort never idles). Kill without
      // parking so the next prompt is not blocked by a ghost mid-turn, then reopen
      // the same session file when we have one.
      return this.#exclusive(async () => this.#recycleAfterAbortTimeout());
    }
  }

  /** Hard-kill the foreground host and reopen the current session after abort IPC timeout. */
  async #recycleAfterAbortTimeout(): Promise<HostSnapshot> {
    const sessionFile = this.#sessionFile ?? this.#snapshot?.sessionFile;
    const cwd = this.#workspaceCwd ?? this.#snapshot?.cwd;
    const runtimeId = this.#snapshot?.runtimeId;
    const host = this.#host;
    if (host) {
      if (runtimeId) this.#previousRuntimeId = runtimeId;
      host.stopping = true;
      host.ignoreMessages = true;
      this.#rejectPending(new Error("Agent Host recycled after abort timeout"));
      try {
        host.child.kill();
      } catch {
        // already dead
      }
      await host.exit.promise.catch(() => undefined);
      if (this.#host === host) this.#host = undefined;
      this.#snapshot = undefined;
    }
    return this.#startExclusive({
      ...(cwd ? { cwd } : {}),
      ...(sessionFile ? { sessionFile } : {}),
      force: true,
    });
  }

  async listSessions(): Promise<{ threads: SessionThreadSummary[]; activeSessionId?: string }> {
    return this.#exclusive(async () => {
      await this.#ensureHostReady();
      const event = await this.#request({
        protocolVersion: IPC_PROTOCOL_VERSION,
        type: "session.list",
        requestId: randomUUID(),
      });
      if (event.type !== "session.list")
        throw new Error("Agent Host returned an unexpected session list response");
      const result: { threads: SessionThreadSummary[]; activeSessionId?: string } = {
        threads: event.threads,
      };
      if (event.activeSessionId !== undefined) result.activeSessionId = event.activeSessionId;
      return result;
    });
  }

  async newSession(): Promise<{
    snapshot: HostSnapshot;
    threads: SessionThreadSummary[];
    history: SessionHistoryMessage[];
  }> {
    return this.#exclusive(async () => {
      // Park a generating turn before session.new tears down the runtime.
      if (this.#isForegroundBusy()) {
        this.#parkForeground();
      }
      await this.#ensureHostReady();
      return this.#newSessionExclusive();
    });
  }

  async #newSessionExclusive(): Promise<{
    snapshot: HostSnapshot;
    threads: SessionThreadSummary[];
    history: SessionHistoryMessage[];
  }> {
    // session.new tears down the live runtime — park a generating turn first.
    if (this.#isForegroundBusy()) {
      this.#parkForeground();
      await this.#ensureHostReady();
    }
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.new",
      requestId: randomUUID(),
    });
    if (event.type !== "session.opened")
      throw new Error("Agent Host returned an unexpected session.new response");
    this.#acceptSnapshot(event.snapshot);
    return { snapshot: event.snapshot, threads: event.threads, history: event.history };
  }

  switchSession(sessionPath: string): Promise<{
    snapshot: HostSnapshot;
    threads: SessionThreadSummary[];
    history: SessionHistoryMessage[];
  }> {
    return this.#exclusive(() => this.#switchSessionExclusive(sessionPath));
  }

  async #switchSessionExclusive(sessionPath: string): Promise<{
    snapshot: HostSnapshot;
    threads: SessionThreadSummary[];
    history: SessionHistoryMessage[];
  }> {
    // Already showing this session.
    const currentKey = sessionKeyFromSnapshot(this.#snapshot);
    if (
      currentKey &&
      (currentKey === normalizeSessionKey(sessionPath) ||
        (this.#snapshot?.sessionFile &&
          normalizeSessionKey(this.#snapshot.sessionFile) === normalizeSessionKey(sessionPath)))
    ) {
      return this.#openCurrentSessionProjection();
    }

    // Re-focus a session still generating in a parked host (tab-like switch).
    if (await this.#promoteParked(sessionPath)) {
      const opened = await this.#openCurrentSessionProjection();
      if (opened.snapshot.cwd) {
        this.#workspaceCwd = opened.snapshot.cwd;
        this.#requireExplicitWorkspace = false;
        this.#sessionFile = opened.snapshot.sessionFile ?? sessionPath;
        rememberWorkspace(opened.snapshot.cwd);
      }
      return opened;
    }

    // Foreground is mid-turn: park it and open the target on a fresh host.
    // switchSession on a busy runtime would dispose/abort the live agent.
    if (this.#isForegroundBusy()) {
      this.#parkForeground();
    }

    // Ensure a live runtime exists. Prefer opening the target session file directly
    // so we do not start a throwaway session then switch (flash + missing history).
    if (!this.#host || !this.#snapshot) {
      this.#sessionFile = sessionPath;
      this.#requireExplicitWorkspace = false;
      // Use #startExclusive — already inside #exclusive; do not re-enter via start().
      await this.#startExclusive({
        ...(this.#workspaceCwd ? { cwd: this.#workspaceCwd } : {}),
        sessionFile: sessionPath,
        force: true,
      });
      // host.start with sessionFile already bound the target — project it.
      if (
        this.#snapshot?.sessionFile &&
        normalizeSessionKey(this.#snapshot.sessionFile) === normalizeSessionKey(sessionPath)
      ) {
        const opened = await this.#openCurrentSessionProjection();
        if (opened.snapshot.cwd) {
          this.#workspaceCwd = opened.snapshot.cwd;
          this.#requireExplicitWorkspace = false;
          this.#sessionFile = opened.snapshot.sessionFile ?? sessionPath;
          rememberWorkspace(opened.snapshot.cwd);
        }
        return opened;
      }
    }

    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.switch",
      requestId: randomUUID(),
      sessionPath,
    });
    if (event.type !== "session.opened")
      throw new Error("Agent Host returned an unexpected session.switch response");
    this.#acceptSnapshot(event.snapshot);
    // Keep supervisor workspace pointer aligned with the session's project cwd.
    if (event.snapshot.cwd) {
      this.#workspaceCwd = event.snapshot.cwd;
      this.#requireExplicitWorkspace = false;
      this.#sessionFile = event.snapshot.sessionFile ?? sessionPath;
      rememberWorkspace(event.snapshot.cwd);
    }
    return { snapshot: event.snapshot, threads: event.threads, history: event.history };
  }

  async forkSession(entryId?: string): Promise<{
    snapshot: HostSnapshot;
    threads: SessionThreadSummary[];
    history: SessionHistoryMessage[];
    selectedText?: string;
  }> {
    if (!this.#host) await this.start();
    const command: HostCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.fork",
      requestId: randomUUID(),
    };
    if (entryId !== undefined) command.entryId = entryId;
    const event = await this.#request(command);
    if (event.type !== "session.opened")
      throw new Error("Agent Host returned an unexpected session.fork response");
    this.#acceptSnapshot(event.snapshot);
    return {
      snapshot: event.snapshot,
      threads: event.threads,
      history: event.history,
      ...(event.selectedText !== undefined ? { selectedText: event.selectedText } : {}),
    };
  }

  async sessionTree(): Promise<SessionTreeView> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.tree",
      requestId: randomUUID(),
    });
    if (event.type !== "session.tree")
      throw new Error("Agent Host returned an unexpected session.tree response");
    return event.tree;
  }

  async navigateSessionTree(
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string },
  ): Promise<{
    snapshot: HostSnapshot;
    threads: SessionThreadSummary[];
    history: SessionHistoryMessage[];
    cancelled: boolean;
    selectedText?: string;
  }> {
    if (!this.#host) await this.start();
    const command: HostCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.navigateTree",
      requestId: randomUUID(),
      targetId,
    };
    if (options?.summarize !== undefined) command.summarize = options.summarize;
    if (options?.customInstructions) command.customInstructions = options.customInstructions;
    const event = await this.#request(command);
    if (event.type !== "session.opened")
      throw new Error("Agent Host returned an unexpected session.navigateTree response");
    if (!event.cancelled) this.#acceptSnapshot(event.snapshot);
    return {
      snapshot: event.snapshot,
      threads: event.threads,
      history: event.history,
      cancelled: event.cancelled === true,
      ...(event.selectedText !== undefined ? { selectedText: event.selectedText } : {}),
    };
  }

  async compactSession(instructions?: string): Promise<HostSnapshot> {
    if (!this.#host) await this.start();
    const command: HostCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.compact",
      requestId: randomUUID(),
    };
    if (instructions !== undefined) command.instructions = instructions;
    const event = await this.#request(command);
    if (event.type !== "runtime.snapshot")
      throw new Error("Agent Host returned an unexpected session.compact response");
    this.#acceptSnapshot(event.snapshot);
    return event.snapshot;
  }

  async setSessionName(name: string): Promise<HostSnapshot> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.setName",
      requestId: randomUUID(),
      name,
    });
    if (event.type !== "runtime.snapshot")
      throw new Error("Agent Host returned an unexpected session.setName response");
    this.#acceptSnapshot(event.snapshot);
    return event.snapshot;
  }

  async cloneSession(): Promise<{
    snapshot: HostSnapshot;
    threads: SessionThreadSummary[];
    history: SessionHistoryMessage[];
  }> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.clone",
      requestId: randomUUID(),
    });
    if (event.type !== "session.opened")
      throw new Error("Agent Host returned an unexpected session.clone response");
    this.#acceptSnapshot(event.snapshot);
    return { snapshot: event.snapshot, threads: event.threads, history: event.history };
  }

  async sessionInfo(): Promise<SessionInfoView> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.info",
      requestId: randomUUID(),
    });
    if (event.type !== "session.info")
      throw new Error("Agent Host returned an unexpected session.info response");
    return event.info;
  }

  async exportSession(format: "html" | "jsonl", outputPath?: string): Promise<SessionExportResult> {
    if (!this.#host) await this.start();
    const command: HostCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.export",
      requestId: randomUUID(),
      format,
    };
    if (outputPath !== undefined) command.outputPath = outputPath;
    const event = await this.#request(command);
    if (event.type !== "session.export")
      throw new Error("Agent Host returned an unexpected session.export response");
    return event.result;
  }

  async importSession(
    inputPath: string,
    cwdOverride?: string,
  ): Promise<
    | {
        snapshot: HostSnapshot;
        threads: SessionThreadSummary[];
        history: SessionHistoryMessage[];
      }
    | undefined
  > {
    if (!this.#host) await this.start();
    const resolvedInputPath = isAbsolute(inputPath)
      ? inputPath
      : resolve(this.#workspaceCwd ?? process.cwd(), inputPath);
    const command: HostCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.import",
      requestId: randomUUID(),
      inputPath: resolvedInputPath,
    };
    if (cwdOverride) command.cwdOverride = cwdOverride;
    let event: HostEvent;
    try {
      event = await this.#request(command);
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "SESSION_IMPORT_CWD_MISSING" || cwdOverride) throw error;
      if (this.window.isClosed()) return undefined;
      const picked = await dialog.showOpenDialog(this.window, {
        title: "Choose a workspace for the imported session",
        buttonLabel: "Use this workspace",
        properties: ["openDirectory", "createDirectory"],
        ...(error instanceof Error ? { message: error.message } : {}),
        ...(this.#workspaceCwd ? { defaultPath: this.#workspaceCwd } : {}),
      });
      const selectedCwd = picked.filePaths[0];
      if (picked.canceled || !selectedCwd) return undefined;
      return this.importSession(resolvedInputPath, selectedCwd);
    }
    if (event.type !== "session.opened")
      throw new Error("Agent Host returned an unexpected session.import response");
    this.#acceptSnapshot(event.snapshot);
    if (event.snapshot.cwd) {
      this.#workspaceCwd = event.snapshot.cwd;
      this.#requireExplicitWorkspace = false;
      this.#sessionFile = event.snapshot.sessionFile;
      rememberWorkspace(event.snapshot.cwd);
    }
    return { snapshot: event.snapshot, threads: event.threads, history: event.history };
  }

  async sessionBash(
    commandText: string,
    options?: { excludeFromContext?: boolean },
  ): Promise<{ result: SessionBashResult; snapshot: HostSnapshot }> {
    if (!this.#host) await this.start();
    const command: HostCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.bash",
      requestId: randomUUID(),
      command: commandText,
    };
    if (options?.excludeFromContext !== undefined) {
      command.excludeFromContext = options.excludeFromContext;
    }
    const event = await this.#request(command);
    if (event.type !== "session.bash")
      throw new Error("Agent Host returned an unexpected session.bash response");
    this.#acceptSnapshot(event.snapshot);
    return { result: event.result, snapshot: event.snapshot };
  }

  async copyLastAssistant(): Promise<string | undefined> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.copyLast",
      requestId: randomUUID(),
    });
    if (event.type !== "session.copyLast")
      throw new Error("Agent Host returned an unexpected session.copyLast response");
    return event.text;
  }

  async shareSession(): Promise<SessionShareResult> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "session.share",
      requestId: randomUUID(),
    });
    if (event.type !== "session.share")
      throw new Error("Agent Host returned an unexpected session.share response");
    return event.result;
  }

  async reloadRuntime(): Promise<HostSnapshot> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "runtime.reload",
      requestId: randomUUID(),
    });
    if (event.type !== "runtime.snapshot")
      throw new Error("Agent Host returned an unexpected runtime.reload response");
    this.#acceptSnapshot(event.snapshot);
    return event.snapshot;
  }

  async exportSessionPick(format: "html" | "jsonl"): Promise<SessionExportResult | undefined> {
    if (!mainWindow || mainWindow.isClosed()) return undefined;
    const result = await dialog.showSaveDialog(mainWindow, {
      title: format === "html" ? "Export session HTML" : "Export session JSONL",
      defaultPath: format === "html" ? "session.html" : "session.jsonl",
      filters:
        format === "html"
          ? [{ name: "HTML", extensions: ["html", "htm"] }]
          : [{ name: "JSONL", extensions: ["jsonl"] }],
    });
    if (result.canceled || !result.filePath) return undefined;
    return this.exportSession(format, result.filePath);
  }

  async importSessionPick(): Promise<
    | {
        snapshot: HostSnapshot;
        threads: SessionThreadSummary[];
        history: SessionHistoryMessage[];
      }
    | undefined
  > {
    if (!mainWindow || mainWindow.isClosed()) return undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import session JSONL",
      properties: ["openFile"],
      filters: [{ name: "JSONL", extensions: ["jsonl"] }],
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    return this.importSession(result.filePaths[0]);
  }

  async listScopedModels(): Promise<ScopedModelView[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "models.scoped.list",
      requestId: randomUUID(),
    });
    if (event.type !== "models.scoped")
      throw new Error("Agent Host returned an unexpected models.scoped.list response");
    return event.models;
  }

  async refreshModelCatalog(): Promise<ModelSummary[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "models.refresh",
      requestId: randomUUID(),
    });
    if (event.type !== "model.list")
      throw new Error("Agent Host returned an unexpected models.refresh response");
    return event.models;
  }

  async listPackages(): Promise<PackageSummary[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "packages.list",
      requestId: randomUUID(),
    });
    if (event.type !== "packages.list")
      throw new Error("Agent Host returned an unexpected packages.list response");
    return event.packages;
  }

  async installPackage(
    source: string,
    scope: "global" | "project",
    options?: { temporary?: boolean },
  ): Promise<PackageSummary[]> {
    if (!this.#host) await this.start();
    const command: HostCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "packages.install",
      requestId: randomUUID(),
      source,
      scope,
    };
    if (options?.temporary) command.temporary = true;
    const event = await this.#request(command);
    if (event.type !== "packages.changed")
      throw new Error("Agent Host returned an unexpected packages.install response");
    return event.packages;
  }

  async setPackageEnabled(
    source: string,
    scope: "global" | "project",
    enabled: boolean,
  ): Promise<PackageSummary[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "packages.setEnabled",
      requestId: randomUUID(),
      source,
      scope,
      enabled,
    });
    if (event.type !== "packages.changed")
      throw new Error("Agent Host returned an unexpected packages.setEnabled response");
    return event.packages;
  }

  async removePackage(source: string, scope: "global" | "project"): Promise<PackageSummary[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "packages.remove",
      requestId: randomUUID(),
      source,
      scope,
    });
    if (event.type !== "packages.changed")
      throw new Error("Agent Host returned an unexpected packages.remove response");
    return event.packages;
  }

  async updatePackage(source?: string): Promise<PackageSummary[]> {
    if (!this.#host) await this.start();
    const command: HostCommand = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "packages.update",
      requestId: randomUUID(),
    };
    if (source !== undefined) command.source = source;
    const event = await this.#request(command);
    if (event.type !== "packages.changed")
      throw new Error("Agent Host returned an unexpected packages.update response");
    return event.packages;
  }

  async checkPackageUpdates(): Promise<PackageUpdateInfo[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "packages.checkUpdates",
      requestId: randomUUID(),
    });
    if (event.type !== "packages.updates")
      throw new Error("Agent Host returned an unexpected packages.checkUpdates response");
    return event.updates;
  }

  async listResources(): Promise<ResourceSummary[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "resources.list",
      requestId: randomUUID(),
    });
    if (event.type !== "resources.list")
      throw new Error("Agent Host returned an unexpected resources.list response");
    return event.resources;
  }

  async getTrust(): Promise<ProjectTrustSummary> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "trust.get",
      requestId: randomUUID(),
    });
    if (event.type !== "trust.info")
      throw new Error("Agent Host returned an unexpected trust.get response");
    return event.trust;
  }

  async setTrust(trusted: boolean): Promise<HostSnapshot> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "trust.set",
      requestId: randomUUID(),
      trusted,
    });
    if (event.type !== "runtime.snapshot")
      throw new Error("Agent Host returned an unexpected trust.set response");
    this.#acceptSnapshot(event.snapshot);
    return event.snapshot;
  }

  async listModels(): Promise<ModelSummary[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "model.list",
      requestId: randomUUID(),
    });
    if (event.type !== "model.list")
      throw new Error("Agent Host returned an unexpected model.list response");
    return event.models;
  }

  async completeText(
    prompt: string,
    options?: { systemPrompt?: string; model?: { provider: string; id: string } },
  ): Promise<string> {
    if (!this.#host) await this.start();
    const command = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "util.complete-text" as const,
      requestId: randomUUID(),
      prompt,
      ...(options?.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(options?.model ? { model: options.model } : {}),
    } satisfies HostCommand;
    const event = await this.#request(command);
    if (event.type !== "util.text")
      throw new Error("Agent Host returned an unexpected util.complete-text response");
    return event.text;
  }

  async setModel(provider: string, id: string): Promise<HostSnapshot> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "model.set",
      requestId: randomUUID(),
      provider,
      id,
    });
    if (event.type !== "runtime.snapshot")
      throw new Error("Agent Host returned an unexpected model.set response");
    this.#acceptSnapshot(event.snapshot);
    return event.snapshot;
  }

  async getModelsJsonConfig(): Promise<ModelsJsonConfigView> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "models.config.get",
      requestId: randomUUID(),
    });
    if (event.type !== "models.config")
      throw new Error("Agent Host returned an unexpected models.config.get response");
    return event.config;
  }

  async upsertCustomProvider(input: UpsertCustomProviderInput): Promise<ModelsJsonConfigView> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "models.config.upsert",
      requestId: randomUUID(),
      input,
    });
    if (event.type !== "models.config")
      throw new Error("Agent Host returned an unexpected models.config.upsert response");
    return event.config;
  }

  async removeCustomProvider(provider: string): Promise<ModelsJsonConfigView> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "models.config.remove",
      requestId: randomUUID(),
      provider,
    });
    if (event.type !== "models.config")
      throw new Error("Agent Host returned an unexpected models.config.remove response");
    return event.config;
  }

  async removeCustomModel(provider: string, modelId: string): Promise<ModelsJsonConfigView> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "models.config.remove-model",
      requestId: randomUUID(),
      provider,
      modelId,
    });
    if (event.type !== "models.config") {
      throw new Error("Agent Host returned an unexpected models.config.remove-model response");
    }
    return event.config;
  }

  async #resolveAgentDir(): Promise<string> {
    if (this.#snapshot?.agentDir) return this.#snapshot.agentDir;
    if (process.env.PI_CODING_AGENT_DIR?.trim()) return process.env.PI_CODING_AGENT_DIR.trim();
    return (await this.start()).agentDir;
  }

  /** Ensure models.json exists and open it with the OS default app. */
  async openModelsJson(): Promise<void> {
    const agentDir = await this.#resolveAgentDir();
    const { ensureModelsJsonTemplate } = await import("@pix/agent-runtime");
    const path = await ensureModelsJsonTemplate(agentDir);
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  }

  async revealModelsJson(): Promise<void> {
    const agentDir = await this.#resolveAgentDir();
    const { ensureModelsJsonTemplate } = await import("@pix/agent-runtime");
    const path = await ensureModelsJsonTemplate(agentDir);
    await shell.showItemInFolder(path);
  }

  async setThinkingLevel(level: string): Promise<HostSnapshot> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "thinking.set",
      requestId: randomUUID(),
      level,
    });
    if (event.type !== "runtime.snapshot")
      throw new Error("Agent Host returned an unexpected thinking.set response");
    this.#acceptSnapshot(event.snapshot);
    return event.snapshot;
  }

  async setServiceTier(tier: string): Promise<HostSnapshot> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "serviceTier.set",
      requestId: randomUUID(),
      tier,
    });
    if (event.type !== "runtime.snapshot")
      throw new Error("Agent Host returned an unexpected serviceTier.set response");
    this.#acceptSnapshot(event.snapshot);
    return event.snapshot;
  }

  async listProviders(): Promise<ProviderAuthSummary[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "providers.list",
      requestId: randomUUID(),
    });
    if (event.type !== "providers.list")
      throw new Error("Agent Host returned an unexpected providers.list response");
    return event.providers;
  }

  async listProviderUsage(): Promise<ProviderUsageSnapshot[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "providers.usage",
      requestId: randomUUID(),
    });
    if (event.type !== "providers.usage") {
      throw new Error("Agent Host returned an unexpected providers.usage response");
    }
    return event.usage;
  }

  async setProviderApiKey(provider: string, apiKey: string): Promise<ProviderAuthSummary[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "providers.setApiKey",
      requestId: randomUUID(),
      provider,
      apiKey,
    });
    if (event.type !== "providers.list")
      throw new Error("Agent Host returned an unexpected providers.setApiKey response");
    return event.providers;
  }

  async clearProviderAuth(provider: string): Promise<ProviderAuthSummary[]> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "providers.clearAuth",
      requestId: randomUUID(),
      provider,
    });
    if (event.type !== "providers.list")
      throw new Error("Agent Host returned an unexpected providers.clearAuth response");
    return event.providers;
  }

  async startProviderOAuth(provider: string, requestedOperationId?: string): Promise<string> {
    if (!this.#host) await this.start();
    const operationId = requestedOperationId || randomUUID();
    void this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "providers.oauth.start",
      requestId: operationId,
      provider,
    }).catch((error: unknown) => {
      this.#emit({
        protocolVersion: IPC_PROTOCOL_VERSION,
        type: "providers.oauth",
        requestId: operationId,
        provider,
        update: {
          stage: "error",
          message: error instanceof Error ? error.message : "OAuth login failed",
        },
      });
    });
    return operationId;
  }

  async respondProviderOAuth(
    operationId: string,
    promptId: string,
    value?: string,
    cancelled?: boolean,
  ): Promise<void> {
    this.#send({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "providers.oauth.respond",
      requestId: randomUUID(),
      operationId,
      promptId,
      ...(value !== undefined ? { value } : {}),
      ...(cancelled !== undefined ? { cancelled } : {}),
    });
  }

  async cancelProviderOAuth(operationId: string): Promise<void> {
    this.#send({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "providers.oauth.cancel",
      requestId: randomUUID(),
      operationId,
    });
  }

  async getPiSettings(): Promise<PiSettingsView> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "settings.get",
      requestId: randomUUID(),
    });
    if (event.type !== "settings.view")
      throw new Error("Agent Host returned an unexpected settings.get response");
    return event.settings;
  }

  async patchPiSettings(patch: PiSettingsPatch): Promise<PiSettingsPatchResult> {
    if (!this.#host) await this.start();
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "settings.patch",
      requestId: randomUUID(),
      patch,
    });
    if (event.type !== "settings.view")
      throw new Error("Agent Host returned an unexpected settings.patch response");
    if (!event.snapshot) throw new Error("Agent Host omitted the settings snapshot");
    this.#acceptSnapshot(event.snapshot);
    return { settings: event.settings, snapshot: event.snapshot };
  }

  eventCounts(): Record<string, number> {
    return Object.fromEntries(this.#eventCounts);
  }

  armCrashOnEvent(eventType: string): void {
    if (process.env.PIX_ENABLE_TEST_COMMANDS !== "1") {
      throw new Error("Test crash commands are disabled");
    }
    this.#crashOnEvent = eventType;
  }

  async extensionUiRespond(response: ExtensionUiResponse): Promise<void> {
    const host = this.#host;
    if (!host || host.ignoreMessages || response.runtimeId !== this.#snapshot?.runtimeId) {
      throw new Error("Rejected stale Extension UI response");
    }
    host.child.send({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "extensionUi.respond",
      requestId: randomUUID(),
      runtimeId: response.runtimeId,
      response,
    } satisfies HostCommand);
  }

  async photonProbe(imagePath: string): Promise<PhotonProbeResult> {
    if (process.env.PIX_ENABLE_TEST_COMMANDS !== "1") {
      throw new Error("Photon probe command is disabled");
    }
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "test.photonProbe",
      requestId: randomUUID(),
      imagePath,
    });
    if (event.type !== "test.photonResult") {
      throw new Error("Agent Host returned an unexpected photon probe response");
    }
    return event.result;
  }

  async probeSequenceGap(): Promise<HostSnapshot> {
    if (process.env.PIX_ENABLE_TEST_COMMANDS !== "1") {
      throw new Error("Sequence gap command is disabled");
    }
    const event = await this.#request({
      protocolVersion: IPC_PROTOCOL_VERSION,
      type: "test.sequenceGap",
      requestId: randomUUID(),
    });
    if (event.type !== "runtime.snapshot") {
      throw new Error("Agent Host returned an unexpected sequence gap response");
    }
    this.#acceptSnapshot(event.snapshot);
    return event.snapshot;
  }

  async crashHost(): Promise<void> {
    if (process.env.PIX_ENABLE_TEST_COMMANDS !== "1") {
      throw new Error("Test crash commands are disabled");
    }
    const host = this.#host;
    if (!host) throw new Error("Agent Host is not running");
    host.ignoreMessages = true;
    host.child.kill();
    await host.exit.promise;
  }

  async stop(): Promise<void> {
    return this.#exclusive(async () => {
      // Explicit stop tears down parked generators too (app quit / host stop).
      const parked = [...this.#parked.values()];
      for (const entry of parked) {
        await this.#killParked(entry, "stop");
      }
      await this.#stopExclusive();
    });
  }

  async #stopExclusive(): Promise<void> {
    const host = this.#host;
    if (!host) return;
    host.stopping = true;
    try {
      await this.#request({
        protocolVersion: IPC_PROTOCOL_VERSION,
        type: "host.shutdown",
        requestId: randomUUID(),
      });
    } finally {
      host.ignoreMessages = true;
      host.child.kill();
      await host.exit.promise.catch(() => undefined);
      if (this.#host === host) this.#host = undefined;
      this.#snapshot = undefined;
      this.#rejectPending(new Error("Agent Host stopped"));
    }
  }

  #spawn(): ActiveHost {
    // Sync path: env may be incomplete for global until #spawnAsync is used.
    // Callers that need accurate global SDK should use #spawnWithSdkEnv.
    return this.#spawnWithEnv(processEnvironment());
  }

  #spawnWithEnv(env: Record<string, string>): ActiveHost {
    const hostEntry = resolveAgentHostEntry(currentDirectory);
    const child = forkAgent(hostEntry, env);
    const host: ActiveHost = {
      child,
      hostId: randomUUID(),
      hello: deferred<void>(),
      exit: deferred<number>(),
      ignoreMessages: false,
      stopping: false,
      stderr: "",
    };
    this.#host = host;

    // Surface host stdout/stderr so "exited with code 1" failures are diagnosable.
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk).trim();
      if (text) console.log(`[agent-host:${host.hostId.slice(0, 8)}] ${text}`);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      host.stderr = `${host.stderr}${text}`.slice(-8000);
      const trimmed = text.trim();
      if (trimmed) console.warn(`[agent-host:${host.hostId.slice(0, 8)}] ${trimmed}`);
    });

    child.on("message", (message) => {
      if (host.ignoreMessages || !isHostEvent(message)) return;
      const isForeground = this.#host === host;
      const parked = isForeground ? undefined : this.#findParkedByHost(host);
      if (!isForeground && !parked) return;

      if (message.type === "host.hello") host.hello.resolve();

      if (isForeground) {
        if (message.type === "host.ready" || message.type === "runtime.snapshot") {
          this.#acceptSnapshot(message.snapshot);
        }
        if (message.type === "runtime.event") {
          if (this.#snapshot && message.runtimeId !== this.#snapshot.runtimeId) return;
          if (message.sequence !== this.#lastSequence + 1) {
            this.#count("runtime.gap");
            void this.snapshot().catch(() => undefined);
            return;
          }
          this.#lastSequence = message.sequence;
          this.#count(message.event.type);
        }
      } else if (parked) {
        // Background host: keep snapshot/sequence coherent for promote, resolve pending.
        if (message.type === "host.ready" || message.type === "runtime.snapshot") {
          parked.snapshot = message.snapshot;
          parked.lastSequence = message.snapshot.sequence;
          if (message.snapshot.sessionFile) {
            parked.sessionKey = normalizeSessionKey(message.snapshot.sessionFile);
          }
        }
        if (message.type === "runtime.event") {
          if (message.runtimeId !== parked.snapshot.runtimeId) return;
          if (message.sequence === parked.lastSequence + 1) {
            parked.lastSequence = message.sequence;
          }
          this.#count(message.event.type);
        }
      }

      if (message.type === "extensionUi.request") {
        this.#count("extensionUi.request");
        // Only auto-answer / surface extension UI for the foreground host.
        if (!isForeground) return;
        if (process.env.PIX_AUTO_EXTENSION_UI === "1") {
          const args =
            typeof message.args === "object" && message.args !== null
              ? (message.args as Record<string, unknown>)
              : {};
          const value =
            message.method === "confirm"
              ? true
              : message.method === "select" && Array.isArray(args.options)
                ? args.options[0]
                : message.method === "input" || message.method === "editor"
                  ? "pix-test-input"
                  : undefined;
          host.child.send({
            protocolVersion: IPC_PROTOCOL_VERSION,
            type: "extensionUi.respond",
            requestId: randomUUID(),
            runtimeId: message.runtimeId,
            response: {
              runtimeId: message.runtimeId,
              requestId: message.requestId,
              ok: true,
              value,
            },
          } satisfies HostCommand);
        }
      }

      // Foreground events go to the renderer as today. Parked hosts forward
      // turn/tool/retry events so sidebar markers and promote reconnect stay live.
      if (isForeground) {
        this.#emit(message, false);
      } else if (
        message.type === "runtime.event" &&
        shouldForwardParkedRuntimeEvent(message.event.type)
      ) {
        this.#emit(message, false);
      }

      // Streaming events share the parent requestId but are not the final response.
      if (message.type !== "packages.progress" && message.type !== "providers.oauth") {
        this.#resolvePendingFor(host, message, parked);
      }

      if (
        isForeground &&
        message.type === "runtime.event" &&
        message.event.type === this.#crashOnEvent
      ) {
        this.#crashOnEvent = undefined;
        host.ignoreMessages = true;
        host.child.kill();
      }
    });

    child.on("exit", (code) => {
      const exitCode = code ?? -1;
      host.exit.resolve(exitCode);
      const finalize = () => this.#onHostProcessExit(host, exitCode);
      // Clear the dead host before resolving the next lifecycle RPC.
      finalize();
    });
    return host;
  }

  #onHostProcessExit(host: ActiveHost, exitCode: number): void {
    const parked = this.#findParkedByHost(host);
    const error = host.stopping
      ? new Error("Agent Host was replaced or stopped")
      : formatHostExitError(exitCode, host.stderr);
    if (parked) {
      this.#disarmIdleReap(parked);
      this.#parked.delete(parked.sessionKey);
      for (const [key, value] of this.#parked) {
        if (value === parked) this.#parked.delete(key);
      }
      host.hello.reject(error);
      for (const waiter of parked.pending.values()) {
        clearPendingTimeout(waiter);
        waiter.reject(error);
      }
      parked.pending.clear();
      if (!host.stopping) {
        const crashed: HostEvent = {
          protocolVersion: IPC_PROTOCOL_VERSION,
          type: "host.crashed",
          hostId: host.hostId,
          exitCode,
          message: `Background Agent Host exited unexpectedly with code ${exitCode}`,
        };
        if (host.stderr.trim()) crashed.message = error.message;
        if (parked.snapshot.runtimeId) crashed.runtimeId = parked.snapshot.runtimeId;
        this.#emit(crashed);
      }
      return;
    }
    if (this.#host !== host) return;
    this.#host = undefined;
    const runtimeId = this.#snapshot?.runtimeId;
    // Crash recovery may continue the same session file. Intentional stop / workspace
    // switch must not re-pin the previous session onto the next start.
    if (!host.stopping && this.#snapshot?.sessionFile) {
      this.#sessionFile = this.#snapshot.sessionFile;
    }
    this.#snapshot = undefined;
    this.#lastSequence = 0;
    // Intentional stop/replace: pending callers should fail softly; Windows kill often is code 0.
    host.hello.reject(error);
    this.#rejectPending(error);

    if (!host.stopping) {
      if (runtimeId) this.#previousRuntimeId = runtimeId;
      const crashed: HostEvent = {
        protocolVersion: IPC_PROTOCOL_VERSION,
        type: "host.crashed",
        hostId: host.hostId,
        exitCode,
        message: error.message,
      };
      if (runtimeId) crashed.runtimeId = runtimeId;
      this.#emit(crashed);
    }
  }

  #acceptSnapshot(snapshot: HostSnapshot): void {
    this.#snapshot = snapshot;
    this.#lastSequence = snapshot.sequence;
    if (snapshot.sessionFile) this.#sessionFile = snapshot.sessionFile;
  }

  #request(command: HostCommand): Promise<HostEvent> {
    const host = this.#host;
    if (!host || host.ignoreMessages) return Promise.reject(new Error("Agent Host is not running"));
    // Capture the map identity so timeouts still work after the host is parked
    // (park moves this Map onto the ParkedHost entry).
    const pendingMap = this.#pending;

    return new Promise((resolve, reject) => {
      const timeoutMs = hostCommandTimeoutMs(command.type);
      const timeout =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              pendingMap.delete(command.requestId);
              reject(new Error(`Agent Host timed out handling ${command.type}`));
            }, timeoutMs);
      pendingMap.set(command.requestId, {
        resolve,
        reject,
        timeout,
        commandType: command.type,
      });
      host.child.send(command);
    });
  }

  #send(command: HostCommand): void {
    const host = this.#host;
    if (!host || host.ignoreMessages) throw new Error("Agent Host is not running");
    host.child.send(command);
  }

  #resolvePendingFor(host: ActiveHost, message: HostEvent, parked: ParkedHost | undefined): void {
    if (!("requestId" in message) || !message.requestId) return;
    const pendingMap = parked ? parked.pending : this.#host === host ? this.#pending : undefined;
    if (!pendingMap) return;
    const pending = pendingMap.get(message.requestId);
    if (!pending) return;
    clearPendingTimeout(pending);
    pendingMap.delete(message.requestId);
    if (message.type === "host.error") {
      const error = new Error(message.message) as NodeJS.ErrnoException;
      error.code = message.code;
      pending.reject(error);
    } else {
      pending.resolve(message);
    }
    if (!parked) return;
    if (pendingHasPrompt(parked.pending)) {
      this.#disarmIdleReap(parked);
      parked.idleSince = undefined;
      return;
    }
    parked.idleSince = Date.now();
    this.#armIdleReap(parked);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearPendingTimeout(pending);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #emit(event: HostEvent, count = true): void {
    if (count) this.#count(event.type);
    if (!this.window.isClosed()) this.window.send(HOST_EVENT_CHANNEL, event);
  }

  #count(type: string): void {
    this.#eventCounts.set(type, (this.#eventCounts.get(type) ?? 0) + 1);
  }
}

let mainWindow: RendererConnection | undefined;
let supervisor: HostSupervisor | undefined;
let themeLibrary: ThemeLibrary | undefined;

async function createWindow(): Promise<void> {
  mainWindow = renderer;
  supervisor = new HostSupervisor(renderer);
  applyAppScale(renderer, getAppScale());
}

function openSystemNotificationSettings(): void {
  if (process.platform === "darwin") {
    // Ventura+ Settings app
    void shell
      .openExternal("x-apple.systempreferences:com.apple.Notifications-Settings.extension")
      .catch(() => {
        void shell.openExternal("x-apple.systempreferences:com.apple.preference.notifications");
      });
    return;
  }
  if (process.platform === "win32") {
    void shell.openExternal("ms-settings:notifications");
    return;
  }
  // Linux: no single standard deep-link.
  void shell
    .openExternal("https://wiki.archlinux.org/title/Desktop_notifications")
    .catch(() => undefined);
}

export type ShowOsNotificationPayload = {
  title: string;
  body?: string;
  silent?: boolean;
  force?: boolean;
  requireUnfocused?: boolean;
};
function showOsNotification(payload: ShowOsNotificationPayload): Promise<boolean> {
  return nativeRequest("notifications.show", payload);
}

void (async () => {
  // Name + About/Dock icon (must be after ready for About panel iconPath on some builds).
  themeLibrary = new ThemeLibrary(app.getPath("userData"));
  await applyAppSessionProxy();
  rpc.handle("pix:app:get-runtime", () => ({
    platform: process.platform,
    isPackaged: app.isPackaged,
    enableTestCommands:
      process.env.PIX_ENABLE_TEST_COMMANDS === "1" ||
      process.env.PIX_ENABLE_TEST_COMMANDS === "true",
    appVersion: app.getVersion(),
    /** Windows uses native titleBarOverlay buttons; Linux needs renderer caption buttons. */
    customWindowControls: process.platform !== "darwin",
  }));
  rpc.handle("pix:proxy:get", () => getProxyPrefs());
  rpc.handle("pix:proxy:set", async (_event, next: unknown) => {
    const prev = getProxyPrefs();
    const saved = setProxyPrefs(normalizeProxyPrefs(next));
    await applyAppSessionProxy(saved.app);
    // AI proxy is applied at agent-host spawn; recycle host so new env takes effect.
    if (JSON.stringify(prev.ai) !== JSON.stringify(saved.ai) && supervisor) {
      try {
        await supervisor.stop();
      } catch (error) {
        console.warn("[pix] stop host after AI proxy change failed:", error);
      }
    }
    return saved;
  });
  rpc.handle("pix:proxy:discover-local", () => discoverLocalProxies());
  rpc.handle("pix:appearance:set-theme-source", (_event, source: unknown) => {
    if (source !== "light" && source !== "dark" && source !== "system")
      throw new Error("Invalid native theme source");
    return nativeRequest("window.theme", { source });
  });
  rpc.handle("pix:appearance:get-app-scale", () => getAppScale());
  rpc.handle("pix:appearance:set-app-scale", (_event, scale: unknown) => setAppScale(scale));
  const requireThemeLibrary = (): ThemeLibrary => {
    if (!themeLibrary) throw new Error("Theme library is not ready");
    return themeLibrary;
  };
  rpc.handle("pix:themes:list", () => requireThemeLibrary().list());
  rpc.handle("pix:themes:activate", (_event, id: unknown) => requireThemeLibrary().activate(id));
  rpc.handle("pix:themes:save", (_event, input: unknown) => requireThemeLibrary().save(input));
  rpc.handle("pix:themes:remove", (_event, id: unknown) => requireThemeLibrary().remove(id));
  rpc.handle("pix:themes:import-pick", async () => {
    if (!mainWindow) return undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Import Pix theme skin",
      properties: ["openDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    return requireThemeLibrary().importDirectory(result.filePaths[0]);
  });
  rpc.handle("pix:themes:export-pick", async (_event, id: unknown) => {
    if (!mainWindow) return {};
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Export Pix theme skin",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return {};
    return { outputPath: requireThemeLibrary().exportDirectory(id, result.filePaths[0]) };
  });

  const broadcastPiProgress = (event: PiCliProgressEvent) => {
    if (!mainWindow || mainWindow.isClosed()) return;
    mainWindow.send(PI_PROGRESS_CHANNEL, event);
  };
  /** Detect global pi only (no npm install). Used at startup / bootstrap. */
  const runDetectPiCli = async () => {
    return ensurePiCli({ onProgress: broadcastPiProgress });
  };
  /** Explicit global install (Settings → Pi). */
  const runInstallGlobalPiCli = async () => {
    const result = await ensurePiCli({ onProgress: broadcastPiProgress, force: true });
    // Fresh install only: gently re-read config. Do not force-kill a healthy host mid-start
    // (that surfaces as "Agent Host exited with code 0" on Windows).
    if (result.installedNow && supervisor) {
      try {
        await supervisor.start({ force: false });
      } catch (error) {
        console.warn("[pix] host refresh after pi install failed:", error);
      }
    }
    cachedGlobalSdk = undefined;
    void resolveGlobalSdkCached(true).catch(() => undefined);
    return result;
  };
  rpc.handle("pix:pi:ensure", () => runDetectPiCli());
  rpc.handle("pix:runtimes:get-status", () => getActiveBundledRuntimeStatus());
  rpc.handle("pix:runtimes:set-prefs", (_event, raw: unknown) => {
    const next = normalizeBundledRuntimePrefs(raw);
    const prefs = loadDesktopPrefs();
    saveDesktopPrefs({
      ...prefs,
      bundledRuntimes: {
        useBundledNode: next.useBundledNode,
        useBundledPython: next.useBundledPython,
      },
    });
    configureBundledRuntimes({ prefs: next });
    // Rebuild PATH from pre-managed base + clear/set isolation env for new prefs.
    applyManagedRuntimeToProcessEnv(process.env);
    return getActiveBundledRuntimeStatus();
  });
  rpc.handle("pix:pi-sdk:get-status", () => collectPiSdkStatus());
  rpc.handle(
    "pix:pi-sdk:set-source",
    async (_event, source: unknown, options?: { force?: boolean }) => {
      const next = normalizePiSdkSource(source);
      const force = options?.force === true;
      if (next === "global") {
        const global = await resolveGlobalSdkCached(true);
        if (!global.available) {
          throw new Error(global.error || "Global pi SDK is not available");
        }
      }

      const activity = collectPiSdkActivity();
      if (activity.busy && !force) {
        // Soft refuse: UI should confirm then retry with force.
        throw new Error(formatPiSdkBusyError(activity));
      }

      setPiSdkPrefs({ source: next });
      cachedGlobalSdk = await resolveGlobalSdkCached(true);

      // Best-effort graceful abort before hard recycle when user forced through busy work.
      if (activity.agentBusy && supervisor) {
        try {
          await supervisor.abort();
        } catch {
          // ignore — stop() will tear down regardless
        }
      }

      // Dispose TUI so next open uses the new CLI path.
      try {
        piTuiController?.disposeAll();
        piTuiGuard.release();
      } catch {
        // ignore
      }

      // Recycle Agent Host so module resolution picks the new package root.
      // stop() also tears down parked generators (including busy parked sessions).
      if (supervisor) {
        try {
          await supervisor.stop();
          await supervisor.start({ force: true });
        } catch (error) {
          console.warn("[pix] host recycle after pi SDK switch failed:", error);
        }
      }
      return collectPiSdkStatus();
    },
  );
  rpc.handle("pix:pi-sdk:list-config-files", async () => {
    let agentDir = defaultAgentDir();
    try {
      const snap = await supervisor?.snapshot();
      if (snap?.agentDir) agentDir = snap.agentDir;
    } catch {
      // ignore
    }
    return listPiConfigFiles(agentDir);
  });
  rpc.handle("pix:pi-sdk:reveal-config", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id.trim()) throw new Error("Invalid config id");
    let agentDir = defaultAgentDir();
    try {
      const snap = await supervisor?.snapshot();
      if (snap?.agentDir) agentDir = snap.agentDir;
    } catch {
      // ignore
    }
    const entry = listPiConfigFiles(agentDir).find((f) => f.id === id);
    if (!entry) throw new Error(`Unknown config id: ${id}`);
    if (!entry.exists) throw new Error(`Config path does not exist: ${entry.path}`);
    await shell.showItemInFolder(entry.path);
  });
  rpc.handle("pix:pi-sdk:open-config", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id.trim()) throw new Error("Invalid config id");
    let agentDir = defaultAgentDir();
    try {
      const snap = await supervisor?.snapshot();
      if (snap?.agentDir) agentDir = snap.agentDir;
    } catch {
      // ignore
    }
    const entry = listPiConfigFiles(agentDir).find((f) => f.id === id);
    if (!entry) throw new Error(`Unknown config id: ${id}`);
    if (!entry.openable) throw new Error("This file cannot be opened from Pix (sensitive).");
    if (!entry.exists) throw new Error(`Config path does not exist: ${entry.path}`);
    const error = await shell.openPath(entry.path);
    if (error) throw new Error(error);
  });
  rpc.handle("pix:pi-sdk:install-global", () => runInstallGlobalPiCli());
  rpc.handle("pix:pi-sdk:check-latest", () => collectPiSdkStatus({ forceLatest: true }));

  // Only resolve global package when user already prefers global SDK.
  // Default builtin: skip global pi probe entirely at startup.
  if (getPiSdkPrefs().source === "global") {
    void resolveGlobalSdkCached(true).catch(() => undefined);
  }

  await createWindow();

  rpc.handle(
    "pix:host:start",
    (_event, options?: { cwd?: string; sessionFile?: string; resumeRecent?: boolean }) =>
      supervisor?.start(options),
  );
  rpc.handle("pix:host:snapshot", () => supervisor?.snapshot());
  rpc.handle("pix:host:stop", () => {
    piTuiController?.disposeAll();
    piTuiGuard.release();
    return supervisor?.stop();
  });
  rpc.handle("pix:workspace:get-cwd", () => supervisor?.getWorkspaceCwd());
  rpc.handle("pix:workspace:list-recent", () => supervisor?.listRecentWorkspaces());
  rpc.handle(
    "pix:workspace:open-path",
    (_event, cwd: string, options?: { resumeRecent?: boolean }) =>
      supervisor?.openWorkspace(cwd, options),
  );
  rpc.handle("pix:workspace:remove-recent", (_event, cwd: string) =>
    supervisor?.removeRecentWorkspace(cwd),
  );
  rpc.handle("pix:workspace:clear-active", () => supervisor?.clearActiveWorkspace());
  rpc.handle("pix:workspace:get-git-context", (_event, cwd?: string) => {
    const path =
      typeof cwd === "string" && cwd.trim() ? cwd : (supervisor?.getWorkspaceCwd() ?? undefined);
    return readGitContext(path);
  });
  rpc.handle("pix:workspace:list-git-branches", async (_event, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return listGitBranches(path);
  });
  rpc.handle("pix:workspace:checkout-git-branch", async (_event, branch: string, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return checkoutGitBranch(path, branch);
  });
  rpc.handle(
    "pix:workspace:create-git-branch",
    async (_event, branch: string, options?: { checkout?: boolean; cwd?: string }) => {
      const path = resolveWorkspaceCwd(options?.cwd, supervisor?.getWorkspaceCwd());
      return createGitBranch(path, branch, options?.checkout !== false);
    },
  );
  rpc.handle("pix:workspace:list-git-worktrees", async (_event, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return listGitWorktrees(path);
  });
  rpc.handle("pix:workspace:list-managed-worktrees", async () => listAllManagedWorktrees());
  rpc.handle(
    "pix:workspace:create-git-worktree",
    async (
      _event,
      options: {
        path?: string;
        branch?: string;
        newBranch?: string;
        name?: string;
        cwd?: string;
      },
    ) => {
      const path = resolveWorkspaceCwd(options?.cwd, supervisor?.getWorkspaceCwd());
      return createGitWorktree(path, options);
    },
  );
  rpc.handle(
    "pix:workspace:remove-git-worktree",
    async (_event, worktreePath: string, cwd?: string) => {
      return removeGitWorktree(worktreePath, cwd);
    },
  );
  rpc.handle("pix:workspace:get-worktree-prefs", (_event, cwd?: string) => {
    const path =
      typeof cwd === "string" && cwd.trim() ? cwd : (supervisor?.getWorkspaceCwd() ?? undefined);
    return getWorktreePrefsView(path);
  });
  rpc.handle(
    "pix:workspace:set-worktree-prefs",
    (_event, patch: { rootConfigured?: string; autoDelete?: boolean; autoDeleteLimit?: number }) =>
      setWorktreePrefs(patch ?? {}),
  );
  rpc.handle("pix:workspace:get-git-prefs", () => getGitPrefs());
  rpc.handle(
    "pix:workspace:set-git-prefs",
    (
      _event,
      patch: {
        branchPrefix?: string;
        pullMode?: "merge" | "squash";
        forcePush?: boolean;
        draftPr?: boolean;
        customCommitCommand?: string;
        customPrCommand?: string;
        modelProvider?: string;
        modelId?: string;
      },
    ) => setGitPrefs(patch ?? {}),
  );
  rpc.handle("pix:workspace:reveal-in-folder", (_event, cwd: string) => {
    if (typeof cwd === "string" && cwd.trim()) return shell.showItemInFolder(cwd);
  });
  rpc.handle("pix:workspace:open-file", async (_event, path: string) => {
    if (typeof path !== "string" || !path.trim()) throw new Error("Invalid file path");
    const error = await shell.openPath(path);
    if (error) throw new Error(error);
  });
  rpc.handle("pix:workspace:open-external", async (_event, url: string) => {
    if (typeof url !== "string") throw new Error("Invalid external URL");
    const protocol = new URL(url).protocol;
    if (!new Set(["http:", "https:", "mailto:"]).has(protocol)) {
      throw new Error(`Unsupported external URL protocol: ${protocol}`);
    }
    await shell.openExternal(url);
  });
  rpc.handle("pix:workspace:ensure-default", () => ensureDefaultWorkspacePath());
  rpc.handle("pix:workspace:ensure-conversation", () => ensureConversationWorkspacePath());
  rpc.handle("pix:workspace:git-status", async (_event, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return gitStatus(path);
  });
  rpc.handle("pix:workspace:git-commit", async (_event, message: string, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return gitCommit(path, message);
  });
  rpc.handle("pix:workspace:git-pull", async (_event, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return gitPull(path);
  });
  rpc.handle("pix:workspace:git-push", async (_event, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return gitPush(path);
  });
  rpc.handle("pix:workspace:git-commit-and-push", async (_event, message: string, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return gitCommitAndPush(path, message);
  });
  rpc.handle("pix:workspace:git-generate-commit-message", async (_event, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return generateCommitMessage(path);
  });
  rpc.handle("pix:workspace:open-create-pr", async (_event, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return openCreatePullRequest(path);
  });
  rpc.handle("pix:workspace:list-open-targets", async (_event, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return listOpenTargets(path);
  });
  rpc.handle("pix:workspace:open-in-app", async (_event, appId: string, cwd?: string) => {
    const path = resolveWorkspaceCwd(cwd, supervisor?.getWorkspaceCwd());
    return openInApp(appId, path);
  });
  rpc.handle("pix:workspace:pick-folder", async () => {
    if (!mainWindow) return undefined;
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || !result.filePaths[0]) return undefined;
    return result.filePaths[0];
  });
  // Windows/Linux: Electron cannot open a dialog that is both a file picker and a
  // directory picker. Combining openFile+openDirectory forces directory-only UI, so
  // users could not select files. Callers pass mode explicitly.
  rpc.handle(
    "pix:workspace:pick-attachments",
    async (_event, options?: { mode?: "files" | "folders" }) => {
      if (!mainWindow) return [];
      const mode = options?.mode === "folders" ? "folders" : "files";
      const properties: Array<"openFile" | "openDirectory" | "multiSelections"> =
        mode === "folders" ? ["openDirectory", "multiSelections"] : ["openFile", "multiSelections"];
      const result = await dialog.showOpenDialog(mainWindow, {
        properties,
        // Keep the dialog on top of our frameless/custom window on Windows.
        ...(process.platform === "win32"
          ? { title: mode === "folders" ? "选择文件夹" : "选择文件" }
          : {}),
      });
      return result.canceled ? [] : result.filePaths;
    },
  );
  rpc.handle(
    "pix:workspace:search-paths",
    async (_event, query?: string, options?: { cwd?: string; limit?: number }) => {
      const fromOpts =
        typeof options?.cwd === "string" && options.cwd.trim() ? options.cwd.trim() : undefined;
      const resolved = fromOpts ?? supervisor?.getWorkspaceCwd();
      if (!resolved || !existsSync(resolved)) return [];
      return searchWorkspacePaths(
        resolved,
        typeof query === "string" ? query : "",
        options?.limit ?? 24,
      );
    },
  );
  rpc.handle(
    "pix:workspace:save-clipboard-image",
    async (_event, options?: { bytes?: number[]; ext?: string }) => {
      const dir = join(app.getPath("temp"), "pix-attachments");
      mkdirSync(dir, { recursive: true });
      let buffer: Buffer | undefined;
      let ext = typeof options?.ext === "string" && options.ext.trim() ? options.ext.trim() : "png";
      if (Array.isArray(options?.bytes) && options.bytes.length > 0) {
        buffer = Buffer.from(options.bytes);
      } else {
        const bytes = await nativeRequest<number[]>("clipboard.read-image");
        if (!bytes?.length) return undefined;
        buffer = Buffer.from(bytes);
        ext = "png";
      }
      if (!buffer || buffer.length === 0) return undefined;
      const filePath = join(dir, `paste-${Date.now()}.${ext.replace(/^\./, "")}`);
      writeFileSync(filePath, buffer);
      return filePath;
    },
  );
  /** Local image → data-URL. Default maxEdge 160 (chips); pass a larger edge for timeline display. */
  rpc.handle(
    "pix:workspace:read-attachment-preview",
    async (_event, filePath?: string, options?: { maxEdge?: number }) => {
      if (typeof filePath !== "string" || !filePath.trim()) return undefined;
      const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(filePath);
      if (!existsSync(abs)) return undefined;
      try {
        if (!lstatSync(abs).isFile()) return undefined;
      } catch {
        return undefined;
      }
      const ext = abs.slice(abs.lastIndexOf(".")).toLowerCase();
      if (
        ![
          ".png",
          ".jpg",
          ".jpeg",
          ".gif",
          ".webp",
          ".svg",
          ".bmp",
          ".tif",
          ".tiff",
          ".heic",
          ".avif",
        ].includes(ext)
      ) {
        return undefined;
      }
      const requested = typeof options?.maxEdge === "number" ? options.maxEdge : 160;
      const maxEdge = Math.min(2048, Math.max(32, Math.round(requested)));
      const maxBytes = maxEdge > 320 ? 12_000_000 : 1_500_000;
      const originalMime =
        ext === ".gif"
          ? "image/gif"
          : ext === ".webp"
            ? "image/webp"
            : ext === ".svg"
              ? "image/svg+xml"
              : undefined;
      try {
        // Keep GIF/WebP/SVG bytes so animation and vectors survive (nativeImage → PNG does not).
        if (originalMime && (ext === ".gif" || ext === ".svg" || maxEdge > 320)) {
          const raw = readFileSync(abs);
          if (raw.length && raw.length <= maxBytes) {
            return `data:${originalMime};base64,${raw.toString("base64")}`;
          }
          if (ext === ".gif" || ext === ".svg") return undefined;
        }
        const image = nativeImage.createFromPath(abs);
        if (image.isEmpty()) return undefined;
        const { width, height } = image.getSize();
        let out = image;
        if (width > maxEdge || height > maxEdge) {
          const scale = Math.min(maxEdge / Math.max(width, 1), maxEdge / Math.max(height, 1));
          out = image.resize({
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
            quality: "good",
          });
        }
        const png = out.toPNG();
        if (!png.length || png.length > maxBytes) return undefined;
        return `data:image/png;base64,${png.toString("base64")}`;
      } catch {
        return undefined;
      }
    },
  );
  rpc.handle("pix:trust:get", () => supervisor?.getTrust());
  rpc.handle("pix:trust:set", (_event, trusted: boolean) => supervisor?.setTrust(trusted));
  rpc.handle("pix:models:list", () => supervisor?.listModels());
  rpc.handle("pix:models:set", (_event, provider: string, id: string) =>
    supervisor?.setModel(provider, id),
  );
  rpc.handle("pix:models:get-config", () => supervisor?.getModelsJsonConfig());
  rpc.handle("pix:models:upsert-custom", (_event, input: UpsertCustomProviderInput) =>
    supervisor?.upsertCustomProvider(input),
  );
  rpc.handle("pix:models:remove-custom", (_event, provider: string) =>
    supervisor?.removeCustomProvider(provider),
  );
  rpc.handle("pix:models:remove-custom-model", (_event, provider: string, modelId: string) =>
    supervisor?.removeCustomModel(provider, modelId),
  );
  rpc.handle("pix:models:open-config", () => supervisor?.openModelsJson());
  rpc.handle("pix:models:reveal-config", () => supervisor?.revealModelsJson());
  rpc.handle("pix:thinking:set", (_event, level: string) => supervisor?.setThinkingLevel(level));
  rpc.handle("pix:service-tier:set", (_event, tier: string) => supervisor?.setServiceTier(tier));
  rpc.handle("pix:providers:list", () => supervisor?.listProviders());
  rpc.handle("pix:providers:usage", () => supervisor?.listProviderUsage());
  rpc.handle("pix:providers:set-api-key", (_event, provider: string, apiKey: string) =>
    supervisor?.setProviderApiKey(provider, apiKey),
  );
  rpc.handle("pix:providers:clear-auth", (_event, provider: string) =>
    supervisor?.clearProviderAuth(provider),
  );
  rpc.handle("pix:providers:oauth-start", (_event, provider: string, operationId?: string) =>
    supervisor?.startProviderOAuth(provider, operationId),
  );
  rpc.handle(
    "pix:providers:oauth-respond",
    (_event, operationId: string, promptId: string, value?: string, cancelled?: boolean) =>
      supervisor?.respondProviderOAuth(operationId, promptId, value, cancelled),
  );
  rpc.handle("pix:providers:oauth-cancel", (_event, operationId: string) =>
    supervisor?.cancelProviderOAuth(operationId),
  );
  rpc.handle("pix:settings:get", () => supervisor?.getPiSettings());
  rpc.handle("pix:settings:patch", (_event, patch: PiSettingsPatch) =>
    supervisor?.patchPiSettings(patch),
  );
  rpc.handle(
    "pix:agent:prompt",
    async (
      _event,
      message: string,
      streamingBehavior?: "steer" | "followUp",
      imagePaths?: string[],
    ) => {
      // A warm TUI for this session must stop before the Host writes the same JSONL.
      // Other parked sessions remain isolated and can be promoted later.
      const sessionFile = supervisor?.activeSessionFile();
      if (sessionFile && piTuiController?.disposeSession(sessionFile)) {
        piTuiGuard.release(sessionFile);
      } else if (!sessionFile && piTuiController?.isAlive()) {
        piTuiController.dispose();
        piTuiGuard.release();
      }
      piTuiGuard.assertHostPromptAllowed();
      return supervisor?.prompt(message, streamingBehavior, imagePaths);
    },
  );

  // ── Embedded pi TUI (real PTY; contentMode terminal) ─────────────────────
  rpc.handle(
    "pix:terminal:open",
    async (_event, options: { sessionFile: string; cwd: string; cols?: number; rows?: number }) => {
      if (!options || typeof options.sessionFile !== "string" || typeof options.cwd !== "string") {
        throw new Error("terminal.open requires sessionFile and cwd");
      }
      const plan = planPiTuiLaunch({
        sessionFile: options.sessionFile,
        cwd: options.cwd,
        ...(typeof options.cols === "number" ? { cols: options.cols } : {}),
        ...(typeof options.rows === "number" ? { rows: options.rows } : {}),
      });
      const controller = await getPiTuiController();
      // Always transfer exclusive ownership on open. tryAcquire-only failed after
      // the first session when guard/controller keys desynced (macOS /private/var
      // vs /var, or suspend/cancel races) — UI then could not open any later TUI.
      const acquired = piTuiGuard.transferTo(plan.sessionKey);
      if (!acquired.ok) throw new Error(acquired.reason);

      try {
        const send = (channel: string, payload: unknown) => {
          if (!mainWindow || mainWindow.isClosed()) return;
          mainWindow.send(channel, payload);
        };
        const opened = await controller.open(plan, {
          // Tag every stream event. Electron can deliver a queued event from the
          // disposed PTY after the next session has already mounted.
          onData: (data) => send("pix:terminal:data", { data, sessionFile: plan.sessionFile }),
          onExit: (event) => {
            piTuiGuard.release(plan.sessionKey);
            send("pix:terminal:exit", { ...event, sessionFile: plan.sessionFile });
          },
        });
        return {
          sessionFile: opened.sessionFile,
          cwd: opened.cwd,
          resumed: opened.resumed,
        };
      } catch (error) {
        piTuiGuard.release(plan.sessionKey);
        throw error;
      }
    },
  );
  rpc.handle("pix:terminal:write", async (_event, data: string) => {
    const controller = await getPiTuiController();
    controller.write(typeof data === "string" ? data : String(data ?? ""));
  });
  rpc.handle("pix:terminal:resize", async (_event, cols: number, rows: number) => {
    const controller = await getPiTuiController();
    controller.resize(Number(cols) || 80, Number(rows) || 24);
  });
  rpc.handle("pix:terminal:suspend", async () => {
    if (!piTuiController?.isAlive()) {
      piTuiGuard.release();
      return {};
    }
    const { sessionFile } = piTuiController.suspend();
    // Release exclusive lock so chat can prompt (prompt path disposes suspended TUI).
    piTuiGuard.release();
    return sessionFile ? { sessionFile } : {};
  });
  rpc.handle("pix:terminal:dispose", async () => {
    if (!piTuiController) {
      piTuiGuard.release();
      return {};
    }
    const { sessionFile } = piTuiController.dispose();
    piTuiGuard.release();
    return sessionFile ? { sessionFile } : {};
  });
  rpc.handle("pix:terminal:status", async () => {
    if (!piTuiController) {
      return { open: false, parkedSessionFiles: [], sessionCount: 0 };
    }
    const status = piTuiController.status();
    const sessionFile = status.live?.sessionFile;
    return {
      open: piTuiController.isOpen(),
      suspended: piTuiController.isSuspended(),
      ...(sessionFile ? { sessionFile } : {}),
      parkedSessionFiles: status.parkedSessionFiles,
      sessionCount: status.parkedSessionFiles.length + (status.live ? 1 : 0),
    };
  });
  rpc.handle("pix:agent:queue-clear", () => supervisor?.clearQueue());
  rpc.handle("pix:agent:abort", () => supervisor?.abort());
  rpc.handle("pix:session:list", () => supervisor?.listSessions());
  rpc.handle("pix:session:list-for-cwd", async (_event, cwd: string) => {
    if (typeof cwd !== "string" || !cwd.trim()) return [];
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const requested = norm(cwd);
    // When this cwd is the live host workspace, prefer host listSessions — it merges
    // the in-memory session that pi has not flushed to disk yet (no assistant msg).
    // Disk-only list would drop brand-new conversations from the sidebar.
    //
    // Re-check cwd after await: rapid project「新建会话」can switch the host mid-list
    // and would otherwise return the *new* project's sessions under the requested cwd
    // (wiping the 对话 rail when those rows are filtered by project cwd).
    try {
      const current = supervisor?.getWorkspaceCwd();
      if (current && norm(current) === requested) {
        const listed = await supervisor?.listSessions();
        const still = supervisor?.getWorkspaceCwd();
        if (listed && still && norm(still) === requested) {
          return listed.threads.filter((thread) => {
            const threadCwd = (thread.cwd || "").trim();
            if (!threadCwd) return true;
            return norm(threadCwd) === requested;
          });
        }
      }
    } catch {
      // host may be stopped — fall through to disk scan
    }
    // Import agent-runtime (pi stays external in the main bundle — see vite.main.config).
    const { listProjectSessions } = await import("@pix/agent-runtime");
    return listProjectSessions(cwd);
  });
  rpc.handle("pix:session:new", () => supervisor?.newSession());
  rpc.handle("pix:session:create-blank", () => supervisor?.createBlankConversation());
  rpc.handle("pix:session:switch", (_event, sessionPath: string) =>
    supervisor?.switchSession(sessionPath),
  );
  rpc.handle("pix:session:fork", (_event, entryId?: string) => supervisor?.forkSession(entryId));
  rpc.handle("pix:session:tree", () => supervisor?.sessionTree());
  rpc.handle(
    "pix:session:navigate-tree",
    (_event, targetId: string, options?: { summarize?: boolean; customInstructions?: string }) =>
      supervisor?.navigateSessionTree(targetId, options),
  );
  rpc.handle("pix:session:compact", (_event, instructions?: string) =>
    supervisor?.compactSession(instructions),
  );
  rpc.handle("pix:session:set-name", (_event, name: string) => supervisor?.setSessionName(name));
  rpc.handle("pix:session:clone", () => supervisor?.cloneSession());
  rpc.handle("pix:session:info", () => supervisor?.sessionInfo());
  rpc.handle("pix:session:export", (_event, format: "html" | "jsonl", outputPath?: string) =>
    supervisor?.exportSession(format, outputPath),
  );
  rpc.handle("pix:session:export-pick", (_event, format: "html" | "jsonl") =>
    supervisor?.exportSessionPick(format),
  );
  rpc.handle("pix:session:import", (_event, inputPath: string) =>
    supervisor?.importSession(inputPath),
  );
  rpc.handle("pix:session:import-pick", () => supervisor?.importSessionPick());
  rpc.handle(
    "pix:session:bash",
    (_event, command: string, options?: { excludeFromContext?: boolean }) =>
      supervisor?.sessionBash(command, options),
  );
  rpc.handle("pix:session:copy-last", () => supervisor?.copyLastAssistant());
  rpc.handle("pix:session:share", () => supervisor?.shareSession());
  rpc.handle("pix:runtime:reload", () => supervisor?.reloadRuntime());
  rpc.handle("pix:models:list-scoped", () => supervisor?.listScopedModels());
  rpc.handle("pix:models:refresh-catalog", () => supervisor?.refreshModelCatalog());
  rpc.handle("pix:packages:list", () => supervisor?.listPackages());
  rpc.handle(
    "pix:packages:install",
    (_event, source: string, scope: "global" | "project", options?: { temporary?: boolean }) =>
      supervisor?.installPackage(source, scope, options),
  );
  rpc.handle(
    "pix:packages:set-enabled",
    (_event, source: string, scope: "global" | "project", enabled: boolean) =>
      supervisor?.setPackageEnabled(source, scope, enabled),
  );
  rpc.handle("pix:packages:remove", (_event, source: string, scope: "global" | "project") =>
    supervisor?.removePackage(source, scope),
  );
  rpc.handle("pix:packages:update", (_event, source?: string) => supervisor?.updatePackage(source));
  rpc.handle("pix:packages:check-updates", () => supervisor?.checkPackageUpdates());
  rpc.handle(
    "pix:packages:search-catalog",
    (_event, query?: string, size?: number, from?: number) =>
      searchPiPackageCatalog(query, size, from),
  );
  rpc.handle("pix:resources:list", () => supervisor?.listResources());
  rpc.handle("pix:extension-ui:respond", (_event, response: ExtensionUiResponse) =>
    supervisor?.extensionUiRespond(response),
  );
  if (process.env.PIX_ENABLE_TEST_COMMANDS === "1") {
    rpc.handle("pix:test:crash-host", () => supervisor?.crashHost());
  }

  rpc.handle("pix:notifications:show", (_event, payload: ShowOsNotificationPayload) =>
    showOsNotification(payload ?? { title: "" }),
  );
  rpc.handle("pix:notifications:open-system-settings", () => {
    openSystemNotificationSettings();
  });

  markReady(async () => {
    piTuiController?.disposeAll();
    piTuiGuard.release();
    await supervisor?.stop();
  });
  if (process.env.PIX_NO_AUTO_RESUME !== "1" && supervisor) {
    // Product cold start: restore last durable workspace and continue recent pi session.
    // Skip ephemeral fixture paths and missing directories.
    const cwd = durableWorkspacePath(supervisor.getWorkspaceCwd());
    if (cwd) {
      try {
        const snapshot = await supervisor.start({
          cwd,
          resumeRecent: true,
          force: true,
        });
        console.log(
          JSON.stringify({
            type: "pix.m2.auto_resume",
            cwd: snapshot.cwd,
            sessionId: snapshot.sessionId,
            sessionFile: snapshot.sessionFile,
          }),
        );
      } catch (error) {
        console.warn("Pix auto-resume skipped", error);
      }
    }
  }
})().catch((error: unknown) => {
  console.error("Pix failed to initialize", error);
  process.exit(1);
});
