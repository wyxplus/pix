// Offline aggregation of official judge outputs. This command never calls a model.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: {
    dataset: { type: "string" },
    run: { type: "string" },
    out: { type: "string" },
    "judge-suffix": { type: "string", default: ".eval-results-gpt-4o" },
    "judge-report": { type: "string" },
  },
});
if (!values.dataset || !values.run || !values.out)
  throw new Error(
    "Required: --dataset DATASET --run RUN_DIRECTORY --out NEW_REPORT_JSON [--judge-suffix .eval-results-gpt-4o]",
  );
const raw = await readFile(resolve(values.dataset));
const dataset = JSON.parse(raw.toString("utf8"));
const run = JSON.parse(await readFile(join(resolve(values.run), "report.json"), "utf8"));
const judge = values["judge-report"]
  ? JSON.parse(await readFile(resolve(values["judge-report"]), "utf8"))
  : null;
if (
  judge &&
  (judge.config.datasetSha256 !== run.datasetSha256 ||
    judge.config.answerSourceSha256 !== run.sourceSha256 ||
    judge.config.answerProtocolSha256 !== run.protocolSha256 ||
    judge.config.answerModel !== run.model)
)
  throw new Error("judge_run_binding_mismatch");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (digest(raw) !== run.datasetSha256) throw new Error("dataset_hash_mismatch");
if (!Array.isArray(dataset) || !Number.isSafeInteger(run.selectedCases) || run.selectedCases < 1)
  throw new Error("invalid_run");
const selected = new Map(
  dataset.slice(0, run.selectedCases).map((item) => [item.question_id, item]),
);
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const wilson95 = (scores) => {
  if (!scores.length) return null;
  const n = scores.length,
    p = mean(scores),
    z = 1.959963984540054;
  const denominator = 1 + (z * z) / n,
    center = (p + (z * z) / (2 * n)) / denominator;
  const radius = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
};
const percentile = (values, p) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.ceil(p * values.length) - 1] : null;
const jsonl = (raw) =>
  raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const summary = {
  datasetSha256: run.datasetSha256,
  pinnedPublicDataset:
    run.datasetSha256 === "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
  selectedCases: selected.size,
  sourceSha256: run.sourceSha256,
  protocolSha256: run.protocolSha256,
  coverageComplete: false,
  full500Scored: false,
  full500AlternativeScored: false,
  model: run.model,
  provider: run.provider,
  reservedUsd: run.reservedUsd,
  observedTokens: { input: run.observedInputTokens, output: run.observedOutputTokens },
  modes: {},
  modelCalls: run.calls ?? 0,
  judge: judge
    ? {
        model: judge.config.model,
        officialJudgeConfiguration: judge.officialJudgeConfiguration,
        promptSourceSha256: judge.config.promptSourceSha256,
        maxTokens: judge.config.maxTokens,
        calls: judge.modelCalls,
        inputTokens: judge.inputTokens,
        outputTokens: judge.outputTokens,
        reservedUsd: judge.reservedUsd,
        failed: judge.failed,
      }
    : null,
};
const labelsByMode = new Map();
for (const mode of ["none", "recent", "full", "pix-memory"]) {
  let predictions = [],
    judged = [];
  try {
    const bytes = await readFile(join(resolve(values.run), `${mode}.jsonl`));
    if (run.hypothesesSha256?.[mode] && digest(bytes) !== run.hypothesesSha256[mode])
      throw new Error("prediction_hash_mismatch");
    predictions = jsonl(bytes.toString("utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  try {
    judged = jsonl(
      await readFile(join(resolve(values.run), `${mode}.jsonl${values["judge-suffix"]}`), "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const hypotheses = new Map();
  for (const row of predictions) {
    if (
      !selected.has(row.question_id) ||
      hypotheses.has(row.question_id) ||
      typeof row.hypothesis !== "string"
    )
      throw new Error("invalid_predictions");
    hypotheses.set(row.question_id, row.hypothesis);
  }
  const seen = new Set(),
    groups = new Map();
  const scores = [],
    abstentions = [],
    judgeModels = new Set();
  for (const row of judged) {
    if (
      !selected.has(row.question_id) ||
      seen.has(row.question_id) ||
      row.hypothesis !== hypotheses.get(row.question_id) ||
      typeof row.autoeval_label?.label !== "boolean" ||
      typeof row.autoeval_label?.model !== "string"
    )
      throw new Error("invalid_or_mismatched_judge_result");
    seen.add(row.question_id);
    judgeModels.add(row.autoeval_label.model);
    const score = Number(row.autoeval_label.label),
      type = selected.get(row.question_id).question_type;
    scores.push(score);
    if (row.question_id.includes("_abs")) abstentions.push(score);
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(score);
  }
  if (judgeModels.size > 1) throw new Error("mixed_judge_models");
  if (judgeModels.size && judge && !judgeModels.has(judge.config.model))
    throw new Error("judge_model_mismatch");
  labelsByMode.set(
    mode,
    new Map(judged.map((row) => [row.question_id, Number(row.autoeval_label.label)])),
  );
  const rows = run.results.filter((row) => row.mode === mode),
    completed = rows.filter((row) => row.status === "answered");
  const complete = scores.length === selected.size && completed.length === selected.size;
  summary.modes[mode] = {
    answered: hypotheses.size,
    judged: scores.length,
    total: selected.size,
    complete,
    judgeModel: [...judgeModels][0] ?? null,
    officialJudgeConfiguration:
      [...judgeModels][0] === "gpt-4o-2024-08-06" && (!judge || judge.officialJudgeConfiguration),
    qaAccuracy: complete ? mean(scores) : null,
    qaAccuracy95CI: complete ? wilson95(scores) : null,
    partialAccuracy: complete ? null : mean(scores),
    taskAveragedAccuracy: complete ? mean([...groups.values()].map(mean)) : null,
    abstentionAccuracy: mean(abstentions),
    categories: Object.fromEntries(
      [...groups].map(([key, values]) => [key, { count: values.length, accuracy: mean(values) }]),
    ),
    latencyMs: {
      p50: percentile(
        completed.map((row) => row.ms),
        0.5,
      ),
      p95: percentile(
        completed.map((row) => row.ms),
        0.95,
      ),
    },
    evidenceSessionRecall: mean(
      completed.map((row) => row.evidenceSessionRecall).filter((n) => typeof n === "number"),
    ),
    failed: rows.filter((row) => row.status === "failed").length,
    extractionFailures: completed.reduce((sum, row) => sum + (row.failedExtractions ?? 0), 0),
    skippedSources: completed.reduce((sum, row) => sum + (row.skippedSources ?? 0), 0),
  };
}
summary.coverageComplete = Object.values(summary.modes).every((mode) => mode.complete);
summary.full500Scored =
  summary.pinnedPublicDataset &&
  selected.size === 500 &&
  Object.values(summary.modes).every((mode) => mode.complete && mode.officialJudgeConfiguration);
summary.full500AlternativeScored =
  summary.pinnedPublicDataset &&
  selected.size === 500 &&
  summary.coverageComplete &&
  !summary.full500Scored;
summary.pairedComparisons = {};
for (const baseline of ["none", "recent", "full"]) {
  const memory = labelsByMode.get("pix-memory"),
    other = labelsByMode.get(baseline);
  const pairs = [...memory]
    .filter(([id]) => other.has(id))
    .map(([id, score]) => [score, other.get(id)]);
  summary.pairedComparisons[baseline] = {
    count: pairs.length,
    complete: pairs.length === selected.size,
    accuracyDelta: pairs.length === selected.size ? mean(pairs.map(([a, b]) => a - b)) : null,
    memoryWins: pairs.filter(([a, b]) => a > b).length,
    baselineWins: pairs.filter(([a, b]) => a < b).length,
    ties: pairs.filter(([a, b]) => a === b).length,
  };
}
await writeFile(resolve(values.out), JSON.stringify(summary, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(
  `Report: ${resolve(values.out)}. Full official 500-case scoring: ${summary.full500Scored}.`,
);
