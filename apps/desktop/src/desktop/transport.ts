import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { AppUpdateStatus } from "@pix/contracts";

type Handler = (event: undefined, payload: any) => void;

export function onWindowCloseRequested(listener: () => void): Promise<() => void> {
  return getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    listener();
  });
}
const listeners = new Map<string, Set<Handler>>();
function dispatch(channel: string, payload: unknown) {
  for (const handler of listeners.get(channel) ?? []) handler(undefined, payload);
}
// Register once, before sending any request; streaming events can precede its response.
const listening = listen<{ channel: string; payload: unknown }>("pix:event", ({ payload }) => {
  dispatch(payload.channel, payload.payload);
});
let update: Update | null = null;
let updateStatus: AppUpdateStatus | undefined;
let checking: Promise<AppUpdateStatus> | undefined;
let downloading: Promise<AppUpdateStatus> | undefined;
async function status(): Promise<AppUpdateStatus> {
  if (!updateStatus) {
    const runtime = await invoke<{ appVersion: string; isPackaged: boolean }>("pix_invoke", {
      channel: "pix:app:get-runtime",
      args: [],
    });
    const configured = await invoke<boolean>("pix_update_configured");
    updateStatus = {
      state: "idle",
      currentVersion: runtime.appVersion,
      canCheck: runtime.isPackaged && configured,
    };
  }
  return updateStatus;
}
function publish(patch: Partial<AppUpdateStatus>): AppUpdateStatus {
  updateStatus = { ...updateStatus!, ...patch };
  dispatch("pix:app:update-status", updateStatus);
  return updateStatus;
}
async function checkUpdate(): Promise<AppUpdateStatus> {
  const current = await status();
  if (!current.canCheck) return publish({ state: "not-available" });
  if (current.state === "downloaded" || current.state === "downloading") return current;
  publish({ state: "checking" });
  try {
    await update?.close();
    const proxy = await invoke<{ app: { mode: string; server?: string } }>("pix_invoke", {
      channel: "pix:proxy:get",
      args: [],
    });
    update = await check({
      timeout: 30_000,
      ...(proxy.app.mode === "custom" && proxy.app.server ? { proxy: proxy.app.server } : {}),
    });
    return publish({
      state: update ? "available" : "not-available",
      ...(update ? { availableVersion: update.version } : {}),
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return publish({ state: "error", error: String(error) });
  }
}
async function downloadUpdate(): Promise<AppUpdateStatus> {
  await status();
  if (!update) return publish({ state: "error", error: "No verified Tauri update is available" });
  publish({ state: "downloading", percent: 0 });
  let total = 0,
    downloaded = 0;
  try {
    await update.download((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        publish({ percent: total > 0 ? Math.min(100, (downloaded / total) * 100) : 0 });
      }
    });
    return publish({ state: "downloaded", percent: 100 });
  } catch (error) {
    return publish({ state: "error", error: String(error) });
  }
}

export const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<any> {
    const win = getCurrentWindow();
    // Native window controls must work independently of the sidecar/event handshake.
    if (!channel.startsWith("pix:window:")) await listening;
    switch (channel) {
      case "pix:window:minimize":
        return win.minimize();
      case "pix:window:toggle-maximize":
        await win.toggleMaximize();
        return win.isMaximized();
      case "pix:window:close":
        return win.close();
      case "pix:window:resolve-close":
        return invoke("pix_window_resolve_close", { action: args[0] });
      case "pix:window:is-maximized":
        return win.isMaximized();
      case "pix:app:get-update-status":
        return status();
      case "pix:app:check-for-updates":
        checking ??= checkUpdate().finally(() => {
          checking = undefined;
        });
        return checking;
      case "pix:app:download-update":
        downloading ??= downloadUpdate().finally(() => {
          downloading = undefined;
        });
        return downloading;
      case "pix:app:quit-and-install":
        if (!update || updateStatus?.state !== "downloaded")
          throw new Error("Download a verified update before installing");
        // Stop PTYs and every active/parked agent before installer replacement on Windows.
        await invoke("pix_invoke", { channel: "pix:host:stop", args: [] });
        await invoke("pix_invoke", { channel: "pix:terminal:dispose", args: [] });
        await update.install();
        return relaunch();
      default:
        try {
          return await invoke("pix_invoke", { channel, args });
        } catch (error) {
          throw error instanceof Error ? error : new Error(String(error));
        }
    }
  },
  on(channel: string, handler: Handler) {
    let set = listeners.get(channel);
    if (!set) {
      set = new Set();
      listeners.set(channel, set);
    }
    set.add(handler);
  },
  removeListener(channel: string, handler: Handler) {
    listeners.get(channel)?.delete(handler);
  },
};

// Native drag paths are supplied by Tauri, never guessed from browser File.name.
export function pathForFile(_file: File): string {
  return "";
}
void getCurrentWindow().onDragDropEvent(({ payload }) => {
  if (payload.type === "drop") {
    const hit = document.elementFromPoint(
      payload.position.x / window.devicePixelRatio,
      payload.position.y / window.devicePixelRatio,
    );
    const target =
      hit?.closest("[data-composer-surface]")?.getAttribute("data-composer-surface") ??
      (hit?.closest(".selection-side-chat") ? "side" : "main");
    window.dispatchEvent(
      new CustomEvent("pix:native-drop", { detail: { paths: payload.paths, target } }),
    );
  }
});

// Electron's CSS app-region is not implemented by WebKit or WebView2.
// Retain the existing drag/no-drag classes so titlebar geometry stays identical.
document.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || !(event.target instanceof Element)) return;
  if (!event.target.closest(".drag-region, .bootstrap-overlay")) return;
  if (
    event.target.closest(
      "button, a, input, textarea, select, [role=button], [contenteditable]:not([contenteditable=false]), .no-drag, .bootstrap-overlay-inner",
    )
  )
    return;
  event.preventDefault();
  const action =
    event.detail === 2 ? getCurrentWindow().toggleMaximize() : getCurrentWindow().startDragging();
  void action.catch((error) => console.error("Window titlebar action failed", error));
});

void listening
  .then(async () => {
    const initial = await status();
    if (initial.canCheck)
      setTimeout(() => {
        void ipcRenderer.invoke("pix:app:check-for-updates");
      }, 4_000);
  })
  .catch((error) => console.error("Desktop connection failed", error));
