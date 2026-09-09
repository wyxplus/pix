import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(import.meta.dirname, "..");
export const TARGETS = {
  "aarch64-apple-darwin": "darwin-aarch64",
  "x86_64-apple-darwin": "darwin-x86_64",
  "x86_64-unknown-linux-gnu": "linux-x86_64",
  "x86_64-pc-windows-msvc": "windows-x86_64",
};
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name.endsWith(".app") ? [] : files(path);
    return [path];
  });
}
export function collect(source, destination, target) {
  if (!TARGETS[target]) throw new Error(`Unsupported target ${target}`);
  mkdirSync(destination, { recursive: true });
  const candidates = files(source).filter((path) =>
    /\.(dmg|app\.tar\.gz|AppImage|deb|rpm|exe|msi)(\.sig)?$/.test(path),
  );
  const installer = target.includes("darwin")
    ? /\.dmg$/
    : target.includes("windows")
      ? /\.exe$/
      : /\.AppImage$/;
  if (!candidates.some((path) => installer.test(path)))
    throw new Error(`Missing installer for ${target}`);
  const payload = target.includes("darwin") ? /\.app\.tar\.gz$/ : installer;
  const signed = candidates.find((path) => payload.test(path) && existsSync(`${path}.sig`));
  const outputName = (path) => `${target}-${basename(path)}`;
  for (const path of candidates) copyFileSync(path, join(destination, outputName(path)));
  const info = {
    target,
    platform: TARGETS[target],
    ...(signed
      ? { file: outputName(signed), signature: readFileSync(`${signed}.sig`, "utf8").trim() }
      : {}),
  };
  writeFileSync(join(destination, `manifest-${target}.json`), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}
export function manifest(directory, repo, tag) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag))
    throw new Error("Invalid repository or version tag");
  const records = Object.keys(TARGETS).map((target) =>
    JSON.parse(readFileSync(join(directory, `manifest-${target}.json`), "utf8")),
  );
  const signed = records.filter((record) => record.file && record.signature);
  if (signed.length && signed.length !== records.length)
    throw new Error("Incomplete signed updater release");
  const platforms = {};
  for (const record of signed) {
    if (!existsSync(join(directory, record.file)))
      throw new Error(`Missing updater payload ${record.file}`);
    platforms[record.platform] = {
      signature: record.signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(record.file)}`,
    };
  }
  const result = { version: tag.slice(1), pub_date: new Date().toISOString(), platforms };
  if (signed.length)
    writeFileSync(join(directory, "latest.json"), `${JSON.stringify(result, null, 2)}\n`);
  for (const target of Object.keys(TARGETS)) unlinkSync(join(directory, `manifest-${target}.json`));
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "collect") collect(args[0], args[1], args[args.indexOf("--target") + 1]);
  else if (command === "manifest") manifest(...args);
  else if (command === "check-version") {
    const version = JSON.parse(
      readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
    ).version;
    if (args[0] !== `v${version}`)
      throw new Error(`Tag ${args[0]} does not match desktop ${version}`);
  } else
    throw new Error(
      "Usage: release-assets.mjs collect <bundle> <out> --target <triple> | manifest <dir> <owner/repo> <tag> | check-version <tag>",
    );
}
