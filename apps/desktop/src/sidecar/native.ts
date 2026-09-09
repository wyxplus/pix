import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, mkdirSync } from "node:fs";
import { nativeRequest } from "./transport.ts";

const appRoot = process.env.PIX_APP_ROOT || resolve(import.meta.dirname, "../..");
export const app = {
  isPackaged: process.env.PIX_PACKAGED === "1",
  getVersion: (): string => JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version,
  getAppPath: () => appRoot,
  isReady: () => true,
  getPath(name: "userData" | "documents" | "temp"): string {
    if (name === "temp") return tmpdir();
    if (name === "documents") return process.env.PIX_DOCUMENTS_DIR || join(homedir(), "Documents");
    const path = process.env.PIX_DATA_DIR || join(homedir(), ".pix");
    mkdirSync(path, { recursive: true });
    return path;
  },
};
type DialogOptions = {
  title?: string;
  buttonLabel?: string;
  defaultPath?: string;
  properties?: string[];
  filters?: { name: string; extensions: string[] }[];
};
export const dialog = {
  showOpenDialog: (
    _owner: unknown,
    options: DialogOptions,
  ): Promise<{ canceled: boolean; filePaths: string[] }> => nativeRequest("dialog.open", options),
  showSaveDialog: (
    _owner: unknown,
    options: DialogOptions,
  ): Promise<{ canceled: boolean; filePath?: string }> => nativeRequest("dialog.save", options),
};
export const shell = {
  openExternal: (url: string): Promise<void> => nativeRequest("shell.open-external", { url }),
  openPath: (path: string): Promise<string> => nativeRequest("shell.open-path", { path }),
  showItemInFolder: (path: string): Promise<void> => nativeRequest("shell.reveal", { path }),
};
