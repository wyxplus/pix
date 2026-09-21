// Development-only conformance probe; creates no model turn and touches only a temporary Codex home.
import { mkdtemp, mkdir, rm, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServer, injectCodexContext } from "../src/sidecar/transfers/codex.ts";
const binary = process.argv[2];
if (!binary)
  throw new Error("Usage: node scripts/probe-codex-transfer.mjs /absolute/path/to/codex");
const root = await mkdtemp(join(tmpdir(), "pix-codex-probe-")),
  home = join(root, "codex-home"),
  workspace = join(root, "workspace");
await mkdir(home);
await mkdir(workspace);
const env = { ...process.env, CODEX_HOME: home };
let server;
try {
  server = new CodexAppServer(binary, { cwd: workspace, env });
  await server.initialize();
  const result = await injectCodexContext(server, {
    cwd: workspace,
    title: "Pix isolated transfer probe",
    text: "pix-transfer-canary-cobalt-981",
  });
  await server.close();
  server = new CodexAppServer(binary, { cwd: workspace, env });
  await server.initialize();
  const listed = await server.request("thread/list", { limit: 100 });
  const all = await server.request("thread/list", {
    limit: 100,
    sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
  });
  const coldStartListed = listed.data.some((item) => item.id === result.threadId);
  const read = await server.request("thread/read", {
    threadId: result.threadId,
    includeTurns: true,
  });
  const hasVisibleContent = JSON.stringify(read).includes("pix-transfer-canary-cobalt-981");
  const rolloutContainsCanary =
    typeof read.thread.path === "string" &&
    (await realpath(read.thread.path)).startsWith(await realpath(root))
      ? (await readFile(read.thread.path, "utf8")).includes("pix-transfer-canary-cobalt-981")
      : false;
  const report = {
    threadId: result.threadId,
    coldStartListed,
    listedWithAllSources: all.data.some((item) => item.id === result.threadId),
    rolloutContainsCanary,
    historyContainsCanary: hasVisibleContent,
    nativeUiVerified: false,
    nextTurnVerified: false,
    modelCalls: 0,
    metadata: {
      ephemeral: read.thread.ephemeral,
      source: read.thread.source,
      historyMode: read.thread.historyMode,
      turns: read.thread.turns?.length,
      hasPath: Boolean(read.thread.path),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.PIX_PROBE_REPORT)
    await writeFile(process.env.PIX_PROBE_REPORT, JSON.stringify(report, null, 2));
} finally {
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
