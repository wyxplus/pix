import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  authorizeFile,
  authorizeReveal,
  selectedAccess,
  workspaceAccess,
} from "./path-security.ts";

vi.mock("./transport.ts", () => ({ nativeRequest: vi.fn(async () => false) }));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("content file actions", () => {
  it("reveals workspace files, project roots and explicitly selected outside files", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pix-file-actions-")));
    roots.push(root);
    const workspace = join(root, "project");
    mkdirSync(workspace);
    workspaceAccess.grant(workspace);
    const report = join(workspace, "报告 v2.xlsx");
    const selected = join(root, "selected.pdf");
    const unselected = join(root, "unselected.pdf");
    for (const path of [report, selected, unselected]) writeFileSync(path, "document");
    selectedAccess.grant(selected);
    expect(await authorizeReveal(workspace)).toBe(workspace);
    for (const path of [report, selected]) {
      expect(await authorizeFile(path, workspace)).toBe(path);
      expect(await authorizeReveal(path, workspace)).toBe(path);
    }
    await expect(authorizeReveal(unselected, workspace)).rejects.toThrow("not authorized");
    await expect(authorizeReveal(join(workspace, "deleted.pdf"), workspace)).rejects.toThrow();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "hidden.pdf"), "document");
    symlinkSync(outside, join(workspace, "escape"), "junction");
    await expect(
      authorizeReveal(join(workspace, "escape", "hidden.pdf"), workspace),
    ).rejects.toThrow("not authorized");
  });
});
