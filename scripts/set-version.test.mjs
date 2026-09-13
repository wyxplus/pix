import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkVersion, setVersion } from "./set-version.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pix-version-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "apps/desktop/src-tauri"), { recursive: true });
  const pkg = join(root, "apps/desktop/package.json");
  const cargo = join(root, "apps/desktop/src-tauri/Cargo.toml");
  const lock = join(root, "apps/desktop/src-tauri/Cargo.lock");
  writeFileSync(pkg, JSON.stringify({ name: "@pix/desktop", version: "0.7.8" }));
  writeFileSync(
    cargo,
    '[package]\nname = "pix-desktop"\nversion = "0.7.8"\n\n[dependencies]\ntauri = "2"\n',
  );
  writeFileSync(
    lock,
    'version = 4\n\n[[package]]\nname = "another-dependency"\nversion = "0.7.8"\n\n[[package]]\nname = "pix-desktop"\nversion = "0.7.8"\n',
  );
  return { root, pkg, cargo, lock };
}

await test("version changes synchronize desktop and Rust without changing dependencies", (t) => {
  const { root, pkg, lock } = fixture(t);
  assert.equal(setVersion(root, "0.8.0"), "0.7.8");
  checkVersion(root, "v0.8.0");
  assert.equal(JSON.parse(readFileSync(pkg, "utf8")).version, "0.8.0");
  assert.match(readFileSync(lock, "utf8"), /name = "another-dependency"\nversion = "0.7.8"/);
  assert.throws(() => checkVersion(root, "v0.7.8"), /does not match/);
});

await test("the release gate catches Rust version drift", (t) => {
  const { root, lock } = fixture(t);
  writeFileSync(
    lock,
    readFileSync(lock, "utf8").replace(
      'name = "pix-desktop"\nversion = "0.7.8"',
      'name = "pix-desktop"\nversion = "0.7.7"',
    ),
  );
  assert.throws(() => checkVersion(root, "v0.7.8"), /does not match/);
  setVersion(root, "0.8.0");
  checkVersion(root, "v0.8.0");
});

await test("missing Rust metadata or invalid versions leave source files untouched", (t) => {
  const { root, pkg, lock } = fixture(t);
  const before = readFileSync(pkg, "utf8");
  assert.throws(() => setVersion(root, "v0.8.0"), /Usage/);
  assert.equal(readFileSync(pkg, "utf8"), before);
  writeFileSync(lock, "version = 4\n");
  assert.throws(() => setVersion(root, "0.8.0"), /Missing desktop version/);
  assert.equal(readFileSync(pkg, "utf8"), before);
});
