import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isCompactSidebar, responsiveSidebarWidth } from "./sidebar-prefs.ts";

/** Native WebView zoom changes CSS viewport size, just like resizing the window. */
export function useResponsiveSidebar(
  preferredWidth: number,
  manuallyCollapsed: boolean,
  toggleManualCollapse: () => void,
) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    compact: isCompactSidebar(window.innerWidth),
  }));
  const [drawerOpen, setDrawerOpen] = useState(false);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    let frame = 0;
    const measure = () => {
      const width = Math.round(shell.getBoundingClientRect().width);
      if (width <= 0) return;
      setViewport((previous) => {
        const compact = isCompactSidebar(width, previous.compact);
        return width === previous.width && compact === previous.compact
          ? previous
          : { width, compact };
      });
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(shell);
    window.addEventListener("resize", schedule);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  // Temporary navigation never overwrites the user's saved desktop layout.
  useEffect(() => setDrawerOpen(false), [viewport.compact]);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const toggle = useCallback(() => {
    if (viewport.compact) setDrawerOpen((open) => !open);
    else toggleManualCollapse();
  }, [viewport.compact, toggleManualCollapse]);

  const overlay = viewport.compact && drawerOpen;
  const collapsed = viewport.compact ? !drawerOpen : manuallyCollapsed;
  const width = responsiveSidebarWidth(viewport.width, preferredWidth, viewport.compact);
  return {
    shellRef,
    compact: viewport.compact,
    collapsed,
    overlay,
    width,
    railWidth: collapsed || overlay ? 0 : width,
    closeDrawer,
    toggle,
  };
}
