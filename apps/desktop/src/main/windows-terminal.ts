import { spawn, type SpawnOptions } from "node:child_process";
import type { DetectedApp } from "@pix/contracts";

export function windowsTerminalLaunch(app: Pick<DetectedApp, "id" | "target">, cwd: string) {
  const args =
    app.id === "wt"
      ? ["-d", cwd]
      : app.id === "cmd"
        ? ["/d", "/k"]
        : [
            "-NoLogo",
            "-NoExit",
            "-Command",
            `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'`,
          ];
  const options: SpawnOptions = {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    shell: false,
  };
  return { file: app.target, args, options };
}

/** Resolve once the terminal starts; its interactive lifetime must not hold the UI request open. */
export async function openWindowsTerminal(
  app: Pick<DetectedApp, "id" | "target">,
  cwd: string,
): Promise<void> {
  const launch = windowsTerminalLaunch(app, cwd);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(launch.file, launch.args, launch.options);
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
