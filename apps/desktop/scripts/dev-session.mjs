import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "vite";

/** Own the frontend in this process, and the Tauri/Cargo tree in one process group. */
export async function runDevSession({ configFile, cwd, env, command, args, onReady }) {
  const httpServer = createHttpServer();
  const frontend = await createServer({
    configFile,
    clearScreen: false,
    // Middleware mode leaves signal handling to this launcher. Standalone Vite
    // installs a SIGTERM hook that exits before the native tree finishes cleanup.
    server: { middlewareMode: true, ws: { server: httpServer } },
  });
  httpServer.on("request", (request, response) => frontend.middlewares(request, response));
  let child;
  let stop;
  const stopped = new Promise((resolve) => {
    stop = resolve;
  });
  const onInterrupt = () => stop(0);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    let port = frontend.config.server.port ?? 1420;
    for (;;) {
      try {
        httpServer.listen(port, "127.0.0.1");
        await once(httpServer, "listening");
        break;
      } catch (error) {
        if (error.code !== "EADDRINUSE" || port === 0 || port >= 65535) throw error;
        port++;
      }
    }
    const address = httpServer.address();
    const url = `http://127.0.0.1:${address.port}`;
    console.log(`Pix frontend: ${url}`);
    onReady?.(url);
    child = spawn(command, args(url), {
      cwd,
      env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });
    return await Promise.race([exited, stopped]);
  } finally {
    await Promise.allSettled([
      frontend.close(),
      new Promise((resolve) => httpServer.close(resolve)),
      stopProcessTree(child),
    ]);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}

async function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Tauri may already have exited with its children.
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return;
    throw error;
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    await delay(100);
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
