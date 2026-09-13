import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function versionFiles(root) {
  const packagePath = join(root, "apps/desktop/package.json");
  const cargoPath = join(root, "apps/desktop/src-tauri/Cargo.toml");
  const lockPath = join(root, "apps/desktop/src-tauri/Cargo.lock");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const cargo = readFileSync(cargoPath, "utf8");
  const lock = readFileSync(lockPath, "utf8");
  const cargoPackage = cargo.match(/\[package\]\r?\n([\s\S]*?)(?=\r?\n\[|$)/)?.[1];
  const cargoVersion = cargoPackage?.match(/^version = "([^"]+)"/m)?.[1];
  const lockPattern = /(\[\[package\]\]\r?\nname = "pix-desktop"\r?\nversion = ")([^"]+)(")/;
  const lockVersion = lock.match(lockPattern)?.[2];
  if (!pkg.version || !cargoVersion || !lockVersion)
    throw new Error("Missing desktop version in package.json, Cargo.toml or Cargo.lock");
  return {
    packagePath,
    cargoPath,
    lockPath,
    pkg,
    cargo,
    lock,
    cargoPackage,
    cargoVersion,
    lockPattern,
    lockVersion,
  };
}

export function checkVersion(root, tag) {
  const { pkg, cargoVersion, lockVersion } = versionFiles(root);
  if ([pkg.version, cargoVersion, lockVersion].some((version) => tag !== `v${version}`))
    throw new Error(
      `Tag ${tag} does not match desktop ${pkg.version}, Cargo ${cargoVersion}, lockfile ${lockVersion}`,
    );
}

export function setVersion(root, version) {
  const match = version?.match(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/,
  );
  if (!match || match[0] !== version) throw new Error("Usage: pnpm version:set <semver>");
  // Validate all files before writing so missing Rust entries cannot leave only
  // package.json bumped or silently produce mismatched installers.
  const { packagePath, cargoPath, lockPath, pkg, cargo, lock, cargoPackage, lockPattern } =
    versionFiles(root);
  const previous = pkg.version;
  pkg.version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(
    cargoPath,
    cargo.replace(cargoPackage, cargoPackage.replace(/^(version = ")[^"]+/m, `$1${version}`)),
  );
  writeFileSync(lockPath, lock.replace(lockPattern, `$1${version}$3`));
  return previous;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  const previous = setVersion(resolve(import.meta.dirname, ".."), version);
  console.log(`@pix/desktop ${previous} -> ${version}`);
  console.log(`Desktop, Rust package and lockfile are synchronized for v${version}.`);
}
