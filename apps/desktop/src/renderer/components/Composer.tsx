/**
 * Conversation composer:
 * - Project picker above the card (icon + name)
 * - Textarea
 * - Bottom-left: attach +, access permission
 * - Bottom-right: context usage, model menu (thinking / model / speed), send icon
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal, flushSync } from "react-dom";
import type {
  GitBranchInfo,
  GitContextInfo,
  PackageSummary,
  QueuedMessages,
  SlashCommandSummary,
} from "@pix/contracts";
import {
  ArrowUp,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Cpu,
  Download,
  File,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitFork,
  Info,
  Keyboard,
  MessageSquareText,
  Minimize2,
  Monitor,
  Network,
  Package,
  Plus,
  PlusCircle,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  Share2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Slash,
  Square,
  Tag,
  Upload,
} from "lucide-react";
import {
  anchorFromElement,
  anchorFromEvent,
  FloatingMenu,
  type AnchorRect,
} from "./FloatingMenu.tsx";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ComposerAttachmentList } from "./ComposerAttachmentList.tsx";
import { ComposerQueueCard } from "./ComposerQueueCard.tsx";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog.tsx";
import { t, type Locale } from "../lib/i18n.ts";
import type { ServiceTierId } from "../lib/service-tier.ts";
import { ComposerModelPicker } from "./ComposerModelPicker.tsx";
import {
  addResourceQuery,
  applyPathTokenCompletion,
  detectComposerTrigger,
  filterSlashCommands,
  groupSlashCommands,
  pathTokenBeforeCursor,
  replaceTextRange,
  slashCommandQuery,
  slashMenuItemsFromGroups,
  type ComposerTrigger,
} from "../lib/composer-suggestions.ts";
import {
  addComposerRef,
  chipRangeAtCaret,
  chipRangeEndingAt,
  chipRangeStartingAt,
  composerChipInsertText,
  composerRefDisplayLabel,
  detectChipTrigger,
  findComposerChipRanges,
  highlightComposerPrompt,
  isComposerRefCommand,
  pruneComposerRefs,
  removeComposerChip,
  serializeComposerRefs,
  type ComposerRefToken,
} from "../lib/composer-highlight.ts";
import { renderHighlightSpans } from "./PromptTokenChip.tsx";
import { isImeCompositionEvent } from "../lib/composer-keyboard.ts";
import type { AccessMode, AccessVisibility } from "../lib/settings-prefs.ts";
import { visibleAccessModes } from "../lib/settings-prefs.ts";
import { cn } from "../lib/utils.ts";
import { workspaceLabel } from "../lib/workspace.ts";
import { useShellStore } from "../store/shell-store.ts";

export type { AccessMode, AccessVisibility };
/** @deprecated Use ServiceTierId — legacy Pix labels mapped to OpenAI service_tier. */
export type SpeedMode = ServiceTierId;

export interface ComposerModelOption {
  provider: string;
  id: string;
  name: string;
  /** Aligns with model settings: "custom" vs built-in catalog providers. */
  source?: string;
  availableThinkingLevels?: string[];
  availableServiceTiers?: ServiceTierId[];
}

export interface ComposerProps {
  surface?: "main" | "side";
  contextHeader?: ReactNode;
  locale: Locale;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: (event?: FormEvent) => void;
  onAbort: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  running: boolean;
  /** Drafts remain editable while the destination session is being prepared. */
  submitDisabled?: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  workspacePath: string | undefined;
  recentWorkspaces: string[];
  onOpenProject: (path: string) => void;
  onAddProject: () => void;
  accessMode: AccessMode;
  onAccessMode: (mode: AccessMode) => void;
  /** Which permission options appear in the menu (from General settings). */
  accessVisibility: AccessVisibility;
  modelOptions: ComposerModelOption[];
  modelValue: string;
  onModelChange: (provider: string, id: string) => void;
  thinkingLevel: string;
  thinkingLevels: string[];
  onThinkingChange: (level: string) => void;
  /** OpenAI service_tier when model supports it; empty serviceTiers = unsupported. */
  serviceTier: ServiceTierId;
  serviceTiers: ServiceTierId[];
  onServiceTierChange: (tier: ServiceTierId) => void;
  contextPercent: number | undefined;
  contextTokens: number | undefined;
  /** When false, hide context usage chip on the composer. */
  showContextUsage?: boolean;
  projectTrusted: boolean | undefined;
  runState: string;
  piThemeLabel: string;
  /** Absolute file or directory paths passed to pi as readable context. */
  attachments: string[];
  onPickAttachments: (mode?: "files" | "folders") => Promise<void>;
  onRemoveAttachment: (path: string) => void;
  /** Add paths chosen from `@` file suggestions. */
  onAddAttachments?: (paths: string[]) => void;
  slashCommands: SlashCommandSummary[];
  /** Installed packages shown under `@` → 插件. */
  packages?: PackageSummary[];
  queuedMessages: QueuedMessages;
  onClearQueue: () => void;
  /** Abort left pending queue items — show paused banner + Continue. */
  /** 引导：send this queued item immediately. */
  /** … → 编辑：load into composer and drop from queue. */
  /**
   * Project / local / branch bar that protrudes above the input.
   * Hidden once the session already has conversation content.
   */
  showProjectBar?: boolean;
}

type MenuKind = "project" | "local" | "branch" | "access" | "model" | "attach" | null;

function normalizeCwdKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isValidBranchName(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  if (n.includes("..") || n.startsWith("-") || n.endsWith(".lock")) return false;
  if (/[\s~^:?*[\\]/.test(n)) return false;
  return true;
}

/** Full-access caution: orange-red (not pale system orange, not pure error red). */
const ACCESS_FULL_ORANGE = "text-[#ff5c1a]";
const ACCESS_FULL_ORANGE_MUTED = "text-[#ff5c1a]/90";
const ACCESS_FULL_ORANGE_HOVER = "hover:bg-[#ff5c1a]/12";

/**
 * Access-control option — same hover/active fill + radius as session rows
 * (`--hover-fill`, rounded-md). Full access keeps orange caution text.
 */
function AccessOption(props: {
  icon: ReactNode;
  label: string;
  description: string;
  active?: boolean;
  /** Full-access caution (orange), not destructive red. */
  caution?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      data-testid={props.testId}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-left transition-colors",
        // Match session list: transparent default, hover-fill on hover/active.
        props.active ? "bg-[var(--hover-fill)]" : "bg-transparent hover:bg-[var(--hover-fill)]",
        props.caution && !props.active && ACCESS_FULL_ORANGE_HOVER,
      )}
      onClick={props.onClick}
    >
      <span
        className={cn(
          "mt-0.5 inline-flex size-4 shrink-0",
          props.caution ? ACCESS_FULL_ORANGE : "text-[var(--muted-foreground)]",
        )}
      >
        {props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-[13px] font-medium leading-snug",
            props.caution ? ACCESS_FULL_ORANGE : "text-[var(--foreground)]",
          )}
        >
          {props.label}
        </span>
        <span
          className={cn(
            "mt-0.5 block text-[11px] leading-snug",
            props.caution ? ACCESS_FULL_ORANGE_MUTED : "text-[var(--text-subtle)]",
          )}
        >
          {props.description}
        </span>
      </span>
      {props.active ? (
        <span
          className={cn(
            "mt-0.5 shrink-0 text-[11px] font-medium",
            props.caution ? ACCESS_FULL_ORANGE : "text-[var(--foreground)]",
          )}
        >
          ✓
        </span>
      ) : null}
    </button>
  );
}

function accessIcon(mode: AccessMode, className = "size-3.5") {
  if (mode === "full") return <ShieldAlert className={className} strokeWidth={1.75} />;
  if (mode === "autoReview") return <ShieldCheck className={className} strokeWidth={1.75} />;
  return <Shield className={className} strokeWidth={1.75} />;
}

function accessLabel(locale: Locale, mode: AccessMode): string {
  if (mode === "full") return t(locale, "composer.access.full");
  if (mode === "autoReview") return t(locale, "composer.access.autoReview");
  return t(locale, "composer.access.default");
}

function accessDesc(locale: Locale, mode: AccessMode): string {
  if (mode === "full") return t(locale, "composer.access.fullDesc");
  if (mode === "autoReview") return t(locale, "composer.access.autoReviewDesc");
  return t(locale, "composer.access.defaultDesc");
}

function formatContext(
  percent: number | undefined,
  tokens: number | undefined,
): string | undefined {
  if (percent != null && Number.isFinite(percent)) return `${Math.round(percent)}%`;
  if (tokens != null && Number.isFinite(tokens) && tokens > 0) {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k`;
    return `${tokens}`;
  }
  // Before the first response and immediately after compaction, usage is unknown.
  return undefined;
}

function ContextUsageIndicator(props: {
  label: string;
  unknownLabel: string;
  percent: number | undefined;
  tokens: number | undefined;
}) {
  const rawPercent = props.percent;
  const hasPercent = rawPercent != null && Number.isFinite(rawPercent);
  const value = hasPercent ? Math.min(100, Math.max(0, Math.round(rawPercent))) : 0;
  const detail = formatContext(props.percent, props.tokens) ?? props.unknownLabel;
  const accessibleLabel = `${props.label}: ${detail}`;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex size-8 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground"
            data-testid="usage-chip"
            data-context-percent={value}
            role="meter"
            aria-label={accessibleLabel}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(hasPercent ? { "aria-valuenow": value } : {})}
          >
            <svg className="size-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <circle
                cx="10"
                cy="10"
                r="7"
                stroke="currentColor"
                strokeWidth="2.25"
                opacity="0.2"
              />
              {value > 0 ? (
                <circle
                  cx="10"
                  cy="10"
                  r="7"
                  pathLength="100"
                  stroke="currentColor"
                  strokeWidth="2.25"
                  strokeLinecap="round"
                  strokeDasharray="100"
                  strokeDashoffset={100 - value}
                  transform="rotate(-90 10 10)"
                />
              ) : null}
            </svg>
            <span className="sr-only">{detail}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{accessibleLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

const ICON_SM = { className: "size-3.5 shrink-0", strokeWidth: 1.75 } as const;

/** Icons for `/` catalog — source groups + well-known builtin command names. */
function commandSourceIcon(command: SlashCommandSummary) {
  if (command.source === "skill" || command.name.startsWith("skill:")) {
    return <Box {...ICON_SM} />;
  }
  if (command.source === "prompt") {
    return <MessageSquareText {...ICON_SM} />;
  }
  if (command.source === "extension") {
    return <Puzzle {...ICON_SM} />;
  }
  // builtin (and legacy names mapped as builtin)
  switch (command.name) {
    case "new":
      return <PlusCircle {...ICON_SM} />;
    case "model":
    case "models":
      return <Cpu {...ICON_SM} />;
    case "settings":
      return <Settings {...ICON_SM} />;
    case "session":
      return <Info {...ICON_SM} />;
    case "name":
      return <Tag {...ICON_SM} />;
    case "tree":
      return <Network {...ICON_SM} />;
    case "fork":
      return <GitFork {...ICON_SM} />;
    case "clone":
      return <Copy {...ICON_SM} />;
    case "compact":
      return <Minimize2 {...ICON_SM} />;
    case "export":
      return <Download {...ICON_SM} />;
    case "import":
      return <Upload {...ICON_SM} />;
    case "share":
      return <Share2 {...ICON_SM} />;
    case "copy":
      return <ClipboardCopy {...ICON_SM} />;
    case "reload":
      return <RefreshCw {...ICON_SM} />;
    case "hotkeys":
    case "keybindings":
      return <Keyboard {...ICON_SM} />;
    default:
      return <Slash {...ICON_SM} />;
  }
}

function filterPackages(packages: PackageSummary[], query: string, limit = 24): PackageSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  const list = packages.filter((pkg) => {
    if (!needle) return true;
    return (
      pkg.source.toLocaleLowerCase().includes(needle) ||
      pkg.kind.toLocaleLowerCase().includes(needle) ||
      pkg.scope.toLocaleLowerCase().includes(needle)
    );
  });
  return list
    .slice()
    .sort((a, b) => a.source.localeCompare(b.source))
    .slice(0, limit);
}

/** Track whether a suggest list overflows so we only reserve fade padding when needed. */
function useSuggestOverflow(open: boolean, deps: unknown[]) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!open || !el) {
      setOverflows(false);
      return;
    }
    const measure = () => {
      setOverflows(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : undefined;
    ro?.observe(el);
    // Children size changes (filter results) also need remeasure.
    for (const child of el.children) {
      if (child instanceof HTMLElement) ro?.observe(child);
    }
    return () => ro?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are intentional content keys
  }, [open, ...deps]);

  return { scrollRef, overflows };
}

/** Composer prompt: fixed base of 2 lines, grow to 12, then scroll. */
const COMPOSER_PROMPT_MIN_LINES = 2;
const COMPOSER_PROMPT_MAX_LINES = 12;

function fitComposerPromptHeight(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  const styles = window.getComputedStyle(el);
  const fontSize = Number.parseFloat(styles.fontSize) || 14;
  let lineHeight = Number.parseFloat(styles.lineHeight);
  // `normal` / non-px line-heights must not collapse min height below two real text rows.
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    lineHeight = fontSize * 1.5;
  }
  const padY =
    (Number.parseFloat(styles.paddingTop) || 0) + (Number.parseFloat(styles.paddingBottom) || 0);
  // +2px subpixel buffer so the 2nd visual line does not immediately force a resize.
  const minH = Math.ceil(lineHeight * COMPOSER_PROMPT_MIN_LINES + padY + 2);
  const maxH = Math.ceil(lineHeight * COMPOSER_PROMPT_MAX_LINES + padY + 2);

  // Measure natural content height without fighting max-height.
  el.style.height = "0px";
  el.style.overflowY = "hidden";
  // scrollHeight with height 0 gives content size including padding.
  const contentH = el.scrollHeight;
  const next = Math.min(Math.max(contentH, minH), maxH);
  el.style.height = `${next}px`;
  const overflows = contentH > maxH + 1;
  el.style.overflowY = overflows ? "auto" : "hidden";
  el.dataset.overflow = overflows ? "true" : "false";
}

export function Composer(props: ComposerProps) {
  const tr = (key: Parameters<typeof t>[1], vars?: Record<string, string>) =>
    t(props.locale, key, vars);
  const [menu, setMenu] = useState<MenuKind>(null);
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const [projectQuery, setProjectQuery] = useState("");
  const [branchQuery, setBranchQuery] = useState("");
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);
  const [gitBusy, setGitBusy] = useState(false);
  /** Hover tip for local-menu options (description bubble outside the menu). */
  const [localTip, setLocalTip] = useState<{ text: string; x: number; y: number } | null>(null);
  /** Create-worktree dialog (same as project ⋯ menu). */
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  const showAppError = useShellStore((s) => s.showAppError);
  /** Mirror layer under the transparent textarea for skill / link / @path highlights. */
  const promptHighlightRef = useRef<HTMLDivElement | null>(null);
  /** After `/` or `@` insert, park the caret past the token once the value commits. */
  const pendingCaretRef = useRef<number | null>(null);
  const openTriggerRef = useRef<ComposerTrigger | null>(null);
  const [caret, setCaret] = useState(0);
  const [refTokens, setRefTokens] = useState<ComposerRefToken[]>([]);
  /** Which model-submenu flyout is open: thinking | speed */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** Main input card only — slash/@ menus overlay this, ignoring project-bar protrusion height. */
  const composerCardRef = useRef<HTMLFormElement | null>(null);
  const [suggestionAnchor, setSuggestionAnchor] = useState<AnchorRect | null>(null);
  /** -1 = no highlighted option (no default selected background). */
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const workspace = workspaceLabel(props.workspacePath);
  const [gitContext, setGitContext] = useState<GitContextInfo>({});

  async function refreshGitContext(cwd = props.workspacePath) {
    if (!cwd) {
      setGitContext({});
      return;
    }
    try {
      const info = await window.pix.workspace.getGitContext(cwd);
      setGitContext(info ?? {});
    } catch {
      setGitContext({});
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (!props.workspacePath) {
      setGitContext({});
      return;
    }
    void window.pix.workspace
      .getGitContext(props.workspacePath)
      .then((info) => {
        if (!cancelled) setGitContext(info ?? {});
      })
      .catch(() => {
        if (!cancelled) setGitContext({});
      });
    return () => {
      cancelled = true;
    };
  }, [props.workspacePath]);

  useEffect(() => {
    if (menu !== "branch" || !props.workspacePath) return;
    let cancelled = false;
    setBranchesLoading(true);

    void window.pix.workspace
      .listGitBranches(props.workspacePath)
      .then((list) => {
        if (!cancelled) setBranches(list ?? []);
      })
      .catch((error) => {
        if (!cancelled) {
          setBranches([]);
          showAppError(error instanceof Error ? error.message : tr("composer.branch.failed"));
        }
      })
      .finally(() => {
        if (!cancelled) setBranchesLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tr is stable per locale
  }, [menu, props.workspacePath, props.locale]);

  const projectPaths = useMemo(() => {
    const list: string[] = [];
    if (props.workspacePath) list.push(props.workspacePath);
    for (const p of props.recentWorkspaces) list.push(p);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of list) {
      const key = p.replace(/\\/g, "/").replace(/\/+$/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }, [props.workspacePath, props.recentWorkspaces]);

  const filteredProjects = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    if (!q) return projectPaths;
    return projectPaths.filter((path) => {
      const label = workspaceLabel(path);
      return (
        label.name.toLowerCase().includes(q) ||
        path.toLowerCase().includes(q) ||
        (label.detail?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [projectPaths, projectQuery]);

  const composerTrigger =
    detectComposerTrigger(props.prompt, caret) ?? detectChipTrigger(props.prompt, caret, refTokens);
  const slashQuery = composerTrigger?.kind === "slash" ? composerTrigger.query : undefined;
  const resourceQuery = composerTrigger?.kind === "mention" ? composerTrigger.query : undefined;
  const promptHighlightSpans = useMemo(() => {
    const promptNames: string[] = [];
    const extensionNames: string[] = [];
    for (const command of props.slashCommands) {
      if (command.source === "prompt") promptNames.push(command.name);
      else if (command.source === "extension") extensionNames.push(command.name);
    }
    return highlightComposerPrompt(
      props.prompt,
      {
        packageSources: (props.packages ?? []).map((pkg) => pkg.source),
        promptNames,
        extensionNames,
      },
      refTokens,
    );
  }, [props.prompt, props.packages, props.slashCommands, refTokens]);

  const visibleAttachments = props.attachments;

  function syncPromptHighlightScroll(el: HTMLTextAreaElement | null) {
    const mirror = promptHighlightRef.current;
    if (!el || !mirror) return;
    mirror.scrollTop = el.scrollTop;
    mirror.scrollLeft = el.scrollLeft;
  }
  const slashSuggestions = useMemo(
    () => filterSlashCommands(props.slashCommands, slashQuery ?? ""),
    [props.slashCommands, slashQuery],
  );
  const slashGroups = useMemo(() => groupSlashCommands(slashSuggestions), [slashSuggestions]);
  const slashMenuItems = useMemo(() => slashMenuItemsFromGroups(slashGroups), [slashGroups]);
  const packageSuggestions = useMemo(
    () => filterPackages(props.packages ?? [], resourceQuery ?? ""),
    [props.packages, resourceQuery],
  );
  const [pathSuggestions, setPathSuggestions] = useState<
    Array<{ path: string; relative: string; kind: "file" | "folder" }>
  >([]);
  // `@` → 添加 (picker + project paths) + 插件 (packages, only if any).
  const slashPanelOpen = menu === null && !suggestionsDismissed && slashQuery !== undefined;
  const resourcePanelOpen =
    menu === "attach" || (menu === null && !suggestionsDismissed && resourceQuery !== undefined);
  /** Flat `@`/attach nav: 0 = files, 1 = folders, then paths, then packages. */
  const resourceItemCount = 2 + pathSuggestions.length + packageSuggestions.length;
  const slashOverflow = useSuggestOverflow(slashPanelOpen, [
    slashQuery,
    slashSuggestions.length,
    props.slashCommands.length,
  ]);
  const resourceOverflow = useSuggestOverflow(resourcePanelOpen, [
    resourceQuery,
    pathSuggestions.length,
    packageSuggestions.length,
    props.packages?.length ?? 0,
  ]);

  useEffect(() => {
    if (!resourcePanelOpen) {
      setPathSuggestions([]);
      return;
    }
    // Menu opened via + button still searches; typed `@q` filters paths.
    const q = resourceQuery ?? "";
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.pix.workspace
        .searchPaths(q, {
          ...(props.workspacePath ? { cwd: props.workspacePath } : {}),
          limit: 24,
        })
        .then((rows) => {
          if (!cancelled) setPathSuggestions(rows);
        })
        .catch(() => {
          if (!cancelled) setPathSuggestions([]);
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [resourcePanelOpen, resourceQuery, props.workspacePath]);

  useEffect(() => {
    if (!slashPanelOpen && !resourcePanelOpen) {
      setSuggestionAnchor(null);
      return;
    }
    // Anchor to the card surface so the menu covers protrusion instead of clearing its full height.
    setSuggestionAnchor(anchorFromElement(composerCardRef.current ?? rootRef.current));
  }, [
    slashPanelOpen,
    resourcePanelOpen,
    props.prompt,
    props.showProjectBar,
    props.attachments.length,
  ]);

  useEffect(() => {
    setSuggestionIndex(-1);
  }, [slashQuery, resourceQuery, menu]);

  useLayoutEffect(() => {
    if (suggestionIndex < 0) return;
    const scroller = slashPanelOpen
      ? slashOverflow.scrollRef.current
      : resourcePanelOpen
        ? resourceOverflow.scrollRef.current
        : null;
    const item = scroller?.querySelector<HTMLElement>(`[data-suggest-index="${suggestionIndex}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [
    suggestionIndex,
    slashPanelOpen,
    resourcePanelOpen,
    slashQuery,
    resourceQuery,
    pathSuggestions.length,
    slashOverflow.scrollRef,
    resourceOverflow.scrollRef,
  ]);

  useEffect(() => {
    if (composerTrigger) openTriggerRef.current = composerTrigger;
  }, [composerTrigger]);

  function closeMenu() {
    setMenu(null);
    setAnchor(null);
    setProjectQuery("");
    setBranchQuery("");
    setLocalTip(null);
  }

  function openMenu(kind: MenuKind, event: ReactMouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (menu === kind) {
      closeMenu();
      return;
    }
    setMenu(kind);
    setAnchor(
      kind === "attach"
        ? anchorFromElement(composerCardRef.current ?? rootRef.current)
        : anchorFromEvent(event.currentTarget),
    );
  }

  function dismissSuggestions() {
    if (menu === "attach") closeMenu();
    else setSuggestionsDismissed(true);
  }

  function commitPromptWithCaret(value: string, nextCaret = value.length) {
    pendingCaretRef.current = nextCaret;
    setCaret(nextCaret);
    props.onPromptChange(value);
  }

  function replaceActiveTrigger(replacement: string, kind: "slash" | "mention") {
    const ranges = findComposerChipRanges(props.prompt, refTokens);
    const chip =
      chipRangeEndingAt(ranges, caret) ??
      chipRangeAtCaret(ranges, caret) ??
      chipRangeEndingAt(ranges, props.prompt.trimEnd().length);
    const chipAs = chip
      ? chip.token.kind === "package" || chip.token.kind === "file" || chip.token.kind === "folder"
        ? "mention"
        : "slash"
      : null;
    if (chip && chipAs === kind) {
      setRefTokens((current) => current.filter((item) => item.raw !== chip.token.raw));
      const next = replaceTextRange(props.prompt, chip.start, chip.end, replacement);
      openTriggerRef.current = null;
      commitPromptWithCaret(next.text, next.cursor);
      return;
    }

    const remembered = openTriggerRef.current;
    const rememberedHit =
      remembered?.kind === kind
        ? detectComposerTrigger(props.prompt, Math.min(props.prompt.length, remembered.rangeEnd))
        : null;
    const atCaret = detectComposerTrigger(props.prompt, caret);
    const atEnd = detectComposerTrigger(props.prompt, props.prompt.length);
    const trigger =
      rememberedHit?.kind === kind
        ? rememberedHit
        : atCaret?.kind === kind
          ? atCaret
          : atEnd?.kind === kind
            ? atEnd
            : composerTrigger;
    const rangeStart = trigger?.kind === kind ? trigger.rangeStart : props.prompt.length;
    const rangeEnd = trigger?.kind === kind ? trigger.rangeEnd : props.prompt.length;
    const next = replaceTextRange(props.prompt, rangeStart, rangeEnd, replacement);
    openTriggerRef.current = null;
    commitPromptWithCaret(next.text, next.cursor);
  }

  function selectCommand(command: SlashCommandSummary) {
    if (isComposerRefCommand(command)) {
      const label = composerRefDisplayLabel(command.name);
      setRefTokens((current) =>
        addComposerRef(current, {
          kind:
            command.source === "prompt"
              ? "prompt"
              : command.source === "extension"
                ? "extension"
                : "skill",
          raw: `/${command.name}`,
          label,
        }),
      );
      replaceActiveTrigger(composerChipInsertText(label), "slash");
    } else {
      replaceActiveTrigger(`/${command.name} `, "slash");
    }
    setSuggestionsDismissed(true);
    closeMenu();
  }

  async function selectAttachments(mode: "files" | "folders" = "files") {
    if (composerTrigger?.kind === "mention") {
      replaceActiveTrigger("", "mention");
    }
    setSuggestionsDismissed(true);
    closeMenu();
    // Open native dialog after the menu unmounts so Windows doesn't steal focus oddly.
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
    await props.onPickAttachments(mode);
    requestAnimationFrame(() => props.composerRef.current?.focus());
  }

  function syncComposerCaret(el: HTMLTextAreaElement | null) {
    if (!el) return;
    setCaret(el.selectionStart ?? el.value.length);
  }

  function handlePromptChange(value: string, nextCaret = value.length) {
    setSuggestionsDismissed(false);
    setCaret(nextCaret);
    if (
      slashCommandQuery(value, nextCaret) !== undefined ||
      addResourceQuery(value, nextCaret) !== undefined
    ) {
      closeMenu();
    }
    props.onPromptChange(value);
    // Fit on next paint so the controlled value is already in the DOM.
    requestAnimationFrame(() => fitComposerPromptHeight(props.composerRef.current));
  }

  // Keep height + highlight scroll in sync for external prompt updates (slash insert, clear, etc.).
  useLayoutEffect(() => {
    const el = props.composerRef.current;
    fitComposerPromptHeight(el);
    syncPromptHighlightScroll(el);
    const caret = pendingCaretRef.current;
    if (caret == null || !el) return;
    pendingCaretRef.current = null;
    const pos = Math.max(0, Math.min(caret, el.value.length));
    el.focus();
    el.setSelectionRange(pos, pos);
    setCaret(pos);
  }, [props.prompt, props.composerRef, props.attachments.length]);

  useEffect(() => {
    setRefTokens((current) => pruneComposerRefs(current, props.prompt));
  }, [props.prompt]);

  function clearAtTokenFromPrompt() {
    replaceActiveTrigger("", "mention");
  }

  function selectPackage(pkg: PackageSummary) {
    const label = composerRefDisplayLabel(pkg.source);
    setRefTokens((current) =>
      addComposerRef(current, {
        kind: "package",
        raw: `@${pkg.source}`,
        label,
      }),
    );
    replaceActiveTrigger(composerChipInsertText(label), "mention");
    setSuggestionsDismissed(true);
    closeMenu();
  }

  function selectProjectPath(
    absPath: string,
    _meta?: { relative?: string; kind?: "file" | "folder" },
  ) {
    clearAtTokenFromPrompt();
    props.onAddAttachments?.([absPath]);
    setSuggestionsDismissed(true);
    closeMenu();
  }

  function commitResourceIndex(index: number) {
    if (index === 0) {
      void selectAttachments("files");
      return;
    }
    if (index === 1) {
      void selectAttachments("folders");
      return;
    }
    const pathIndex = index - 2;
    if (pathIndex < pathSuggestions.length) {
      const hit = pathSuggestions[pathIndex];
      if (hit) selectProjectPath(hit.path, { relative: hit.relative, kind: hit.kind });
      return;
    }
    const pkg = packageSuggestions[pathIndex - pathSuggestions.length];
    if (pkg) selectPackage(pkg);
  }

  async function completePathWithTab(textarea: HTMLTextAreaElement) {
    const cursor = textarea.selectionStart ?? props.prompt.length;
    const token = pathTokenBeforeCursor(props.prompt, cursor);
    if (!token) return false;
    // When @ menu already has path hits, Tab accepts highlighted/first path.
    if (resourcePanelOpen && pathSuggestions.length > 0) {
      // Paths start at flat index 2 (after files + folders pickers).
      const pathStart = 2;
      const index =
        suggestionIndex >= pathStart && suggestionIndex < pathStart + pathSuggestions.length
          ? suggestionIndex
          : pathStart;
      const hit = pathSuggestions[index - pathStart];
      if (hit) {
        if (token.atMention) {
          selectProjectPath(hit.path, { relative: hit.relative, kind: hit.kind });
        } else {
          const applied = applyPathTokenCompletion(props.prompt, cursor, hit.relative);
          if (applied) {
            props.onPromptChange(applied.value);
            requestAnimationFrame(() => {
              textarea.setSelectionRange(applied.cursor, applied.cursor);
              textarea.focus();
            });
          }
        }
        return true;
      }
    }
    try {
      const rows = await window.pix.workspace.searchPaths(token.query, {
        ...(props.workspacePath ? { cwd: props.workspacePath } : {}),
        limit: 8,
      });
      const hit = rows[0];
      if (!hit) return false;
      if (token.atMention) {
        selectProjectPath(hit.path, { relative: hit.relative, kind: hit.kind });
        return true;
      }
      const applied = applyPathTokenCompletion(props.prompt, cursor, hit.relative);
      if (!applied) return false;
      props.onPromptChange(applied.value);
      requestAnimationFrame(() => {
        textarea.setSelectionRange(applied.cursor, applied.cursor);
        textarea.focus();
      });
      return true;
    } catch {
      return false;
    }
  }

  function deleteComposerChipRange(range: ReturnType<typeof findComposerChipRanges>[number]) {
    const next = removeComposerChip(props.prompt, range);
    setRefTokens((current) => current.filter((item) => item.raw !== range.token.raw));
    setSuggestionsDismissed(true);
    commitPromptWithCaret(next.text, next.cursor);
  }

  function snapCaretOutOfChip(el: HTMLTextAreaElement) {
    const caretPos = el.selectionStart ?? 0;
    if (caretPos !== (el.selectionEnd ?? caretPos)) return;
    const range = chipRangeAtCaret(findComposerChipRanges(props.prompt, refTokens), caretPos);
    if (!range) return;
    const pos = caretPos < (range.start + range.end) / 2 ? range.start : range.end;
    el.setSelectionRange(pos, pos);
    setCaret(pos);
  }

  function handleChipKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (refTokens.length === 0) return false;
    const el = event.currentTarget;
    const caretPos = el.selectionStart ?? 0;
    if (caretPos !== (el.selectionEnd ?? caretPos)) return false;
    const ranges = findComposerChipRanges(props.prompt, refTokens);
    if (ranges.length === 0) return false;

    if (event.key === "ArrowLeft") {
      const range = chipRangeAtCaret(ranges, caretPos) ?? chipRangeEndingAt(ranges, caretPos);
      if (range && caretPos !== range.start) {
        event.preventDefault();
        el.setSelectionRange(range.start, range.start);
        setCaret(range.start);
        return true;
      }
    }
    if (event.key === "ArrowRight") {
      const range = chipRangeAtCaret(ranges, caretPos) ?? chipRangeStartingAt(ranges, caretPos);
      if (range && caretPos !== range.end) {
        event.preventDefault();
        el.setSelectionRange(range.end, range.end);
        setCaret(range.end);
        return true;
      }
    }
    if (event.key === "Backspace") {
      const range = chipRangeAtCaret(ranges, caretPos) ?? chipRangeEndingAt(ranges, caretPos);
      if (range) {
        event.preventDefault();
        deleteComposerChipRange(range);
        return true;
      }
    }
    if (event.key === "Delete") {
      const range = chipRangeAtCaret(ranges, caretPos) ?? chipRangeStartingAt(ranges, caretPos);
      if (range) {
        event.preventDefault();
        deleteComposerChipRange(range);
        return true;
      }
    }
    return false;
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (isImeCompositionEvent(event.nativeEvent)) return;

    const panel = slashPanelOpen ? "slash" : resourcePanelOpen ? "resource" : undefined;
    if (panel) {
      // `/` → commands+skills; `@` → picker + project paths + packages.
      const itemCount = panel === "slash" ? slashMenuItems.length : resourceItemCount;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (itemCount > 0) {
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setSuggestionIndex((current) => {
            // No selection yet → first Down picks 0, first Up picks last.
            if (current < 0) return event.key === "ArrowDown" ? 0 : itemCount - 1;
            return (current + delta + itemCount) % itemCount;
          });
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        dismissSuggestions();
        return;
      }
      // Tab completes path / accepts first resource suggestion (pi editor parity).
      if (event.key === "Tab" && !event.shiftKey) {
        event.preventDefault();
        if (panel === "resource") {
          if (suggestionIndex >= 0) commitResourceIndex(suggestionIndex);
          else if (pathSuggestions.length > 0)
            commitResourceIndex(2); // first path after pickers
          else void selectAttachments("files");
          return;
        }
        if (panel === "slash" && slashMenuItems.length > 0) {
          const command = slashMenuItems[suggestionIndex >= 0 ? suggestionIndex : 0];
          if (command) selectCommand(command);
          return;
        }
      }
      // Only commit a menu choice when something is highlighted (keyboard or hover).
      if (event.key === "Enter" && !event.shiftKey && itemCount > 0 && suggestionIndex >= 0) {
        event.preventDefault();
        if (panel === "resource") commitResourceIndex(suggestionIndex);
        else {
          const command = slashMenuItems[suggestionIndex];
          if (command) selectCommand(command);
        }
        return;
      }
    }
    if (handleChipKeyDown(event)) return;
    if (!panel && event.key === "Tab" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      // Bare path Tab completion when no slash/@ panel is open.
      const token = pathTokenBeforeCursor(
        props.prompt,
        event.currentTarget.selectionStart ?? props.prompt.length,
      );
      if (token) {
        event.preventDefault();
        void completePathWithTab(event.currentTarget);
        return;
      }
    }
    props.onKeyDown(event);
  }

  async function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = event.clipboardData?.items;
    if (!items?.length) return;
    let hasImage = false;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        hasImage = true;
        break;
      }
    }
    if (!hasImage) return;
    event.preventDefault();
    try {
      // Prefer system clipboard image via main (handles OS paste reliably).
      const saved = await window.pix.workspace.saveClipboardImage();
      if (saved) {
        props.onAddAttachments?.([saved]);
        return;
      }
      // Fallback: file from clipboard data
      for (const item of items) {
        if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        const buffer = new Uint8Array(await file.arrayBuffer());
        const ext = file.type.includes("jpeg") || file.type.includes("jpg") ? "jpg" : "png";
        const path = await window.pix.workspace.saveClipboardImage({
          bytes: Array.from(buffer),
          ext,
        });
        if (path) props.onAddAttachments?.([path]);
        break;
      }
    } catch {
      // ignore paste failures — user can still attach via picker
    }
  }

  useEffect(() => {
    const onNativeDrop = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const drop = detail as { paths?: unknown; target?: string } | null;
      const paths = Array.isArray(detail) ? detail : drop?.paths;
      // Only the addressed/focused composer receives a native drop. Both main
      // and side composers can be mounted at the same time.
      const target =
        drop?.target ??
        document.activeElement
          ?.closest("[data-composer-surface]")
          ?.getAttribute("data-composer-surface") ??
        "main";
      if (target !== (props.surface ?? "main")) return;
      if (Array.isArray(paths) && paths.every((path) => typeof path === "string"))
        props.onAddAttachments?.(paths);
    };
    window.addEventListener("pix:native-drop", onNativeDrop);
    return () => window.removeEventListener("pix:native-drop", onNativeDrop);
  }, [props.onAddAttachments, props.surface]);

  function handleComposerDrop(event: DragEvent<HTMLTextAreaElement>) {
    const files = event.dataTransfer?.files;
    if (!files?.length) return;
    event.preventDefault();
    event.stopPropagation();
    const paths: string[] = [];
    for (const file of files) {
      const filePath = window.pix.workspace.pathForFile(file);
      if (typeof filePath === "string" && filePath) paths.push(filePath);
    }
    if (paths.length) props.onAddAttachments?.(paths);
  }

  const filteredBranches = useMemo(() => {
    // Local branches only — hide origin/* and other remote-tracking refs.
    // Keep names like feature/foo (local with slash); drop remote flag / origin/ prefix.
    const locals = branches.filter((b) => {
      if (b.remote) return false;
      if (/^(origin|upstream)\//.test(b.name)) return false;
      return true;
    });
    const q = branchQuery.trim().toLowerCase();
    if (!q) return locals;
    return locals.filter((b) => b.name.toLowerCase().includes(q));
  }, [branches, branchQuery]);

  const canCreateBranch = useMemo(() => {
    const name = branchQuery.trim();
    if (!isValidBranchName(name)) return false;
    return !branches.some((b) => b.name === name || b.name.endsWith(`/${name}`));
  }, [branchQuery, branches]);

  async function handleCheckoutBranch(name: string) {
    if (!props.workspacePath || gitBusy) return;
    setGitBusy(true);

    try {
      const next = await window.pix.workspace.checkoutGitBranch(name, props.workspacePath);
      setGitContext(next);
      closeMenu();
    } catch (error) {
      showAppError(error instanceof Error ? error.message : tr("composer.branch.failed"));
    } finally {
      setGitBusy(false);
    }
  }

  async function handleCreateCheckoutBranch() {
    const name = branchQuery.trim();
    if (!props.workspacePath || !isValidBranchName(name) || gitBusy) return;
    setGitBusy(true);

    try {
      const next = await window.pix.workspace.createGitBranch(name, {
        checkout: true,
        cwd: props.workspacePath,
      });
      setGitContext(next);
      closeMenu();
    } catch (error) {
      showAppError(error instanceof Error ? error.message : tr("composer.branch.failed"));
    } finally {
      setGitBusy(false);
    }
  }

  async function handleSwitchToLocal() {
    if (!props.workspacePath || gitBusy) return;
    const main = gitContext.mainWorktreePath;
    if (gitContext.isMainWorktree !== false) {
      closeMenu();
      return;
    }
    if (!main) {
      showAppError(tr("composer.local.failed"));
      return;
    }
    if (normalizeCwdKey(main) === normalizeCwdKey(props.workspacePath)) {
      closeMenu();
      return;
    }
    setGitBusy(true);

    try {
      closeMenu();
      props.onOpenProject(main);
    } catch (error) {
      showAppError(error instanceof Error ? error.message : tr("composer.local.failed"));
    } finally {
      setGitBusy(false);
    }
  }

  function handleNewWorktree() {
    if (!props.workspacePath || gitBusy) return;
    closeMenu();
    // Same dialog as project ⋯ → create worktree.
    window.setTimeout(() => setWorktreeDialogOpen(true), 0);
  }

  const projectMenuOpen = menu === "project";
  const localMenuOpen = menu === "local";
  const branchMenuOpen = menu === "branch";
  const hasProject = Boolean(props.workspacePath);
  const localLabel =
    gitContext.isMainWorktree === false && gitContext.worktree
      ? gitContext.worktree
      : tr("composer.local.label");

  const showProjectBar = props.showProjectBar !== false;

  return (
    <div
      ref={rootRef}
      // Parent is `.thread-content-column` (same as timeline) — fill it completely.
      className="pointer-events-auto relative w-full min-w-0 max-w-full"
      data-testid={props.surface === "side" ? "side-chat-composer" : "composer-root"}
      data-composer-surface={props.surface ?? "main"}
    >
      <ComposerQueueCard
        locale={props.locale}
        queuedMessages={props.queuedMessages}
        onClearQueue={props.onClearQueue}
      />

      {/*
        Protrusion: project / local / branch. Only for empty sessions —
        hide once the thread has conversation content.
      */}
      {showProjectBar ? (
        <div className="relative z-[2] flex w-full justify-center px-[18px]">
          <div className="composer-protrusion" data-testid="composer-project-bar">
            <button
              type="button"
              data-testid="composer-project-picker"
              aria-expanded={projectMenuOpen}
              className="composer-protrusion-chip max-w-[42%]"
              onClick={(e) => openMenu("project", e)}
            >
              <Folder className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
              <span className="min-w-0 truncate" data-testid="workspace-name-chip">
                {hasProject ? workspace.name : tr("composer.project.pick")}
              </span>
            </button>

            {hasProject ? (
              <>
                <button
                  type="button"
                  className="composer-protrusion-chip max-w-[26%]"
                  title={localLabel}
                  data-testid="composer-local"
                  aria-expanded={localMenuOpen}
                  onClick={(e) => openMenu("local", e)}
                >
                  <Monitor className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
                  <span className="min-w-0 truncate">{localLabel}</span>
                  <ChevronDown className="size-3 shrink-0 opacity-60" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  className="composer-protrusion-chip max-w-[26%]"
                  title={tr("composer.project.branch")}
                  data-testid="composer-git-branch"
                  aria-expanded={branchMenuOpen}
                  onClick={(e) => openMenu("branch", e)}
                >
                  <GitBranch className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
                  <span className="min-w-0 truncate">
                    {gitContext.branch || tr("composer.project.noBranch")}
                  </span>
                  <ChevronDown className="size-3 shrink-0 opacity-60" strokeWidth={2} />
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Full card border; joins the protrusion tab when present. */}
      <form
        ref={composerCardRef}
        className={cn("composer-card", showProjectBar && "composer-card-with-protrusion")}
        onSubmit={(event) => {
          if (props.submitDisabled) {
            event.preventDefault();
            return;
          }
          if (refTokens.length > 0) {
            const text = serializeComposerRefs(refTokens, props.prompt);
            setRefTokens([]);
            flushSync(() => props.onPromptChange(text));
          }
          props.onSubmit(event);
        }}
      >
        {props.contextHeader}
        {visibleAttachments.length > 0 ? (
          <ComposerAttachmentList
            paths={visibleAttachments}
            locale={props.locale}
            onRemove={props.onRemoveAttachment}
          />
        ) : null}

        <div className="composer-prompt-field">
          <div
            ref={promptHighlightRef}
            className="composer-prompt-highlight composer-prompt-scroll composer-prompt-type"
            aria-hidden="true"
            data-testid="prompt-highlight"
          >
            {renderHighlightSpans(promptHighlightSpans, { overlay: true, locale: props.locale })}
            {/* Trailing newline keeps last empty line height in sync with the textarea. */}
            {"\n"}
          </div>
          <Textarea
            ref={props.composerRef}
            aria-label={props.surface === "side" ? tr("selection.question") : "Prompt"}
            data-testid={props.surface === "side" ? "selection-side-chat-input" : "prompt-input"}
            value={props.prompt}
            onChange={(event) =>
              handlePromptChange(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length,
              )
            }
            onKeyDown={handleComposerKeyDown}
            onKeyUp={(event) => syncComposerCaret(event.currentTarget)}
            onClick={(event) => {
              snapCaretOutOfChip(event.currentTarget);
              syncComposerCaret(event.currentTarget);
            }}
            onSelect={(event) => {
              snapCaretOutOfChip(event.currentTarget);
              syncComposerCaret(event.currentTarget);
            }}
            onScroll={(event) => syncPromptHighlightScroll(event.currentTarget)}
            onPaste={(event) => {
              void handleComposerPaste(event);
              requestAnimationFrame(() => {
                fitComposerPromptHeight(props.composerRef.current);
                syncPromptHighlightScroll(props.composerRef.current);
              });
            }}
            onDrop={handleComposerDrop}
            onDragOver={(event) => {
              if (event.dataTransfer?.types?.includes("Files")) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            onInput={() => {
              fitComposerPromptHeight(props.composerRef.current);
              syncPromptHighlightScroll(props.composerRef.current);
            }}
            placeholder={tr(
              props.surface === "side" ? "selection.question" : "composer.placeholder",
            )}
            rows={COMPOSER_PROMPT_MIN_LINES}
            className={cn(
              "composer-prompt-scroll composer-prompt-input composer-prompt-type resize-none rounded-none border-0 bg-transparent",
              "shadow-none",
              "focus-visible:border-0 focus-visible:ring-0 focus-visible:ring-offset-0",
              "dark:bg-transparent",
            )}
          />
        </div>
        <div className="composer-toolbar">
          {/* Left: attach + access */}
          <div className="composer-toolbar-controls">
            <button
              type="button"
              data-testid="composer-attach"
              className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--muted-foreground)] hover:bg-[var(--hover-fill)] hover:text-[var(--foreground)]"
              title={tr("composer.attach")}
              aria-label={tr("composer.attach")}
              onClick={(e) => openMenu("attach", e)}
            >
              <Plus className="size-4" strokeWidth={2} />
            </button>
            <button
              type="button"
              data-testid="composer-access"
              className={cn(
                "inline-flex h-8 max-w-[11rem] items-center gap-1 rounded-full px-2",
                "text-[12px] hover:bg-[var(--hover-fill)]",
                props.accessMode === "full"
                  ? "text-[#ff5c1a] hover:bg-[#ff5c1a]/12 hover:text-[#ff4d00]"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
              )}
              onClick={(e) => openMenu("access", e)}
            >
              {accessIcon(props.accessMode)}
              <span className="min-w-0 truncate">
                {accessLabel(props.locale, props.accessMode)}
              </span>
            </button>
            {/* legacy probes (hidden) */}
            <span className="hidden" data-testid="trust-chip">
              {props.projectTrusted ? tr("workspace.trusted") : tr("workspace.untrusted")}
            </span>
            <span className="hidden" data-testid="run-state-chip">
              {props.runState}
            </span>
            <span className="hidden" data-testid="pi-theme-label">
              {props.piThemeLabel}
            </span>
          </div>

          {/* Right: context + model + send */}
          <div className="composer-toolbar-controls">
            {props.showContextUsage !== false ? (
              <ContextUsageIndicator
                label={tr("composer.context")}
                unknownLabel={tr("composer.contextUnknown")}
                percent={props.contextPercent}
                tokens={props.contextTokens}
              />
            ) : null}
            <ComposerModelPicker
              locale={props.locale}
              running={props.running}
              modelOptions={props.modelOptions}
              modelValue={props.modelValue}
              onModelChange={props.onModelChange}
              thinkingLevel={props.thinkingLevel}
              thinkingLevels={props.thinkingLevels}
              onThinkingChange={props.onThinkingChange}
              serviceTier={props.serviceTier}
              serviceTiers={props.serviceTiers}
              onServiceTierChange={props.onServiceTierChange}
              open={menu === "model"}
              anchor={anchor}
              onToggle={(event) => openMenu("model", event)}
              onClose={closeMenu}
            />
            {/* hidden native selects for e2e/compat */}
            <select
              data-testid="model-select"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              value={props.modelValue}
              disabled={!props.modelValue || props.running}
              onChange={(event) => {
                const value = event.target.value;
                const separator = value.indexOf("/");
                if (separator > 0)
                  props.onModelChange(value.slice(0, separator), value.slice(separator + 1));
              }}
            >
              {(props.modelOptions.length
                ? props.modelOptions
                : props.modelValue
                  ? [
                      {
                        provider: props.modelValue.split("/")[0]!,
                        id: props.modelValue.slice(props.modelValue.indexOf("/") + 1),
                        name: props.modelValue,
                      },
                    ]
                  : []
              ).map((model) => (
                <option
                  key={`${model.provider}/${model.id}`}
                  value={`${model.provider}/${model.id}`}
                >
                  {model.name || model.id}
                </option>
              ))}
            </select>
            <select
              data-testid="thinking-select"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              value={props.thinkingLevel}
              disabled={props.running}
              onChange={(event) => props.onThinkingChange(event.target.value)}
            >
              {props.thinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>

            {props.running ? (
              // During AI reply: send becomes a single stop control (queue still via Enter).
              <Button
                key="stop"
                type="button"
                size="icon"
                data-testid={props.surface === "side" ? "selection-side-chat-stop" : "abort-prompt"}
                disabled={props.submitDisabled}
                onClick={(event) => {
                  event.preventDefault();
                  props.onAbort();
                }}
                aria-label={tr("composer.stop")}
                title={tr("composer.stop")}
                className="h-7 w-7 rounded-full border-0 bg-foreground text-background shadow-none hover:bg-foreground/90"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
              </Button>
            ) : (
              <Button
                key="send"
                type="submit"
                size="icon"
                data-testid={props.surface === "side" ? "selection-side-chat-send" : "send-prompt"}
                disabled={
                  props.submitDisabled ||
                  (!props.prompt.trim() && props.attachments.length === 0 && refTokens.length === 0)
                }
                aria-label={tr("composer.start")}
                className="h-7 w-7 rounded-full border-0 bg-foreground text-background shadow-none hover:bg-foreground/90 disabled:opacity-30"
              >
                <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.25} />
              </Button>
            )}
          </div>
        </div>
      </form>

      <FloatingMenu
        open={slashPanelOpen && Boolean(suggestionAnchor)}
        anchor={suggestionAnchor}
        onClose={dismissSuggestions}
        placement="top"
        testId="composer-slash-menu"
        minWidth={320}
        matchAnchorWidth
        elevated={false}
        closeOnScroll={!props.running}
        offsetPx={8}
        className="!rounded-[var(--radius-panel)] !border-[var(--border)] !bg-[var(--surface-panel)] !py-0"
      >
        <div
          className="composer-suggest-body"
          data-overflow={slashOverflow.overflows ? "true" : "false"}
        >
          <div ref={slashOverflow.scrollRef} className="composer-suggest-scroll pt-0">
            {slashGroups.length === 0 ? (
              <p className="px-2.5 py-3 text-left text-[13px] text-[var(--text-subtle)]">
                {tr("composer.slash.empty")}
              </p>
            ) : (
              slashGroups.map((group) => (
                <div
                  key={group.id}
                  className="composer-suggest-group"
                  data-testid={`composer-slash-group-${group.id}`}
                >
                  <div className="composer-suggest-group-label">
                    {tr(
                      group.id === "skill"
                        ? "composer.slash.group.skill"
                        : "composer.slash.group.command",
                    )}
                  </div>
                  {group.items.map(({ command, flatIndex }) => (
                    <button
                      key={`${command.source}:${command.name}`}
                      type="button"
                      role="menuitem"
                      data-testid="composer-slash-item"
                      data-suggest-index={flatIndex}
                      data-active={
                        suggestionIndex >= 0 && flatIndex === suggestionIndex ? "true" : "false"
                      }
                      className="composer-suggest-item"
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => {
                        if (suggestionIndex !== flatIndex) setSuggestionIndex(flatIndex);
                      }}
                      onClick={() => selectCommand(command)}
                    >
                      <span className="composer-suggest-item-icon">
                        {commandSourceIcon(command)}
                      </span>
                      <span className="composer-suggest-item-copy">
                        <span className="composer-suggest-item-main">
                          {composerRefDisplayLabel(command.name)}
                        </span>
                        {command.description ? (
                          <span className="composer-suggest-item-desc">{command.description}</span>
                        ) : command.argumentHint ? (
                          <span className="composer-suggest-item-desc">{command.argumentHint}</span>
                        ) : null}
                      </span>
                      <span className="composer-suggest-item-meta">/{command.name}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
          <div className="composer-suggest-fade" aria-hidden />
        </div>
      </FloatingMenu>

      <FloatingMenu
        open={resourcePanelOpen && Boolean(menu === "attach" ? anchor : suggestionAnchor)}
        anchor={menu === "attach" ? anchor : suggestionAnchor}
        onClose={dismissSuggestions}
        placement="top"
        testId="composer-attach-menu"
        minWidth={320}
        matchAnchorWidth
        elevated={false}
        closeOnScroll={menu === "attach" || !props.running}
        offsetPx={8}
        className="!rounded-[var(--radius-panel)] !border-[var(--border)] !bg-[var(--surface-panel)] !py-0"
      >
        <div
          className="composer-suggest-body"
          data-overflow={resourceOverflow.overflows ? "true" : "false"}
        >
          <div ref={resourceOverflow.scrollRef} className="composer-suggest-scroll pt-0">
            <div className="composer-suggest-group" data-testid="composer-attach-group-add">
              <div className="composer-suggest-group-label">{tr("composer.add.title")}</div>
              {/*
                Split file vs folder pickers: on Windows/Linux Electron cannot combine
                openFile + openDirectory (directory-only dialog was the “can't pick files” bug).
              */}
              <button
                type="button"
                role="menuitem"
                data-testid="composer-attach-files"
                data-suggest-index={0}
                data-active={suggestionIndex === 0 ? "true" : "false"}
                className="composer-suggest-item"
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (suggestionIndex !== 0) setSuggestionIndex(0);
                }}
                onClick={() => void selectAttachments("files")}
              >
                <span className="composer-suggest-item-icon">
                  <File className="size-3.5" strokeWidth={1.75} />
                </span>
                <span className="composer-suggest-item-copy">
                  <span className="composer-suggest-item-main">{tr("composer.attach.files")}</span>
                </span>
                <span className="composer-suggest-item-meta">{tr("composer.meta.local")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="composer-attach-folders"
                data-suggest-index={1}
                data-active={suggestionIndex === 1 ? "true" : "false"}
                className="composer-suggest-item"
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (suggestionIndex !== 1) setSuggestionIndex(1);
                }}
                onClick={() => void selectAttachments("folders")}
              >
                <span className="composer-suggest-item-icon">
                  <FolderOpen className="size-3.5" strokeWidth={1.75} />
                </span>
                <span className="composer-suggest-item-copy">
                  <span className="composer-suggest-item-main">
                    {tr("composer.attach.folders")}
                  </span>
                </span>
                <span className="composer-suggest-item-meta">{tr("composer.meta.local")}</span>
              </button>
              {pathSuggestions.map((item, index) => {
                const flatIndex = index + 2;
                return (
                  <button
                    key={item.path}
                    type="button"
                    role="menuitem"
                    data-testid="composer-attach-path"
                    data-suggest-index={flatIndex}
                    data-active={suggestionIndex === flatIndex ? "true" : "false"}
                    className="composer-suggest-item"
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (suggestionIndex !== flatIndex) setSuggestionIndex(flatIndex);
                    }}
                    onClick={() =>
                      selectProjectPath(item.path, { relative: item.relative, kind: item.kind })
                    }
                    title={item.path}
                  >
                    <span className="composer-suggest-item-icon">
                      {item.kind === "folder" ? (
                        <Folder className="size-3.5" strokeWidth={1.75} />
                      ) : (
                        <File className="size-3.5" strokeWidth={1.75} />
                      )}
                    </span>
                    <span className="composer-suggest-item-copy">
                      <span className="composer-suggest-item-main">
                        {item.relative.split(/[/\\]/).filter(Boolean).at(-1) || item.relative}
                      </span>
                    </span>
                    {item.relative.includes("/") || item.relative.includes("\\") ? (
                      <span className="composer-suggest-item-meta">
                        {item.relative.replace(/[/\\][^/\\]+$/, "")}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {packageSuggestions.length > 0 ? (
              <div className="composer-suggest-group" data-testid="composer-attach-group-plugins">
                <div className="composer-suggest-group-label">{tr("composer.add.plugins")}</div>
                {packageSuggestions.map((pkg, index) => {
                  const flatIndex = 2 + pathSuggestions.length + index;
                  return (
                    <button
                      key={`${pkg.scope}:${pkg.source}`}
                      type="button"
                      role="menuitem"
                      data-testid={`composer-attach-package-${pkg.source}`}
                      data-suggest-index={flatIndex}
                      data-active={suggestionIndex === flatIndex ? "true" : "false"}
                      className="composer-suggest-item"
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => {
                        if (suggestionIndex !== flatIndex) setSuggestionIndex(flatIndex);
                      }}
                      onClick={() => selectPackage(pkg)}
                    >
                      <span className="composer-suggest-item-icon">
                        <Package className="size-3.5" strokeWidth={1.75} />
                      </span>
                      <span className="composer-suggest-item-copy">
                        <span className="composer-suggest-item-main">
                          {composerRefDisplayLabel(pkg.source)}
                        </span>
                        {pkg.source !== composerRefDisplayLabel(pkg.source) ? (
                          <span className="composer-suggest-item-desc">{pkg.source}</span>
                        ) : null}
                      </span>
                      <span className="composer-suggest-item-meta">
                        {pkg.scope || tr("composer.token.package")}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            <div className="composer-suggest-hint">
              <div className="composer-suggest-group-label">
                {tr("composer.attach.filesAndFolders")}
              </div>
              <p className="composer-suggest-hint-copy">{tr("composer.add.searchFiles")}</p>
            </div>
          </div>
          <div className="composer-suggest-fade" aria-hidden />
        </div>
      </FloatingMenu>

      {/* Project menu — simple list, opens upward above the pill (matches reference). */}
      <FloatingMenu
        open={projectMenuOpen && Boolean(anchor)}
        anchor={anchor}
        onClose={closeMenu}
        placement="top"
        testId="composer-project-menu"
        minWidth={260}
        className="!py-0 overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 py-2.5 text-[var(--muted-foreground)]">
          <Search className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
          <input
            autoFocus
            value={projectQuery}
            onChange={(e) => setProjectQuery(e.target.value)}
            placeholder={tr("composer.project.search")}
            data-testid="composer-project-search"
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-[var(--foreground)] outline-none placeholder:text-[var(--text-subtle)]"
          />
        </div>
        <div className="pix-scroll max-h-[220px] overscroll-contain p-1.5 pt-0.5">
          {filteredProjects.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-[var(--text-subtle)]">
              {tr("composer.project.empty")}
            </p>
          ) : (
            filteredProjects.map((path) => {
              const label = workspaceLabel(path);
              const active =
                props.workspacePath?.replace(/\\/g, "/").replace(/\/+$/, "") ===
                path.replace(/\\/g, "/").replace(/\/+$/, "");
              return (
                <button
                  key={path}
                  type="button"
                  role="menuitem"
                  data-testid="composer-project-item"
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-left text-[13px] text-[var(--foreground)] transition-colors",
                    "hover:bg-[var(--hover-fill)]",
                    active && "bg-[var(--hover-fill)] font-medium",
                  )}
                  onClick={() => {
                    closeMenu();
                    if (!active) props.onOpenProject(path);
                  }}
                >
                  <Folder className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate">{label.name}</span>
                  {active ? (
                    <Check className="size-3.5 shrink-0 opacity-80" strokeWidth={2} />
                  ) : null}
                </button>
              );
            })
          )}
        </div>
        <div className="border-t border-[var(--border)] p-1.5">
          <button
            type="button"
            role="menuitem"
            data-testid="composer-project-add"
            className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--hover-fill)]"
            onClick={() => {
              closeMenu();
              props.onAddProject();
            }}
          >
            <Plus className="size-3.5 shrink-0 opacity-80" strokeWidth={2} />
            <span className="min-w-0 flex-1 truncate">{tr("composer.project.add")}</span>
            <ChevronRight className="size-3.5 shrink-0 opacity-45" strokeWidth={2} />
          </button>
        </div>
      </FloatingMenu>

      {/* Local / worktree menu — labels only; descriptions show in a hover bubble */}
      <FloatingMenu
        open={localMenuOpen && Boolean(anchor)}
        anchor={anchor}
        onClose={() => {
          setLocalTip(null);
          closeMenu();
        }}
        placement="top"
        testId="composer-local-menu"
        minWidth={200}
        className="!py-0 overflow-hidden"
      >
        <div className="flex flex-col gap-0.5 p-1.5">
          <button
            type="button"
            role="menuitem"
            data-testid="composer-local-option-local"
            disabled={gitBusy}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
              "hover:bg-[var(--hover-fill)] disabled:opacity-50",
              gitContext.isMainWorktree !== false && "bg-[var(--accent)]/60",
            )}
            onMouseEnter={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setLocalTip({
                text: tr("composer.local.menuLocalHint"),
                x: r.right + 8,
                y: r.top + r.height / 2,
              });
            }}
            onMouseLeave={() => setLocalTip(null)}
            onClick={() => void handleSwitchToLocal()}
          >
            <Monitor className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--foreground)]">
              {tr("composer.local.menuLocal")}
            </span>
            {gitContext.isMainWorktree !== false ? (
              <Check className="size-3.5 shrink-0 text-[var(--foreground)]" strokeWidth={2} />
            ) : null}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="composer-local-option-worktree"
            disabled={gitBusy}
            className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--hover-fill)] disabled:opacity-50"
            onMouseEnter={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setLocalTip({
                text: tr("composer.local.menuNewWorktreeHint"),
                x: r.right + 8,
                y: r.top + r.height / 2,
              });
            }}
            onMouseLeave={() => setLocalTip(null)}
            onClick={() => handleNewWorktree()}
          >
            <FolderGit2 className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--foreground)]">
              {tr("composer.local.menuNewWorktree")}
            </span>
          </button>
        </div>
      </FloatingMenu>
      {localTip && typeof document !== "undefined"
        ? createPortal(
            <div
              role="tooltip"
              data-testid="composer-local-tip"
              className="surface-panel pointer-events-none fixed z-[12050] max-w-[220px] -translate-y-1/2 px-2.5 py-1.5 text-[11px] leading-snug text-[var(--muted-foreground)] shadow-lg"
              style={{ left: localTip.x, top: localTip.y }}
            >
              {localTip.text}
            </div>,
            document.body,
          )
        : null}

      {/* Branch menu — search + list + create & checkout */}
      <FloatingMenu
        open={branchMenuOpen && Boolean(anchor)}
        anchor={anchor}
        onClose={closeMenu}
        placement="top"
        testId="composer-branch-menu"
        minWidth={280}
        className="!py-0 overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 py-2.5 text-[var(--muted-foreground)]">
          <Search className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
          <input
            autoFocus
            value={branchQuery}
            onChange={(e) => setBranchQuery(e.target.value)}
            placeholder={tr("composer.branch.search")}
            data-testid="composer-branch-search"
            disabled={gitBusy}
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-[var(--foreground)] outline-none placeholder:text-[var(--text-subtle)] disabled:opacity-50"
          />
        </div>
        <div className="pix-scroll max-h-[260px] overscroll-contain p-1.5 pt-0.5">
          {branchesLoading ? (
            <p className="px-3 py-3 text-[12px] text-[var(--text-subtle)]">
              {tr("composer.branch.loading")}
            </p>
          ) : filteredBranches.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-[var(--text-subtle)]">
              {tr("composer.branch.empty")}
            </p>
          ) : (
            filteredBranches.map((branch) => (
              <button
                key={`${branch.remote ? "r" : "l"}:${branch.name}`}
                type="button"
                role="menuitem"
                data-testid="composer-branch-item"
                disabled={gitBusy}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-left text-[13px] text-[var(--foreground)] transition-colors disabled:opacity-50",
                  "hover:bg-[var(--hover-fill)]",
                  branch.current && "bg-[var(--hover-fill)] font-medium",
                )}
                onClick={() => {
                  if (!branch.current) void handleCheckoutBranch(branch.name);
                  else closeMenu();
                }}
              >
                <GitBranch className="size-3.5 shrink-0 opacity-70" strokeWidth={1.75} />
                <span className="min-w-0 flex-1 truncate">{branch.name}</span>
                {branch.current ? (
                  <Check className="size-3.5 shrink-0 opacity-80" strokeWidth={2} />
                ) : null}
              </button>
            ))
          )}
        </div>
        {canCreateBranch ? (
          <div className="border-t border-[var(--border)] p-1.5">
            <button
              type="button"
              role="menuitem"
              data-testid="composer-branch-create"
              disabled={gitBusy}
              className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-[13px] text-[var(--foreground)] transition-colors hover:bg-[var(--hover-fill)] disabled:opacity-50"
              onClick={() => void handleCreateCheckoutBranch()}
            >
              <Plus className="size-3.5 shrink-0 opacity-80" strokeWidth={2} />
              <span className="min-w-0 flex-1 truncate">
                {tr("composer.branch.createCheckout", { name: branchQuery.trim() })}
              </span>
            </button>
          </div>
        ) : null}
      </FloatingMenu>

      {/* Access menu — only options enabled in General → Permissions; open above the chip. */}
      <FloatingMenu
        open={menu === "access" && Boolean(anchor)}
        anchor={anchor}
        onClose={closeMenu}
        placement="top"
        testId="composer-access-menu"
        minWidth={288}
        offsetPx={8}
        className="!py-0"
      >
        <div className="flex flex-col gap-1.5 p-2">
          {visibleAccessModes(props.accessVisibility).map((mode) => (
            <AccessOption
              key={mode}
              icon={accessIcon(mode)}
              label={accessLabel(props.locale, mode)}
              description={accessDesc(props.locale, mode)}
              caution={mode === "full"}
              active={props.accessMode === mode}
              testId={`composer-access-${mode}`}
              onClick={() => {
                props.onAccessMode(mode);
                closeMenu();
              }}
            />
          ))}
        </div>
      </FloatingMenu>

      <CreateWorktreeDialog
        open={worktreeDialogOpen && Boolean(props.workspacePath)}
        locale={props.locale}
        projectPath={props.workspacePath ?? ""}
        onCancel={() => setWorktreeDialogOpen(false)}
        onError={(message) => showAppError(message)}
        onConfirm={({ path }) => {
          setWorktreeDialogOpen(false);
          props.onOpenProject(path);
          void refreshGitContext(path);
        }}
      />
    </div>
  );
}
