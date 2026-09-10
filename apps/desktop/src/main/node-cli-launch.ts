import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { candidateCommandPaths } from "./shell-path.ts";

/** Run Windows npm/pi shims through their JS entrypoints, preserving literal argv. */
export function resolveNodeCliLaunch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[] } {
  if (platform !== "win32") return { file: command, args: [...args] };
  const file = isAbsolute(command) ? command : (candidateCommandPaths(command, env)[0] ?? command);
  let entry = /\.(?:c?js|mjs)$/i.test(file) ? file : undefined;
  if (/\.(?:cmd|bat|ps1)$/i.test(file)) {
    const name = basename(file)
      .replace(/\.(?:cmd|bat|ps1)$/i, "")
      .toLowerCase();
    if (name === "npm" || name === "npx") {
      const candidate = join(dirname(file), "node_modules", "npm", "bin", `${name}-cli.js`);
      if (existsSync(candidate)) entry = candidate;
    } else if (name === "pi") {
      const packageRoot = join(dirname(file), "node_modules", "@earendil-works", "pi-coding-agent");
      try {
        const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
          bin?: string | { pi?: string };
        };
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
        if (bin && existsSync(join(packageRoot, bin))) entry = join(packageRoot, bin);
      } catch {
        // Report the unresolved shim below; do not feed its path to a second shell.
      }
    }
    if (!entry) {
      throw new Error(
        `Cannot resolve the JavaScript entrypoint for ${file}. Use the bundled pi SDK or reinstall this Node CLI.`,
      );
    }
  }
  if (!entry) return { file, args: [...args] };
  const configuredNode = env.NODE_BINARY;
  const node = configuredNode && existsSync(configuredNode) ? configuredNode : process.execPath;
  return { file: node, args: [entry, ...args] };
}
