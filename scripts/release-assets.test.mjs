import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
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

await test("Linux assets exclude internal AppDir tools and other platform binaries", () => {
  const root = mkdtempSync(join(tmpdir(), "pix-release-"));
  try {
    const source = join(root, "bundle");
    const appimage = join(source, "appimage");
    const embedded = join(appimage, "Pix.AppDir", "usr", "lib", "sidecar");
    const out = join(root, "out");
    mkdirSync(embedded, { recursive: true });
    writeFileSync(join(appimage, "Pix_0.7.8.AppImage"), "installer");
    writeFileSync(join(appimage, "OpenConsole.exe"), "wrong platform");
    for (const name of ["OpenConsole.exe", "winpty-agent.exe", "fixture.deb"])
      writeFileSync(join(embedded, name), "bundled dependency");
    collect(source, out, "x86_64-unknown-linux-gnu");
    assert.deepEqual(readdirSync(out).sort(), [
      "manifest-x86_64-unknown-linux-gnu.json",
      "x86_64-unknown-linux-gnu-Pix_0.7.8.AppImage",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
