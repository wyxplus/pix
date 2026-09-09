import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareLaunchEnv } from "./launch-env.mjs";
import { runDevSession } from "./dev-session.mjs";
const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
execFileSync(pnpm, ["run", "build"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
execFileSync(process.execPath, [join(root, "scripts/prepare-sidecar.mjs")], {
  cwd: root,
  stdio: "inherit",
});
const prepared = await prepareLaunchEnv({ isolated: process.env.PIX_ISOLATED === "1" });
console.log(prepared.label);
try {
  process.exitCode = await runDevSession({
    configFile: join(root, "vite.renderer.config.ts"),
    cwd: root,
    env: {
      ...prepared.environment,
      // Isolated app HOME must not hide the developer's installed Rust toolchain.
      CARGO_HOME: process.env.CARGO_HOME || join(homedir(), ".cargo"),
      RUSTUP_HOME: process.env.RUSTUP_HOME || join(homedir(), ".rustup"),
    },
    command: process.execPath,
    args: (devUrl) => [
      require.resolve("@tauri-apps/cli/tauri.js"),
      "dev",
      "--config",
      JSON.stringify({ build: { beforeDevCommand: null, devUrl } }),
    ],
  });
} finally {
  await prepared.cleanup();
}
