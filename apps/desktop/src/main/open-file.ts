import { statSync } from "node:fs";
import { extname } from "node:path";
import type { DetectedApp } from "@pix/contracts";
import { windowsEditorExecutable } from "./external-launch.ts";

export const PASSIVE_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".avif",
  ".heic",
  ".tif",
  ".tiff",
  ".pdf",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".m4a",
  ".mp4",
  ".mov",
  ".webm",
]);
const EXECUTABLE_EXTENSIONS =
  /\.(?:app|command|terminal|exe|com|bat|cmd|msi|msix|scr|pif|lnk|desktop|appimage|jar|workflow|scpt|scptd|webloc|url)$/i;

export function validateOpenFile(path: string): void {
  if (
    !statSync(path).isFile() ||
    path.split(/[\\/]/).some((part) => EXECUTABLE_EXTENSIONS.test(part))
  ) {
    throw new Error("Executable files and application bundles cannot be opened from content links");
  }
}

export function editorArguments(
  path: string,
  location?: { line?: number; column?: number },
): string[] {
  for (const value of [location?.line, location?.column]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new Error("Invalid file location");
  }
  return location?.line
    ? ["--goto", `${path}:${location.line}:${location.column ?? 1}`]
    : ["--", path];
}

export async function openWorkspaceFile(
  path: string,
  location: { line?: number; column?: number } | undefined,
  targets: DetectedApp[],
  native: (method: string, params: unknown) => Promise<unknown>,
): Promise<void> {
  validateOpenFile(path);
  const args = editorArguments(path, location);
  if (PASSIVE_FILE_EXTENSIONS.has(extname(path).toLowerCase()) && !location?.line) {
    await native("shell.open-path", { path });
    return;
  }
  const editor = targets.find((target) =>
    ["vscode", "vscode-insiders", "cursor"].includes(target.id),
  );
  if (editor) {
    const target =
      process.platform === "win32" ? windowsEditorExecutable(editor.target) : editor.target;
    await native("shell.open-editor", { path, executable: target, args });
  } else {
    if (location?.line)
      throw new Error("Install VS Code or Cursor to open a file at a specific line");
    await native("shell.open-text", { path });
  }
}
