// Actual model judging with the pinned upstream prompt function. Alternative models are labeled.
import { readFile, writeFile, mkdir, rm, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { EvaluationModel, sha256, atomicReport } from "./model-budget.mjs";
const exec = promisify(execFile);
const { values } = parseArgs({
  options: {
    dataset: { type: "string" },
    run: { type: "string" },
    out: { type: "string" },
    "agent-dir": { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    "official-script": { type: "string" },
    "official-script-sha256": { type: "string" },
    "unlimited-budget": { type: "boolean", default: false },
    "budget-usd": { type: "string" },
    "input-per-million": { type: "string" },
    "output-per-million": { type: "string" },
    concurrency: { type: "string", default: "4" },
    "max-tokens": { type: "string", default: "10" },
    resume: { type: "boolean", default: false },
  },
});
for (const key of [
  "dataset",
  "run",
  "out",
  "agent-dir",
  "provider",
  "model",
  "official-script",
  "official-script-sha256",
])
  if (!values[key]) throw new Error(`required:${key}`);
const concurrency = Number(values.concurrency),
  maxTokens = Number(values["max-tokens"]);
if (
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 32 ||
  !Number.isInteger(maxTokens) ||
  maxTokens < 10 ||
  maxTokens > 1024
)
  throw new Error("invalid_judge_options");
const out = resolve(values.out),
  run = resolve(values.run),
  datasetRaw = await readFile(resolve(values.dataset));
const reference = new Map(JSON.parse(datasetRaw).map((row) => [row.question_id, row]));
const runReport = JSON.parse(await readFile(join(run, "report.json"), "utf8"));
if (sha256(datasetRaw) !== runReport.datasetSha256) throw new Error("dataset_hash_mismatch");
if (!values.resume) await mkdir(out, { mode: 0o700 });
const lock = join(out, "run.lock");
await writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
try {
  const protocolSha256 = sha256(
    (
      await Promise.all(
        ["judge.mjs", "official-judge-prompts.py", "model-budget.mjs"].map((f) =>
          readFile(join(import.meta.dirname, f), "utf8"),
        ),
      )
    ).join("\0"),
  );
  const config = {
    datasetSha256: runReport.datasetSha256,
    answerSourceSha256: runReport.sourceSha256,
    answerProtocolSha256: runReport.protocolSha256,
    answerModel: runReport.model,
    provider: values.provider,
    model: values.model,
    maxTokens,
    temperature: 0,
    promptSourceSha256: values["official-script-sha256"],
    protocolSha256,
  };
  let report = {
    config,
    startedAt: new Date().toISOString(),
    officialJudgeConfiguration: values.model === "gpt-4o-2024-08-06" && maxTokens === 10,
    source: "https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py",
    results: [],
  };
  if (values.resume) {
    const previous = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    if (JSON.stringify(previous.config) !== JSON.stringify(config))
      throw new Error("judge_configuration_changed");
    report = previous;
  }
  const model = await EvaluationModel.open({
    agentDir: resolve(values["agent-dir"]),
    provider: values.provider,
    model: values.model,
    unlimited: values["unlimited-budget"],
    budgetUsd: Number(values["budget-usd"]),
    inputPerMillion: Number(values["input-per-million"]),
    outputPerMillion: Number(values["output-per-million"]),
    ledgerPath: join(out, "model-ledger.json"),
  });
  const payload = [];
  for (const mode of ["none", "recent", "full", "pix-memory"]) {
    let text = "";
    try {
      text = await readFile(join(run, `${mode}.jsonl`), "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    for (const line of text.split("\n").filter(Boolean)) {
      const row = JSON.parse(line),
        ref = reference.get(row.question_id);
      if (!ref) throw new Error("unknown_prediction_id");
      if (
        report.results.some(
          (r) =>
            r.mode === mode &&
            r.question_id === row.question_id &&
            r.status === "judged" &&
            r.hypothesis !== row.hypothesis,
        )
      )
        throw new Error("prediction_changed_after_judging");
      if (
        report.results.some(
          (r) => r.mode === mode && r.question_id === row.question_id && r.status === "judged",
        )
      )
        continue;
      report.results = report.results.filter(
        (r) => r.mode !== mode || r.question_id !== row.question_id,
      );
      payload.push({
        mode,
        ...row,
        question_type: ref.question_type,
        question: ref.question,
        answer: ref.answer,
      });
    }
  }
  const payloadPath = join(out, "pending-prompts.json");
  await atomicReport(payloadPath, payload);
  const generated = await exec(
    "python3",
    [
      join(import.meta.dirname, "official-judge-prompts.py"),
      resolve(values["official-script"]),
      values["official-script-sha256"],
      payloadPath,
    ],
    { maxBuffer: 64_000_000 },
  );
  const rows = JSON.parse(generated.stdout);
  await rm(payloadPath);
  let saveQueue = Promise.resolve();
  const save = () => {
    saveQueue = saveQueue.then(async () => {
      report.modelCalls = model.ledger.calls.length;
      report.inputTokens = model.ledger.inputTokens;
      report.outputTokens = model.ledger.outputTokens;
      report.reservedUsd = model.ledger.reservedUsd;
      report.providerUnavailable = model.providerUnavailable ?? null;
      report.judged = report.results.filter((r) => r.status === "judged").length;
      report.failed = report.results.filter((r) => r.status === "failed").length;
      for (const mode of ["none", "recent", "full", "pix-memory"]) {
        const selected = report.results
          .filter((r) => r.mode === mode && r.status === "judged")
          .map(({ question_id, hypothesis, autoeval_label }) => ({
            question_id,
            hypothesis,
            autoeval_label,
          }));
        const destination = join(
          run,
          `${mode}.jsonl.eval-results-${encodeURIComponent(values.model)}`,
        );
        await writeFile(
          `${destination}.tmp`,
          selected.map((row) => JSON.stringify(row)).join("\n") + (selected.length ? "\n" : ""),
          { mode: 0o600, flush: true },
        );
        await rename(`${destination}.tmp`, destination);
      }
      await atomicReport(join(out, "report.json"), report);
    });
    return saveQueue;
  };
  await save();
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (cursor < rows.length && !model.providerUnavailable) {
        const row = rows[cursor++],
          started = performance.now();
        try {
          const response = await model.complete("", row.prompt, maxTokens, 0);
          if (!/\b(?:yes|no)\b/i.test(response)) throw new Error("unparseable_judge_response");
          report.results.push({
            mode: row.mode,
            question_id: row.question_id,
            hypothesis: row.hypothesis,
            status: "judged",
            response,
            autoeval_label: { model: values.model, label: response.toLowerCase().includes("yes") },
            ms: performance.now() - started,
          });
        } catch (e) {
          report.results.push({
            mode: row.mode,
            question_id: row.question_id,
            hypothesis: row.hypothesis,
            status: "failed",
            error: e.message,
          });
        }
        await save();
        console.log(
          JSON.stringify({ judged: report.judged, failed: report.failed, model: values.model }),
        );
      }
    }),
  );
  report.completedAt = new Date().toISOString();
  await save();
  if (report.failed) process.exitCode = 1;
} finally {
  await rm(lock, { force: true });
}
