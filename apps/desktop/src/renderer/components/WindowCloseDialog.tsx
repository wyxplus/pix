import { useCallback, useEffect, useRef, useState } from "react";
import { isWindowsDesktopChrome } from "../lib/desktop-chrome.ts";
import { t, type Locale } from "../lib/i18n.ts";
import {
  loadWindowCloseBehavior,
  saveWindowCloseBehavior,
  type WindowCloseAction,
} from "../lib/window-close-prefs.ts";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { Button } from "./ui/button.tsx";

export function WindowCloseDialog({ locale }: { locale: Locale }) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState<WindowCloseAction>("tray");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);

  const resolveClose = useCallback(async (choice: WindowCloseAction, persist = false) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const previous = loadWindowCloseBehavior();
    try {
      // Persist before quitting, since the process can exit before RPC resolves.
      if (persist) saveWindowCloseBehavior(choice);
      await window.pix.window.resolveClose(choice);
      setOpen(false);
    } catch (failure) {
      if (persist) {
        try {
          saveWindowCloseBehavior(previous);
        } catch {
          // Report the original error; keep the close dialog usable.
        }
      }
      setError(failure instanceof Error ? failure.message : String(failure));
      setOpen(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!isWindowsDesktopChrome()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void window.pix.window
      .onCloseRequested(() => {
        if (disposed || pending.current) return;
        const behavior = loadWindowCloseBehavior();
        if (behavior !== "ask") {
          void resolveClose(behavior);
          return;
        }
        setAction("tray");
        setRemember(false);
        setError("");
        setOpen(true);
      })
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else unlisten = unsubscribe;
      })
      .catch((failure: unknown) => {
        console.error("Could not register window close prompt", failure);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [resolveClose]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <AlertDialogContent className="max-w-sm gap-4 p-5" data-testid="window-close-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{t(locale, "window.close.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t(locale, "window.close.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <fieldset
          className="grid gap-2"
          disabled={busy}
          aria-label={t(locale, "window.close.behavior")}
        >
          {(["tray", "quit"] as const).map((choice) => (
            <label
              key={choice}
              className="flex cursor-pointer items-start gap-3 rounded-lg border p-3"
            >
              <input
                type="radio"
                name="window-close-action"
                value={choice}
                checked={action === choice}
                onChange={() => setAction(choice)}
                className="mt-1 accent-[var(--primary)]"
                data-testid={`window-close-action-${choice}`}
              />
              <span className="grid gap-1 text-sm">
                <span>{t(locale, `window.close.${choice}`)}</span>
                <span className="text-xs text-muted-foreground">
                  {t(locale, `window.close.${choice}Hint`)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
            disabled={busy}
            data-testid="window-close-remember"
          />
          {t(locale, "window.close.remember")}
        </label>
        <p className="text-xs text-muted-foreground">{t(locale, "window.close.settingsHint")}</p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={busy}
            onClick={() => setOpen(false)}
            data-testid="window-close-cancel"
          >
            {t(locale, "window.close.cancel")}
          </AlertDialogCancel>
          <Button
            disabled={busy}
            onClick={() => void resolveClose(action, remember)}
            data-testid="window-close-confirm"
          >
            {t(locale, "window.close.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
