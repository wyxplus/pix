import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite-plus";

const nodeBuiltins = [...builtinModules, ...builtinModules.map((name) => `node:${name}`)];

/**
 * Main must not bundle pi (or its CJS tree). Rolldown rewrites nested
 * `require("fs"|"child_process")` into a polyfill that throws in Electron ESM.
 * Same external policy as vite.agent.config.ts.
 */
function isExternal(id: string): boolean {
  if (id === "undici") return true;
  if (id === "node-pty" || id.startsWith("node-pty/")) return true;
  if (id.startsWith("@silvia-odwyer/")) return true;
  if (id.startsWith("@earendil-works/")) return true;
  if (id.startsWith("node:")) return true;
  if (nodeBuiltins.includes(id)) return true;
  // Bare Node builtins used by CJS helpers (fs, path, child_process, …)
  if (builtinModules.includes(id.split("/")[0]!)) return true;
  return false;
}

export default defineConfig({
  build: {
    target: "node24",
    outDir: resolve(import.meta.dirname, "dist/sidecar"),
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/sidecar/index.ts"),
      formats: ["es"],
      fileName: () => "sidecar.mjs",
    },
    rollupOptions: {
      external: isExternal,
    },
  },
});
