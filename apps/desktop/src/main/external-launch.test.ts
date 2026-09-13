import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { launchDetached } from "./external-launch.ts";
import { openWorkspaceFile } from "./open-file.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe("editor process arguments", () => {
  it("passes a metacharacter-containing directory without a shell and resolves on spawn", async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const args = ["--", "C:\\work & echo injected\\project"];
    const launched = launchDetached("C:\\Code.exe", args);
    expect(spawn).toHaveBeenCalledWith(
      "C:\\Code.exe",
      args,
      expect.objectContaining({ shell: false }),
    );
    child.emit("spawn");
    await launched;
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("forwards line and column through the actual file-open dispatcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "pix-editor-test-"));
    try {
      const path = join(root, "source.ts");
      writeFileSync(path, "const x = 1;");
      const native = vi.fn(async () => undefined);
      await openWorkspaceFile(
        path,
        { line: 12, column: 3 },
        [{ id: "vscode", name: "VS Code", kind: "ide", target: "C:\\Code.exe" }],
        native,
      );
      expect(native).toHaveBeenCalledWith("shell.open-editor", {
        path,
        executable: "C:\\Code.exe",
        args: ["--goto", `${path}:12:3`],
      });
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
