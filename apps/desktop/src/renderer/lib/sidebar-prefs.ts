import { SHELL_SIDEBAR } from "./layout.ts";

/** Fully tucked away — no icon rail; expand control is fixed after traffic lights. */
export const SIDEBAR_COLLAPSED_WIDTH = 0;
export const SIDEBAR_DEFAULT_TRANSLUCENT = true;
/** Shared by the layout transition and the delayed removal of sidebar content. */
export const SIDEBAR_MOTION_MS = 360;

export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SHELL_SIDEBAR.defaultPx;
  return Math.min(SHELL_SIDEBAR.maxPx, Math.max(SHELL_SIDEBAR.minPx, Math.round(px)));
}

export function sidebarRailWidth(collapsed: boolean, widthPx: number): number {
  return collapsed ? SIDEBAR_COLLAPSED_WIDTH : clampSidebarWidth(widthPx);
}

/** Keep enough room for conversation text, the composer, and settings controls. */
export const SIDEBAR_CONTENT_MIN_PX = 600;
export const SIDEBAR_COLLAPSE_AT_PX = SHELL_SIDEBAR.minPx + SIDEBAR_CONTENT_MIN_PX;
const SIDEBAR_REOPEN_GAP_PX = 32;

/** A small gap prevents repeated folding near the boundary while resizing or zooming. */
export function isCompactSidebar(widthPx: number, wasCompact = false): boolean {
  return widthPx < SIDEBAR_COLLAPSE_AT_PX + (wasCompact ? SIDEBAR_REOPEN_GAP_PX : 0);
}

export function responsiveSidebarWidth(
  viewportWidthPx: number,
  preferredWidthPx: number,
  compact: boolean,
): number {
  const available = compact
    ? Math.max(0, viewportWidthPx - 48)
    : Math.max(SHELL_SIDEBAR.minPx, viewportWidthPx - SIDEBAR_CONTENT_MIN_PX);
  return Math.min(clampSidebarWidth(preferredWidthPx), available);
}

/**
 * Composer sits in-flow at the bottom of the thread column (content area ends above it).
 * Horizontal inset inside that content column is always 0 (sidebar overlay uses paddingLeft).
 */
export function composerLeftOffsetInMainColumn(): number {
  return 0;
}

/** Content column left inset equals overlay rail width (paddingLeft on shell-main). */
export function mainColumnLeftForRail(railWidthPx: number): number {
  return Math.max(0, Math.round(railWidthPx));
}

/** Content column width for a shell of given size (must fill remaining, not shrink-to-content). */
export function shellMainWidth(shellWidthPx: number, railWidthPx: number): number {
  return Math.max(0, Math.round(shellWidthPx) - Math.round(railWidthPx));
}

/** Web-layer tint over native vibrancy (for unit/structural checks). */
export const SIDEBAR_TRANSLUCENT_MIX_PERCENT = 0;

/** OpenCowork-aligned dark shell hex values (for unit/structural checks). */
/** Exact OpenCowork `.dark` shell palette (main.css). */
export const OPENCOWORK_DARK = {
  background: "#191919",
  sidebar: "#151515",
  sidebarAccent: "#252525",
  sidebarBorder: "#303030",
  card: "#242424",
  border: "#3a3a3a",
  muted: "#222222",
  secondary: "#2b2b2b",
} as const;
