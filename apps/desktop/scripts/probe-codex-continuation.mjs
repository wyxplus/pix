// Real app-server / local fake Responses endpoint. Isolated home, no paid requests.
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodexAppServer, injectCodexContext } from "../src/sidecar/transfers/codex.ts";
import { codexRollout } from "../src/sidecar/transfers/native-history.ts";
const binary = process.argv[2];
if (!binary) throw new Error("Provide absolute Codex binary path");
const root = await mkdtemp(join(tmpdir(), "pix-codex-continuation-"));
const home = join(root, "codex"),
  cwd = join(root, "workspace");
await mkdir(home);
await mkdir(cwd);
const requests = [];
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  requests.push({ url: req.url, body });
  if (!req.url?.endsWith("/responses")) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader("content-type", "text/event-stream");
  const item = {
    id: "msg_probe",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "pix-codex-answer-981", annotations: [] }],
  };
  const response = {
    id: `resp_${requests.length}`,
    object: "response",
    status: "completed",
    model: "gpt-5.5",
    output: [item],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
  };
  const emit = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("response.created", { response: { ...response, status: "in_progress", output: [] } });
  emit("response.output_item.added", {
    output_index: 0,
    item: { ...item, content: [], status: "in_progress" },
  });
  emit("response.content_part.added", {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  emit("response.output_text.delta", {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    delta: item.content[0].text,
  });
  emit("response.output_text.done", {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    text: item.content[0].text,
  });
  emit("response.content_part.done", {
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: item.content[0],
  });
  emit("response.output_item.done", { output_index: 0, item });
  emit("response.completed", { response });
  res.end();
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(home, "config.toml"),
  `model="gpt-5.5"\nmodel_provider="pix-fixture"\napproval_policy="never"\nsandbox_mode="read-only"\n[model_providers.pix-fixture]\nname="Pix local fixture"\nbase_url="http://127.0.0.1:${http.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`,
);
const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, CODEX_HOME: home };
let server;
try {
  const version = (await promisify(execFile)(binary, ["--version"])).stdout.trim();
  const branch = process.env.PIX_PROBE_BRANCH
    ? JSON.parse(await readFile(process.env.PIX_PROBE_BRANCH, "utf8"))
    : {
        sourceSessionId: "pix-test",
        leafId: "leaf",
        messages: [
          { role: "user", text: "pix-converted-user-canary-982" },
          { role: "assistant", text: "pix-converted-assistant-canary-982" },
        ],
      };
  const converted = codexRollout(branch, cwd, "0.155.0-alpha.9.2");
  const day = converted.timestamp.slice(0, 10).split("-");
  const target = join(home, "sessions", ...day);
  await mkdir(target, { recursive: true });
  await writeFile(
    join(
      target,
      `rollout-${converted.timestamp.slice(0, 19).replaceAll(":", "-")}-${converted.sessionId}.jsonl`,
    ),
    converted.jsonl,
    { flag: "wx", mode: 0o600 },
  );
  server = new CodexAppServer(binary, { cwd, env });
  await server.initialize();
  const beforeTurnList = await server.request("thread/list", {
    limit: 100,
    modelProviders: [],
    sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
  });
  const convertedRead = await server.request("thread/read", {
    threadId: converted.sessionId,
    includeTurns: true,
  });
  const convertedResume = await server.request("thread/resume", { threadId: converted.sessionId });
  const conversionDone = server.waitForNotification(
    "turn/completed",
    (p) => p.threadId === converted.sessionId,
  );
  await server.request("turn/start", {
    threadId: converted.sessionId,
    input: [{ type: "text", text: "Continue converted history without tools.", text_elements: [] }],
  });
  await conversionDone;
  const conversionReceivesHistory = branch.messages.every((m) =>
    requests.at(-1)?.body.includes(JSON.stringify(m.text).slice(1, -1)),
  );
  const imported = await injectCodexContext(server, {
    cwd,
    title: "Pix isolated handoff",
    text: "pix-transfer-canary-cobalt-981",
  });
  const done = server.waitForNotification(
    "turn/completed",
    (p) => p.threadId === imported.threadId,
  );
  await server.request("turn/start", {
    threadId: imported.threadId,
    input: [
      {
        type: "text",
        text: "Acknowledge this imported context without using tools.",
        text_elements: [],
      },
    ],
  });
  await done;
  await server.close();
  server = new CodexAppServer(binary, { cwd, env });
  await server.initialize();
  const listed = await server.request("thread/list", {
    limit: 100,
    modelProviders: [],
    sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
  });
  const read = await server.request("thread/read", {
    threadId: imported.threadId,
    includeTurns: true,
  });
  const transcript = await readFile(read.thread.path, "utf8");
  await server.request("thread/resume", { threadId: imported.threadId });
  const resumedDone = server.waitForNotification(
    "turn/completed",
    (p) => p.threadId === imported.threadId,
  );
  await server.request("turn/start", {
    threadId: imported.threadId,
    input: [{ type: "text", text: "Continue without tools.", text_elements: [] }],
  });
  await resumedDone;
  const report = {
    version,
    root,
    threadId: imported.threadId,
    conversionVisibleHistory: branch.messages.every((m) =>
      JSON.stringify(convertedRead.thread.turns).includes(JSON.stringify(m.text).slice(1, -1)),
    ),
    conversionColdResume: convertedResume.thread.id === converted.sessionId,
    conversionReceivesHistory,
    conversionListed: listed.data.some((t) => t.id === converted.sessionId),
    conversionListedBeforeAnyModelTurn: beforeTurnList.data.some(
      (t) => t.id === converted.sessionId,
    ),
    coldStartListed: listed.data.some((t) => t.id === imported.threadId),
    visibleImportedHistory: JSON.stringify(read.thread.turns).includes(
      "pix-transfer-canary-cobalt-981",
    ),
    visibleNewTurn: JSON.stringify(read.thread.turns).includes("pix-codex-answer-981"),
    nextTurnReceivesHistory:
      requests.at(-1)?.body.includes("pix-transfer-canary-cobalt-981") ?? false,
    paidModelCalls: 0,
    localModelCalls: requests.length,
    nativeUiVerified: false,
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.PIX_PROBE_REPORT)
    await writeFile(
      process.env.PIX_PROBE_REPORT,
      JSON.stringify({ ...report, transcript }, null, 2),
    );
} finally {
  await server?.close();
  await new Promise((resolve) => http.close(resolve));
  if (!process.env.PIX_PROBE_KEEP) await rm(root, { recursive: true, force: true });
}
