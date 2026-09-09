import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { prepareLaunchEnv } from "./launch-env.mjs";
const prepared = await prepareLaunchEnv({ isolated: true });
const profile = process.argv.includes("--release") ? "release" : "debug";
const child = spawn(
  process.env.PIX_NATIVE_EXECUTABLE ||
    resolve(
      import.meta.dirname,
      `../src-tauri/target/${profile}/bundle/macos/Pix.app/Contents/MacOS/pix-desktop`,
    ),
  [],
  { env: prepared.environment, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await prepared.cleanup();
}
