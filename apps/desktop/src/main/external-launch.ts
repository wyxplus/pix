import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { win32 } from "node:path";

/** Quote the shell argument first, then transport it as an AppleScript string. */
export function terminalDirectoryCommand(cwd: string): string {
  return `cd -- '${cwd.replace(/'/g, "'\\''")}'`;
}

export function macTerminalScript(app: "Terminal" | "iTerm", cwd: string): string {
  const command = terminalDirectoryCommand(cwd).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (app === "Terminal") return `tell application "Terminal" to do script "${command}"`;
  return `tell application "iTerm"
  activate
  if (count of windows) = 0 then create window with default profile
  tell current window
    create tab with default profile
    tell current session to write text "${command}"
  end tell
end tell`;
}

/** PATH often returns a .cmd shim; launch the corresponding editor EXE without cmd.exe. */
export function windowsEditorExecutable(target: string, exists = existsSync): string {
  if (/\.exe$/i.test(target)) return target;
  const bin = win32.dirname(target);
  const root = win32.resolve(bin, "..");
  const stem = win32.basename(target, win32.extname(target)).toLowerCase();
  const candidates = [
    ...(["goland", "pycharm"].includes(stem)
      ? [win32.join(bin, `${stem}64.exe`), win32.join(bin, `${stem}.exe`)]
      : []),
    ...["Code.exe", "Code - Insiders.exe", "Cursor.exe", "Windsurf.exe"].map((name) =>
      win32.join(root, name),
    ),
  ];
  const executable = candidates.find(exists);
  if (!executable) throw new Error("Cannot safely launch this editor: executable not found");
  return executable;
}

export async function launchDetached(file: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
