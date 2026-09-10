import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openWindowsTerminal, windowsTerminalLaunch } from "./windows-terminal.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("Windows external terminals", () => {
  it.each(["pwsh", "powershell"])("opens %s directly and quotes PowerShell literal paths", (id) => {
    const target = "D:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const cwd = "D:\\中文 & 项目\\O'Brien [draft]";
    const launch = windowsTerminalLaunch({ id, target }, cwd);
    expect(launch.file).toBe(target);
    expect(launch.args.at(-1)).toBe(
      "Set-Location -LiteralPath 'D:\\中文 & 项目\\O''Brien [draft]'",
    );
    expect(launch.options).toMatchObject({
      cwd,
      detached: true,
      shell: false,
      windowsHide: false,
      stdio: "ignore",
    });
  });

  it("passes CMD's directory as cwd instead of interpolating it into a command", () => {
    const cwd = "D:\\中文 & 项目\\%PATH%";
    const launch = windowsTerminalLaunch(
      { id: "cmd", target: "D:\\Windows\\System32\\cmd.exe" },
      cwd,
    );
    expect(launch.args).toEqual(["/d", "/k"]);
    expect(launch.options.cwd).toBe(cwd);
  });

  it("passes Windows Terminal its resolved executable and one directory argument", () => {
    const cwd = "D:\\Project & spaces";
    const launch = windowsTerminalLaunch({ id: "wt", target: "D:\\WindowsApps\\wt.exe" }, cwd);
    expect(launch.file).toBe("D:\\WindowsApps\\wt.exe");
    expect(launch.args).toEqual(["-d", cwd]);
  });

  it("resolves on spawn without waiting for an interactive terminal to exit", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const opened = openWindowsTerminal({ id: "pwsh", target: "pwsh.exe" }, "D:\\work");
    child.emit("spawn");
    await opened;
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("reports launch errors to the caller", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const opened = openWindowsTerminal({ id: "pwsh", target: "missing.exe" }, "D:\\work");
    const rejected = expect(opened).rejects.toThrow("ENOENT");
    child.emit("error", new Error("ENOENT"));
    await rejected;
  });
});
