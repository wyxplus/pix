import type { Browser, Page } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { SidecarClient } from "../scripts/sidecar-client.mjs";

/** Browser UI + production Node sidecar. Native dialogs/window calls are explicit test doubles. */
export async function launchTauriHarness(
  browser: Browser,
  root: string,
  env: Record<string, string>,
) {
  let page: Page | undefined;
  const native = {
    window: { scale: 1, maximized: false },
    nativeTheme: { themeSource: "system" },
    shell: {
      openPath: async (_path: string) => "",
      openExternal: async (_url: string) => {},
      reveal: async (_path: string) => {},
    },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) },
  };
  const client = new SidecarClient(root, env, async (method: string, params: any) => {
    switch (method) {
      case "window.scale":
        // A native WebView zoom changes the CSS viewport available to the renderer.
        // Model that geometry here as well as recording the requested native scale.
        const viewport = page?.viewportSize();
        const ratio = native.window.scale / params.scale;
        native.window.scale = params.scale;
        if (page && viewport) {
          await page.setViewportSize({
            width: Math.round(viewport.width * ratio),
            height: Math.round(viewport.height * ratio),
          });
        }
        return null;
      case "window.theme":
        native.nativeTheme.themeSource = params.source;
        return null;
      case "shell.open-path":
        return native.shell.openPath(params.path);
      case "shell.open-external":
        return native.shell.openExternal(params.url);
      case "shell.reveal":
        return native.shell.reveal(params.path);
      case "dialog.open":
        return native.dialog.showOpenDialog();
      case "dialog.save":
        return { canceled: true };
      case "notifications.show":
        return true;
      case "clipboard.read-image":
        return [];
      default:
        throw new Error(`Unknown native test call: ${method}`);
    }
  });
  await client.ready;
  const dist = join(root, "dist/renderer");
  const mime: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
  };
  const server = createServer((request, response) => {
    const path = resolve(
      dist,
      `.${new URL(request.url || "/", "http://localhost").pathname.replace(/\/$/, "/index.html")}`,
    );
    if (!path.startsWith(`${dist}/`)) {
      response.writeHead(403).end();
      return;
    }
    void readFile(path).then(
      (body) => {
        response.setHeader("Content-Type", mime[extname(path)] || "application/octet-stream");
        response.end(body);
      },
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server unavailable");
  page = await browser.newPage({
    viewport: {
      width: Math.round(1440 / native.window.scale),
      height: Math.round(900 / native.window.scale),
    },
  });
  await page.exposeBinding("__pixTestInvoke", async (_source, command: string, args: any) => {
    if (command === "pix_invoke") return client.invoke(args.channel, ...args.args);
    if (command === "pix_update_configured") return false;
    if (command === "plugin:window|is_maximized") return native.window.maximized;
    if (command === "plugin:window|toggle_maximize") {
      native.window.maximized = !native.window.maximized;
      return;
    }
    if (command.startsWith("plugin:window|")) return;
    throw new Error(`Unhandled Tauri test invocation: ${command}`);
  });
  await page.addInitScript(() => {
    const scope = window as any;
    let next = 0;
    const callbacks = new Map<number, (event: unknown) => void>();
    const events = new Map<number, { event: string; handler: number }>();
    scope.isTauri = true;
    scope.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback(callback: (event: unknown) => void) {
        const id = ++next;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      invoke(command: string, args: any) {
        if (command === "plugin:event|listen") {
          const id = ++next;
          events.set(id, args);
          return Promise.resolve(id);
        }
        if (command === "plugin:event|unlisten") {
          events.delete(args.eventId);
          return Promise.resolve();
        }
        return scope.__pixTestInvoke(command, args);
      },
    };
    scope.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    scope.__pixTestEvent = (payload: unknown) => {
      for (const [id, listener] of events) {
        if (listener.event === "pix:event")
          callbacks.get(listener.handler)?.({ event: "pix:event", id, payload });
      }
    };
  });
  client.on("event", (event: unknown) => {
    void page
      .evaluate((payload) => (window as any).__pixTestEvent?.(payload), event)
      .catch(() => {});
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  return {
    page,
    native,
    evaluate<T, A = undefined>(
      callback: (context: typeof native, argument: A) => T,
      argument?: A,
    ): Promise<Awaited<T>> {
      return Promise.resolve(callback(native, argument as A));
    },
    async close() {
      await page.close();
      await client.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
