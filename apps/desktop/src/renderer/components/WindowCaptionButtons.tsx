/**
 * Tauri's undecorated Windows/Linux windows need renderer caption buttons.
 * Only macOS has native controls, supplied by tauri.macos.conf.json.
 */
import { useEffect, useLayoutEffect, useState } from "react";
import { Minus, Square, X, Copy } from "lucide-react";
import {
  TITLEBAR_HEIGHT_PX,
  isMacDesktopChrome,
  isWindowsDesktopChrome,
  titlebarControlTopPx,
} from "../lib/desktop-chrome.ts";
import { cn } from "../lib/utils.ts";

export function WindowCaptionButtons() {
  // Window chrome must remain usable while the sidecar starts or fails to connect.
  const visible = !isMacDesktopChrome();
  const windows = isWindowsDesktopChrome();
  const [maximized, setMaximized] = useState(false);

  useLayoutEffect(() => {
    if (!visible) return;
    document.documentElement.dataset.customWindowControls = "true";
    return () => {
      delete document.documentElement.dataset.customWindowControls;
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const unsub = window.pix.window.onStateChange((state) => {
      if (!cancelled) setMaximized(state.isMaximized);
    });
    void window.pix.window.isMaximized().then(
      (isMax) => {
        if (!cancelled) setMaximized(isMax);
      },
      () => {
        // Keep the controls visible even if the initial native state is unavailable.
      },
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }, [visible]);

  if (!visible) return null;

  const btnSize = windows ? TITLEBAR_HEIGHT_PX : 28;
  const top = titlebarControlTopPx(btnSize);

  return (
    <div
      className="window-caption-buttons no-drag"
      data-testid="window-caption-buttons"
      data-platform={windows ? "windows" : "linux"}
      style={{ height: TITLEBAR_HEIGHT_PX, top: 0 }}
      role="group"
      aria-label="Window"
    >
      <button
        type="button"
        className="window-caption-btn"
        style={{ width: btnSize, height: btnSize, marginTop: top }}
        title="Minimize"
        aria-label="Minimize"
        data-testid="window-minimize"
        onClick={() => void window.pix.window.minimize()}
      >
        <Minus className="size-3.5" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className="window-caption-btn"
        style={{ width: btnSize, height: btnSize, marginTop: top }}
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
        data-testid="window-maximize"
        onClick={() => void window.pix.window.toggleMaximize().then(setMaximized)}
      >
        {maximized ? (
          <Copy className="size-3.5 scale-x-[-1]" strokeWidth={1.75} />
        ) : (
          <Square className="size-3" strokeWidth={1.75} />
        )}
      </button>
      <button
        type="button"
        className={cn("window-caption-btn window-caption-btn-close")}
        style={{ width: btnSize, height: btnSize, marginTop: top }}
        title="Close"
        aria-label="Close"
        data-testid="window-close"
        onClick={() => void window.pix.window.close()}
      >
        <X className="size-3.5" strokeWidth={1.75} />
      </button>
    </div>
  );
}
