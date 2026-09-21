import { expect, it } from "vite-plus/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DesktopPreferences } from "./preferences.ts";
it("serializes writes, migrates once, and persists outside browser storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-preference-test-"));
  try {
    const path = join(root, "preferences.json"),
      preferences = new DesktopPreferences(path);
    expect(await preferences.read()).toBeNull();
    await preferences.patch({ "pix.locale": "zh" }, true);
    await preferences.patch({ "pix.locale": "en" }, true);
    await Promise.all([preferences.patch({ "pix.a": "A" }), preferences.patch({ "pix.b": "B" })]);
    expect(await preferences.read()).toEqual({ "pix.locale": "zh", "pix.a": "A", "pix.b": "B" });
    await preferences.patch({ "pix.a": null });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ "pix.locale": "zh", "pix.b": "B" });
    await expect(preferences.patch({ "auth.secret": "not a UI preference" })).rejects.toThrow(
      "invalid_preference_key",
    );
    expect((await preferences.read())?.["pix.b"]).toBe("B");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
