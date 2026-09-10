import { SettingsManager } from "@earendil-works/pi-coding-agent";

const WINDOWS_DEFAULT_TOOLS = [
  "read",
  "powershell",
  "edit",
  "write",
  "ls",
  "find",
  "grep",
] as const;

/** Supply Windows defaults without persisting settings or restricting extension tools. */
export function createPlatformSettingsManager(
  cwd: string,
  agentDir: string,
  options: Parameters<typeof SettingsManager.create>[2],
  platform: NodeJS.Platform = process.platform,
): SettingsManager {
  const settings = SettingsManager.create(cwd, agentDir, options);
  if (platform === "win32") {
    const getConfiguredTools = settings.getDefaultTools.bind(settings);
    // A getter fallback survives reload(), saves and project-trust changes;
    // applyOverrides() would be discarded when pi rebuilds merged settings.
    settings.getDefaultTools = () => getConfiguredTools() ?? [...WINDOWS_DEFAULT_TOOLS];
  }
  return settings;
}
