// Exercise production assets from an installed/extracted package, with isolated profiles only.
import { readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { validationSource } from "./validation-source.mjs";
const exec = promisify(execFile);
const { values } = parseArgs({
  options: {
    "installed-root": { type: "string" },
    artifact: { type: "string" },
    out: { type: "string" },
    target: { type: "string" },
    node: { type: "string" },
    resources: { type: "string" },
  },
});
if (!values["installed-root"] || !values.out || !values.target)
  throw new Error(
    "Required: --installed-root PATH --target TRIPLE --out NEW_REPORT_JSON [--artifact INSTALLER]",
  );
const root = resolve(values["installed-root"]);
const resources = values.resources
  ? resolve(values.resources)
  : process.platform === "darwin"
    ? join(root, "Contents", "Resources")
    : root;
const binary = values.node
  ? resolve(values.node)
  : process.platform === "darwin"
    ? join(root, "Contents", "MacOS", "node")
    : join(root, process.platform === "win32" ? "node.exe" : "node");
const sidecar = join(resources, "sidecar");
const sourceSha256 = await validationSource(resolve(import.meta.dirname, "../../.."));
const report = {
  target: values.target,
  sourceSha256,
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  installed: true,
  installedRoot: root,
  memorySmoke: false,
  migrationSmoke: false,
  sidecarSmoke: false,
  sharedNodeSmoke: false,
  signature: "not_checked",
  steps: [],
};
const output = resolve(values.out);
await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
try {
  const expected = {
    darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
    win32: { x64: "x86_64-pc-windows-msvc" },
    linux: { x64: "x86_64-unknown-linux-gnu" },
  }[process.platform]?.[process.arch];
  if (values.target !== expected)
    throw new Error("installer_target_does_not_match_validation_host");
  await stat(join(sidecar, "dist", "sidecar", "memory-worker.mjs"));
  const stagedSource = JSON.parse(await readFile(join(sidecar, "validation-source.json"), "utf8"));
  if (stagedSource.sourceSha256 !== sourceSha256 || stagedSource.target !== values.target)
    throw new Error("installed_source_or_target_mismatch");
  report.bundledNode = (await exec(binary, ["--version"])).stdout.trim();
  report.memoryWorkerSha256 = createHash("sha256")
    .update(await readFile(join(sidecar, "dist", "sidecar", "memory-worker.mjs")))
    .digest("hex");
  if (values.artifact) {
    const bytes = await readFile(resolve(values.artifact));
    report.installerSha256 = createHash("sha256").update(bytes).digest("hex");
    report.installerBytes = bytes.length;
  }
  if (process.platform === "darwin") {
    await exec("codesign", ["--verify", "--deep", "--strict", root]);
    const info = await exec("codesign", ["-dv", "--verbose=4", root]);
    report.signature = info.stderr.includes("Signature=adhoc") ? "ad-hoc" : "signed";
    report.notarization = "not_verified";
  }
  const env = {
    ...process.env,
    PIX_SMOKE_ROOT: sidecar,
    PIX_SMOKE_NODE: binary,
    PIX_RESOURCES_DIR: resources,
    PIX_PACKAGED: "1",
  };
  for (const [script, key] of [
    ["memory-smoke.test.mjs", "memorySmoke"],
    ["installed-memory-migration.test.mjs", "migrationSmoke"],
    ["sidecar-smoke.test.mjs", "sidecarSmoke"],
    ["shared-node-smoke.test.mjs", "sharedNodeSmoke"],
  ]) {
    const start = performance.now();
    try {
      const result = await exec(process.execPath, [join(import.meta.dirname, script)], {
        env,
        timeout: 240000,
        maxBuffer: 2_000_000,
      });
      report[key] = true;
      report.steps.push({
        script,
        passed: true,
        ms: performance.now() - start,
        output: result.stdout.slice(-4000),
      });
    } catch (e) {
      report.steps.push({
        script,
        passed: false,
        ms: performance.now() - start,
        error: `${e.stdout ?? ""}\n${e.stderr ?? e.message}`.slice(-6000),
      });
      throw e;
    } finally {
      await save();
    }
  }
  report.passed = true;
} catch (e) {
  report.passed = false;
  report.error = String(e.message).slice(0, 2000);
  process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      report: output,
      passed: report.passed,
      memorySmoke: report.memorySmoke,
      migrationSmoke: report.migrationSmoke,
      signature: report.signature,
    }),
  );
}
