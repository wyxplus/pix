import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function parts(version) {
  if (version.match(stableVersion)?.[0] !== version)
    throw new Error(`Invalid stable version: ${version}`);
  const result = version.split(".").map(Number);
  if (!result.every(Number.isSafeInteger)) throw new Error(`Version is too large: ${version}`);
  return result;
}

function compare(left, right) {
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

export function nextVersion(current, tags, bump = "auto", requested = "") {
  parts(current);
  if (!["auto", "patch", "minor", "major"].includes(bump))
    throw new Error(`Unknown version bump: ${bump}`);
  const versions = tags
    .filter((tag) => tag.startsWith("v") && tag.slice(1).match(stableVersion)?.[0] === tag.slice(1))
    .map((tag) => tag.slice(1))
    .sort(compare);
  const latest = versions.at(-1);
  if (requested) {
    parts(requested);
    if ((latest && compare(requested, latest) <= 0) || compare(requested, current) < 0)
      throw new Error(`Version ${requested} must exceed existing tags and not precede ${current}`);
    return requested;
  }
  // Preserve a version already prepared in source, including the first release.
  if (bump === "auto" && (!latest || compare(current, latest) > 0)) return current;
  const base = latest && compare(latest, current) > 0 ? latest : current;
  const values = parts(base);
  const index = bump === "major" ? 0 : bump === "minor" ? 1 : 2;
  values[index]++;
  values.fill(0, index + 1);
  const next = values.join(".");
  parts(next);
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, "..");
  const current = JSON.parse(
    readFileSync(resolve(root, "apps/desktop/package.json"), "utf8"),
  ).version;
  const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8" })
    .trim()
    .split(/\r?\n/);
  console.log(nextVersion(current, tags, process.env.RELEASE_BUMP, process.env.RELEASE_VERSION));
}
