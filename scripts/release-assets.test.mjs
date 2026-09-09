import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { collect, manifest, TARGETS } from "./release-assets.mjs";

await test("Tauri releases require installers and complete signed platform feeds", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-release-"));
  try {
    const out = join(root, "out");
    for (const target of Object.keys(TARGETS)) {
      const source = join(root, target);
      mkdirSync(source);
      assert.throws(() => collect(source, out, target), /Missing installer/);
      const file = target.includes("darwin")
        ? "Pix_0.7.7.app.tar.gz"
        : target.includes("windows")
          ? "Pix_0.7.7.exe"
          : "Pix_0.7.7.AppImage";
      if (target.includes("darwin")) writeFileSync(join(source, "Pix_0.7.7.dmg"), "installer");
      writeFileSync(join(source, file), "payload");
      writeFileSync(join(source, `${file}.sig`), "verified-by-tauri-at-install");
      collect(source, out, target);
    }
    const feed = manifest(out, "num-scope/pix", "v0.7.7");
    assert.equal(Object.keys(feed.platforms).length, 4);
    assert.equal(feed.version, "0.7.7");
    assert.ok(existsSync(join(out, "latest.json")));
    assert.match(feed.platforms["darwin-aarch64"].url, /aarch64-apple-darwin/);
    assert.ok(!existsSync(join(out, "manifest-aarch64-apple-darwin.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await test("unsigned manual releases do not advertise an updater payload", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-release-"));
  try {
    for (const [target, platform] of Object.entries(TARGETS))
      writeFileSync(join(root, `manifest-${target}.json`), JSON.stringify({ target, platform }));
    manifest(root, "num-scope/pix", "v0.7.7");
    assert.ok(!existsSync(join(root, "latest.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
