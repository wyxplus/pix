export type WindowCloseAction = "tray" | "quit";
export type WindowCloseBehavior = "ask" | WindowCloseAction;
const KEY = "pix.window.closeBehavior";
export const WINDOW_CLOSE_PREF_CHANGED = "pix-window-close-pref-changed";

export function loadWindowCloseBehavior(): WindowCloseBehavior {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "tray" || value === "quit") return value;
  } catch {
    // Missing or unreadable preferences must never silently choose to quit.
  }
  return "ask";
}

export function saveWindowCloseBehavior(value: WindowCloseBehavior): void {
  localStorage.setItem(KEY, value);
  window.dispatchEvent(new Event(WINDOW_CLOSE_PREF_CHANGED));
}
