import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPowerShellTool } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPixRuntime, type CreatePixRuntimeOptions } from "../src/index.ts";
import * as platformTools from "../src/platform-tools.ts";

const createSettings = platformTools.createPlatformSettingsManager;
const temporaryDirectories: string[] = [];
const windowsTools = ["read", "powershell", "edit", "write", "ls", "find", "grep"];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pix-platform-tools-"));
  temporaryDirectories.push(root);
  const cwd = join(root, "project with spaces 中文");
  const agentDir = join(root, "agent");
  await Promise.all([mkdir(join(cwd, ".pi"), { recursive: true }), mkdir(agentDir)]);
  return { cwd, agentDir };
}

async function withWindowsRuntime(
  options: Partial<CreatePixRuntimeOptions>,
  run: (handle: Awaited<ReturnType<typeof createPixRuntime>>) => Promise<void>,
) {
  const paths = await fixture();
  await mkdir(join(paths.agentDir, "extensions"));
  await writeFile(
    join(paths.agentDir, "extensions", "fixture.ts"),
    `export default function (pi) {
      pi.registerTool({
        name: "fixture_tool", label: "Fixture", description: "Fixture extension tool",
        parameters: { type: "object", properties: {} },
        async execute() { return { content: [{ type: "text", text: "ok" }] }; }
      });
    }`,
  );
  // Exercise the actual Pix session lifecycle and SDK on every CI host while
  // substituting only the platform default, not process.platform or SDK tools.
  vi.spyOn(platformTools, "createPlatformSettingsManager").mockImplementation(
    (cwd, agentDir, settingsOptions) => createSettings(cwd, agentDir, settingsOptions, "win32"),
  );
  const handle = await createPixRuntime({ ...paths, projectTrusted: true, ...options });
  try {
    await run(handle);
  } finally {
    await handle.dispose();
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("platform tool defaults", () => {
  it("keeps Windows defaults through settings saves, reloads and trust changes without persisting them", async () => {
    const { cwd, agentDir } = await fixture();
    const settings = createSettings(cwd, agentDir, { projectTrusted: false }, "win32");
    expect(settings.getDefaultTools()).toEqual(windowsTools);
    settings.getDefaultTools()?.pop();
    expect(settings.getDefaultTools()).toEqual(windowsTools);
    settings.setTheme("dark");
    await settings.flush();
    await settings.reload();
    settings.setProjectTrusted(true);
    expect(settings.getDefaultTools()).toEqual(windowsTools);
    expect(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"))).toEqual({
      theme: "dark",
    });
    expect(settings.getProjectSettings()).toEqual({});
  });

  it("honors configured defaults, including empty lists and trusted project precedence", async () => {
    const { cwd, agentDir } = await fixture();
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultTools: ["read", "bash"] }),
    );
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: [] }));
    const settings = createSettings(cwd, agentDir, { projectTrusted: false }, "win32");
    expect(settings.getDefaultTools()).toEqual(["read", "bash"]);
    settings.setProjectTrusted(true);
    expect(settings.getDefaultTools()).toEqual([]);
    await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["ls"] }));
    await settings.reload();
    expect(settings.getDefaultTools()).toEqual(["ls"]);
  });

  it.each(["darwin", "linux"] as const)("retains pi defaults on %s", async (platform) => {
    const { cwd, agentDir } = await fixture();
    expect(createSettings(cwd, agentDir, {}, platform).getDefaultTools()).toBeUndefined();
  });

  it("enables native PowerShell plus extensions across reload and session replacement", async () => {
    await withWindowsRuntime({}, async (handle) => {
      const expected = [...windowsTools, "fixture_tool"].sort();
      expect(handle.snapshot().activeTools.toSorted()).toEqual(expected);
      expect(
        handle.runtime.session.agent.state.tools.find((tool) => tool.name === "powershell")
          ?.description,
      ).toContain("PowerShell");
      await handle.reload();
      expect(handle.snapshot().activeTools.toSorted()).toEqual(expected);
      await handle.newSession();
      expect(handle.snapshot().activeTools.toSorted()).toEqual(expected);

      const sessionPath = join(handle.runtime.services.agentDir, "resume.jsonl");
      await writeFile(
        sessionPath,
        `${JSON.stringify({ type: "session", version: 3, id: "resume-tools", timestamp: new Date().toISOString(), cwd: handle.runtime.cwd })}\n`,
      );
      await handle.switchSession(sessionPath);
      expect(handle.snapshot().activeTools.toSorted()).toEqual(expected);

      await writeFile(join(handle.runtime.cwd, "目录内容.txt"), "contents");
      const ls = handle.runtime.session.agent.state.tools.find((tool) => tool.name === "ls")!;
      const result = await ls.execute("list-directory", { path: handle.runtime.cwd });
      expect(JSON.stringify(result.content)).toContain("目录内容.txt");
    });
  });

  it.each([
    { options: { tools: ["read"] }, expected: ["read"] },
    { options: { noTools: "all" as const }, expected: [] },
    { options: { noTools: "builtin" as const }, expected: ["fixture_tool"] },
  ])("preserves explicit restrictions $options through reload", async ({ options, expected }) => {
    await withWindowsRuntime(options, async (handle) => {
      expect(handle.snapshot().activeTools).toEqual(expected);
      await handle.reload();
      expect(handle.snapshot().activeTools).toEqual(expected);
    });
  });

  // Native cold startup can exceed Vitest's default five-second test budget.
  // Keep each command's own timeout below the enclosing test timeout.
  it.runIf(process.platform === "win32")(
    "falls back to Windows PowerShell without Git Bash or PowerShell 7 on PATH",
    async () => {
      const { cwd } = await fixture();
      const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      vi.stubEnv("PATH", `${join(system32, "WindowsPowerShell", "v1.0")};${system32}`);
      const result = await createPowerShellTool(cwd).execute("powershell-fallback", {
        command: '$PSVersionTable.PSEdition; Write-Output "中文回退"',
        timeout: 10,
      });
      expect(JSON.stringify(result.content)).toContain("Desktop");
      expect(JSON.stringify(result.content)).toContain("中文回退");
    },
    30_000,
  );

  it.runIf(process.platform === "win32")(
    "executes native PowerShell with Unicode, spaces and nonzero exit status",
    async () => {
      const { cwd } = await fixture();
      await writeFile(join(cwd, "中文文件.txt"), "ok");
      const tool = createPowerShellTool(cwd);
      const result = await tool.execute("powershell-native", {
        command:
          'Get-ChildItem -LiteralPath . | Select-Object -ExpandProperty Name; Write-Output "中文输出"',
        timeout: 10,
      });
      expect(JSON.stringify(result.content)).toContain("中文文件.txt");
      expect(JSON.stringify(result.content)).toContain("中文输出");
      await expect(
        tool.execute("powershell-failure", { command: "exit 7", timeout: 10 }),
      ).rejects.toThrow("Command exited with code 7");
    },
    30_000,
  );
});
