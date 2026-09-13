import assert from "node:assert/strict";
import { test } from "node:test";
import { nextVersion } from "./next-version.mjs";

await test("first and pre-bumped releases retain the source version", () => {
  assert.equal(nextVersion("0.7.8", []), "0.7.8");
  assert.equal(nextVersion("0.8.0", ["v0.7.8"]), "0.8.0");
});

await test("automatic releases increase the highest stable version numerically", () => {
  assert.equal(nextVersion("0.7.8", ["v0.7.8"]), "0.7.9");
  assert.equal(nextVersion("0.7.8", ["v0.7.9", "v0.7.10", "v0.7.2"]), "0.7.11");
  assert.equal(nextVersion("0.7.8", ["v1.0.0", "v2.0.0-rc.1", "unrelated"]), "1.0.1");
});

await test("manual bumps and exact versions support planned releases", () => {
  assert.equal(nextVersion("0.7.8", [], "patch"), "0.7.9");
  assert.equal(nextVersion("0.7.8", ["v0.7.8"], "minor"), "0.8.0");
  assert.equal(nextVersion("0.7.8", ["v0.7.8"], "major"), "1.0.0");
  assert.equal(nextVersion("0.7.8", [], "auto", "0.7.8"), "0.7.8");
  assert.equal(nextVersion("0.7.8", ["v0.7.8"], "auto", "1.2.3"), "1.2.3");
});

await test("invalid, duplicate and regressive versions fail before tagging", () => {
  for (const version of ["01.2.3", "v1.2.3", "1.2", "1.2.3-rc.1", "1.2.3\n", "1.2.3; echo x"])
    assert.throws(() => nextVersion("0.7.8", [], "auto", version), /Invalid stable version/);
  assert.throws(() => nextVersion("0.7.8", ["v0.7.8"], "auto", "0.7.8"), /must exceed/);
  assert.throws(() => nextVersion("0.8.0", [], "auto", "0.7.9"), /must exceed/);
  assert.throws(() => nextVersion("0.7.8", [], "other"), /Unknown version bump/);
  assert.throws(() => nextVersion("1.0.9007199254740991", [], "patch"), /too large/);
});
