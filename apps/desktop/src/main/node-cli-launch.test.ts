import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { resolveNodeCliLaunch } from "./node-cli-launch.ts";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pix-cli-中文 & "));
  temporaryDirectories.push(root);
  return root;
}
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Windows Node CLI launch", () => {
  it.each(["npm", "npx"])("runs %s.cmd's JavaScript entry with literal argv", async (command) => {
    const root = fixture();
    const bin = join(root, "node_modules", "npm", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(root, `${command}.cmd`), "@echo CMD wrapper must not run\r\n");
    writeFileSync(
      join(bin, `${command}-cli.js`),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
    );
    const args = ["prefix", "--prefix", "D:\\中文 & space\\O'Brien", "%PATH%", "$(echo nope)"];
    const launch = resolveNodeCliLaunch(
      join(root, `${command}.cmd`),
      args,
      { NODE_BINARY: process.execPath },
      "win32",
    );
    const { stdout } = await execFileAsync(launch.file, launch.args);
    expect(JSON.parse(stdout)).toEqual(args);
  });

  it("resolves pi's current manifest entry rather than assuming dist/cli.js", async () => {
    const root = fixture();
    const pkgRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
    mkdirSync(join(pkgRoot, "dist", "bundle"), { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      JSON.stringify({ bin: { pi: "dist/bundle/cli.js" } }),
    );
    writeFileSync(join(pkgRoot, "dist", "bundle", "cli.js"), 'console.log("0.85.1")');
    const launch = resolveNodeCliLaunch(join(root, "pi.cmd"), ["--version"], {}, "win32");
    const { stdout } = await execFileAsync(launch.file, launch.args);
    expect(stdout.trim()).toBe("0.85.1");
  });

  it("leaves Unix launches alone and reports unresolved Windows shims clearly", () => {
    expect(resolveNodeCliLaunch("npm", ["root", "-g"], {}, "darwin")).toEqual({
      file: "npm",
      args: ["root", "-g"],
    });
    expect(() => resolveNodeCliLaunch(join(fixture(), "npm.cmd"), [], {}, "win32")).toThrow(
      "JavaScript entrypoint",
    );
  });
});
