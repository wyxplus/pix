import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { loadPromptImages } from "../src/prompt-images.ts";
import { mergeSettingValue } from "../src/settings-merge.ts";

describe("image and settings boundaries", () => {
  it("loads allowed images but rejects outside paths, symlink escapes and non-images", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pix-image-scope-")));
    try {
      const workspace = join(root, "project");
      await mkdir(workspace);
      const inside = join(workspace, "image.png");
      const outside = join(root, "private.png");
      await writeFile(inside, "allowed");
      await writeFile(outside, "private");
      expect((await loadPromptImages([inside], [workspace]))[0]?.data).toBe(
        (await readFile(inside)).toString("base64"),
      );
      await expect(loadPromptImages([outside], [workspace])).rejects.toThrow("outside");
      await symlink(root, join(workspace, "link"), "junction");
      await expect(
        loadPromptImages([join(workspace, "link/private.png")], [workspace]),
      ).rejects.toThrow("outside");
      const wrong = join(workspace, "file.txt");
      await writeFile(wrong, "text");
      await expect(loadPromptImages([wrong], [workspace])).rejects.toThrow("Unsupported");
      await expect(loadPromptImages([inside], [])).rejects.toThrow("outside");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges normal values while dropping prototype-changing keys at merged levels", () => {
    const project = JSON.parse(
      '{"retry":{"enabled":false,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}},"__proto__":{"polluted":true}}',
    );
    const merged = mergeSettingValue({ retry: { enabled: true, attempts: 3 } }, project) as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(merged)).toBeNull();
    expect(merged.retry).toEqual({ enabled: false, attempts: 3 });
    expect(Object.hasOwn(merged, "__proto__")).toBe(false);
    expect(Object.getPrototypeOf(merged.retry)).toBeNull();
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });
});
