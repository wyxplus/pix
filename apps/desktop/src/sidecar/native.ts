import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, mkdirSync } from "node:fs";
import { nativeRequest } from "./transport.ts";
import { exportAccess, grantSelected } from "./path-security.ts";

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
  showOpenDialog: async (
    _owner: unknown,
    options: DialogOptions,
  ): Promise<{ canceled: boolean; filePaths: string[] }> => {
    const result = await nativeRequest<{ canceled: boolean; filePaths: string[] }>(
      "dialog.open",
      options,
    );
    if (!result.canceled) result.filePaths.forEach(grantSelected);
    return result;
  },
  showSaveDialog: async (
    _owner: unknown,
    options: DialogOptions,
  ): Promise<{ canceled: boolean; filePath?: string }> => {
    const result = await nativeRequest<{ canceled: boolean; filePath?: string }>(
      "dialog.save",
      options,
    );
    if (!result.canceled && result.filePath) exportAccess.grantOutput(result.filePath);
    return result;
  },
};
export const shell = {
  openExternal: (url: string): Promise<void> => nativeRequest("shell.open-external", { url }),
  openPath: (path: string): Promise<string> => nativeRequest("shell.open-path", { path }),
  showItemInFolder: (path: string): Promise<void> => nativeRequest("shell.reveal", { path }),
};
