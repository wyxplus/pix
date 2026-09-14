import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite-plus";

/** Keep runtime instruction files next to both Node bundles on every platform. */
export function copyAgentResources(): Plugin {
  return {
    name: "copy-agent-resources",
    closeBundle() {
      const outDir = resolve(import.meta.dirname, "dist/resources");
      mkdirSync(outDir, { recursive: true });
      copyFileSync(
        resolve(import.meta.dirname, "../../packages/agent-runtime/resources/AGENTS.md"),
        resolve(outDir, "AGENTS.md"),
      );
    },
  };
}
