// Diagnosis: why do extraction batches fail with glm-5.3-flash?
// Replicates the exact learning pipeline of longmemeval.mjs pix-memory mode,
// capturing every extraction response and classifying the first validation failure.
import { readFile } from "node:fs/promises";
import { EvaluationModel } from "./model-budget.mjs";
import { MemoryStore } from "../../src/sidecar/memory/store.ts";
import {
  MEMORY_EXTRACTION_PROMPT,
  MEMORY_CONSOLIDATION_PROMPT,
  parseModelJsonArray,
} from "../../../../packages/agent-runtime/src/memory-extraction.ts";

const DATASET = "E:/code/ai/pix/artifacts/longmemeval_s_cleaned.json";
const AGENT_DIR = "E:/pix-eval-agent";
const PROVIDER = process.argv[2] ?? "glm-5.3-flash";
const CASES_PER_TYPE = Number(process.argv[3] ?? 2);

const raw = await readFile(DATASET, "utf8");
const dataset = JSON.parse(raw);
const byType = new Map();
for (const item of dataset) {
  if (!byType.has(item.question_type)) byType.set(item.question_type, []);
  byType.get(item.question_type).push(item);
}
const selected = [];
for (const [type, items] of byType) selected.push(...items.slice(0, CASES_PER_TYPE));
console.error(`selected ${selected.length} cases across ${byType.size} types; model=${PROVIDER}`);

const evaluator = await EvaluationModel.open({
  agentDir: AGENT_DIR,
  provider: PROVIDER,
  model: PROVIDER,
  budgetUsd: 0,
  unlimited: true,
  inputPerMillion: 0,
  outputPerMillion: 0,
  ledgerPath: "E:/pix-diag/ledger.json",
});
const complete = (...args) => evaluator.complete(...args);

const stats = {
  batches: 0,
  parseErrors: 0,
  emptyArray: 0,
  validBatches: 0,
  invalidBatches: 0,
  failReasons: {},
  quoteWhitespaceOnly: 0,
  candidatesTotal: 0,
  candidatesValid: 0,
};
const samples = {};

function classify(job, text) {
  stats.batches++;
  let candidates;
  try {
    candidates = parseModelJsonArray(text);
  } catch {
    stats.parseErrors++;
    samples.parseErrors ??= [];
    if (samples.parseErrors.length < 5)
      samples.parseErrors.push(text.slice(0, 220).replace(/\s+/g, " "));
    return;
  }
  if (!Array.isArray(candidates)) {
    stats.parseErrors++;
    return;
  }
  if (candidates.length === 0) {
    stats.emptyArray++;
    return;
  }
  stats.candidatesTotal += candidates.length;
  const reasons = [];
  for (const item of candidates) {
    const fail = (reason, detail) => {
      reasons.push({ reason, detail });
      samples[reason] ??= [];
      if (samples[reason].length < 4) samples[reason].push(detail);
    };
    const sources = (job.sources ?? []).filter((s) => s.entryId === item.entryId);
    if (typeof item !== "object" || item === null)
      fail("schema", JSON.stringify(item).slice(0, 120));
    else if (!["user", "project"].includes(item.scope))
      fail("scope_bad", JSON.stringify(item).slice(0, 120));
    else if (!["preference", "decision", "procedure", "fact", "state"].includes(item.kind))
      fail("kind_bad", JSON.stringify(item).slice(0, 120));
    else if (
      typeof item.content !== "string" ||
      item.content.length === 0 ||
      item.content.length > 2000
    )
      fail("content_bad", JSON.stringify(item).slice(0, 120));
    else if (sources.length !== 1)
      fail(
        "entryId_no_match",
        `entryId=${item.entryId} known=${job.sources
          .map((s) => s.entryId)
          .slice(0, 6)
          .join(",")}`,
      );
    else if (typeof item.quote !== "string" || item.quote.trim().length < 4)
      fail("quote_short", JSON.stringify(item.quote).slice(0, 120));
    else if (!sources[0].text.includes(item.quote)) {
      const norm = (s) => s.replace(/\s+/g, " ");
      const whitespaceOnly = norm(sources[0].text).includes(norm(item.quote));
      if (whitespaceOnly) stats.quoteWhitespaceOnly++;
      fail(
        whitespaceOnly ? "quote_whitespace" : "quote_not_substring",
        `q=${item.quote.slice(0, 80)} | src=${sources[0].text.slice(0, 80)}`,
      );
    }
  }
  if (reasons.length === 0) {
    stats.validBatches++;
    stats.candidatesValid += candidates.length;
  } else {
    stats.invalidBatches++;
    stats.failReasons[reasons[0].reason] = (stats.failReasons[reasons[0].reason] ?? 0) + 1;
  }
}

for (const item of selected) {
  const store = new MemoryStore(":memory:");
  const project = store.project("eval", "/eval", "evaluation");
  store.patchPreferences({ longTerm: true, shortTerm: true, dailyTokenBudget: 1_000_000 }, 0);
  const history = item.haystack_sessions
    .map((messages, i) => ({
      id: item.haystack_session_ids[i],
      date: item.haystack_dates[i],
      messages: messages.map(({ role, content }) => ({ role, content })),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const sources = history.flatMap((session, si) =>
    session.messages.flatMap((message, index) => {
      if (message.role !== "user") return [];
      const text = `[Session date: ${session.date}]\n${message.content}`;
      if (typeof message.content !== "string" || text.length > 4000) return [];
      return [{ sessionId: session.id, entryId: `m${si}-${index}`, text }];
    }),
  );
  console.error(
    `case ${item.question_id} (${item.question_type}): ${sources.length} sources, ${history.length} sessions`,
  );
  for (let offset = 0; offset < sources.length; offset += 20) {
    const batch = sources.slice(offset, offset + 20);
    const job = store.beginLearning(store.preferences().epoch, project.id, batch);
    if (!job) continue;
    try {
      const text = await complete(
        MEMORY_EXTRACTION_PROMPT,
        JSON.stringify({ scopes: job.scopes, sources: job.sources }),
        1500,
      );
      classify({ ...job, sources: batch }, text);
      const plan = store.prepareConsolidation(job.id, parseModelJsonArray(text));
      if (plan) {
        const decisions = parseModelJsonArray(
          await complete(MEMORY_CONSOLIDATION_PROMPT, JSON.stringify(plan), 1500),
        );
        store.finishLearning(job.id, [], undefined, decisions);
      }
    } catch (e) {
      store.finishLearning(job.id, [], "extraction_failed");
      stats.failReasons["exception:" + (e.message?.slice(0, 40) ?? "unknown")] =
        (stats.failReasons["exception:" + (e.message?.slice(0, 40) ?? "unknown")] ?? 0) + 1;
    }
  }
  const st = store.state();
  console.error(
    `  -> learning failed=${st.learning.failed} done=${st.learning.completed} records=${JSON.stringify(st.records)} pending=${st.learning.pending}`,
  );
}

console.log(JSON.stringify({ stats, samples }, null, 1));
