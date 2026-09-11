import { useEffect, useState } from "react";
import { isWindowsDesktopChrome } from "../../lib/desktop-chrome.ts";
import { t, type Locale } from "../../lib/i18n.ts";
import {
  loadWindowCloseBehavior,
  saveWindowCloseBehavior,
  WINDOW_CLOSE_PREF_CHANGED,
  type WindowCloseBehavior,
} from "../../lib/window-close-prefs.ts";
import { useShellStore } from "../../store/shell-store.ts";
import { SettingsRow, SettingsSelect } from "./SettingsPrimitives.tsx";

export function WindowCloseSettings({ locale }: { locale: Locale }) {
  const [behavior, setBehavior] = useState(loadWindowCloseBehavior);
  const showAppError = useShellStore((state) => state.showAppError);
  useEffect(() => {
    const refresh = () => setBehavior(loadWindowCloseBehavior());
    window.addEventListener(WINDOW_CLOSE_PREF_CHANGED, refresh);
    return () => window.removeEventListener(WINDOW_CLOSE_PREF_CHANGED, refresh);
  }, []);
  if (!isWindowsDesktopChrome()) return null;
  return (
    <SettingsRow
      title={t(locale, "window.close.behavior")}
      description={t(locale, "window.close.settingsDescription")}
      control={
        <SettingsSelect
          testId="settings-window-close-behavior"
          value={behavior}
          options={(["ask", "tray", "quit"] as const).map((value) => ({
            value,
            label: t(locale, `window.close.${value}`),
          }))}
          onChange={(value) => {
            try {
              saveWindowCloseBehavior(value as WindowCloseBehavior);
            } catch (error) {
              showAppError(error instanceof Error ? error.message : String(error));
            }
          }}
        />
      }
    />
  );
}
