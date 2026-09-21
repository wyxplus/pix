// Uses a local synthetic Anthropic endpoint and an isolated Claude config. No paid requests.
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { claudeTranscript } from "../src/sidecar/transfers/native-history.ts";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const binary = process.argv[2];
if (!binary)
  throw new Error("Usage: node scripts/probe-claude-transfer.mjs /absolute/path/to/claude");
const root = await mkdtemp(join(tmpdir(), "pix-claude-probe-"));
const config = join(root, "config"),
  cwd = join(root, "workspace");
await mkdir(config);
await mkdir(cwd);
const requests = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const input = body ? JSON.parse(body) : {};
  requests.push({ url: req.url, input });
  if (req.url?.includes("count_tokens")) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ input_tokens: 100 }));
    return;
  }
  if (!req.url?.startsWith("/v1/messages")) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const message = {
    id: "msg_pix_probe",
    type: "message",
    role: "assistant",
    model: input.model,
    content: [{ type: "text", text: "pix-claude-answer-cobalt-981" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
  if (!input.stream) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(message));
    return;
  }
  res.setHeader("content-type", "text/event-stream");
  const emit = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("message_start", { message: { ...message, content: [], stop_reason: null } });
  emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  emit("content_block_delta", {
    index: 0,
    delta: { type: "text_delta", text: message.content[0].text },
  });
  emit("content_block_stop", { index: 0 });
  emit("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  emit("message_stop", {});
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  CLAUDE_CONFIG_DIR: config,
  ANTHROPIC_API_KEY: "local-fixture-only",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
};
const base = [
  "--bare",
  "--tools",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--setting-sources",
  "",
  "--model",
  "claude-sonnet-4-6",
  "--output-format",
  "json",
  "--print",
];
async function files(dir) {
  return (
    await Promise.all(
      (
        await readdir(dir, { withFileTypes: true })
      ).map(async (entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
      ),
    )
  ).flat();
}
try {
  const version = (await exec(binary, ["--version"])).stdout.trim();
  const first = JSON.parse(
    (
      await exec(binary, [...base, "pix-claude-user-canary-981"], {
        cwd,
        env,
        timeout: 45_000,
        maxBuffer: 4_000_000,
      })
    ).stdout,
  );
  const path = (await files(config)).find((path) => path.endsWith(`${first.session_id}.jsonl`));
  if (!path) throw new Error("native_transcript_missing");
  const transcript = await readFile(path, "utf8");
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
  const converted = claudeTranscript(branch, cwd, "2.1.87");
  await writeFile(join(dirname(path), `${converted.sessionId}.jsonl`), converted.jsonl, {
    flag: "wx",
    mode: 0o600,
  });
  const convertedBefore = requests.length;
  const conversion = JSON.parse(
    (
      await exec(binary, [...base, "--resume", converted.sessionId, "Continue without tools."], {
        cwd,
        env,
        timeout: 45_000,
        maxBuffer: 4_000_000,
      })
    ).stdout,
  );
  const conversionReceivesHistory = branch.messages.every((m) =>
    JSON.stringify(requests.slice(convertedBefore)).includes(JSON.stringify(m.text).slice(1, -1)),
  );
  const before = requests.length;
  const resumed = JSON.parse(
    (
      await exec(binary, [...base, "--resume", first.session_id, "Continue without tools."], {
        cwd,
        env,
        timeout: 45_000,
        maxBuffer: 4_000_000,
      })
    ).stdout,
  );
  const report = {
    version,
    sessionId: first.session_id,
    convertedSessionId: converted.sessionId,
    conversionColdResume: conversion.session_id === converted.sessionId,
    conversionReceivesHistory,
    nativeTranscript: true,
    coldResume: resumed.session_id === first.session_id,
    nextTurnReceivesHistory: JSON.stringify(requests.slice(before)).includes(
      "pix-claude-user-canary-981",
    ),
    paidModelCalls: 0,
    localModelCalls: requests.filter(
      (r) => r.url?.startsWith("/v1/messages") && !r.url.includes("count_tokens"),
    ).length,
    nativePickerVerified: false,
    root,
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.PIX_PROBE_REPORT)
    await writeFile(
      process.env.PIX_PROBE_REPORT,
      JSON.stringify({ ...report, transcript }, null, 2),
    );
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (!process.env.PIX_PROBE_KEEP) await rm(root, { recursive: true, force: true });
}
