// Offline workload estimate. Bytes are not token counts or a provider billing quotation.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { sha256 } from "./model-budget.mjs";
import { MEMORY_EXTRACTION_PROMPT } from "../../../../packages/agent-runtime/src/memory-extraction.ts";
const { values } = parseArgs({
  options: {
    dataset: { type: "string" },
    out: { type: "string" },
    limit: { type: "string", default: "500" },
  },
});
if (!values.dataset || !values.out)
  throw new Error("Required: --dataset FILE --out NEW_REPORT_JSON [--limit 500]");
const raw = await readFile(resolve(values.dataset)),
  data = JSON.parse(raw),
  limit = Number(values.limit);
if (!Array.isArray(data) || !Number.isInteger(limit) || limit < 1 || limit > 500)
  throw new Error("invalid_dataset_or_limit");
const selected = data.slice(0, limit);
let sessions = 0,
  extractionBatches = 0,
  skippedOversizedSources = 0,
  extractionBytes = 0,
  fullReferenceBytes = 0,
  recentReferenceBytes = 0,
  maximumFullReferenceBytes = 0;
for (const item of selected) {
  const history = item.haystack_sessions.map((messages, i) => ({
    id: item.haystack_session_ids[i],
    date: item.haystack_dates[i],
    messages: messages.map(({ role, content }) => ({ role, content })),
  }));
  const size = Buffer.byteLength(JSON.stringify(history));
  fullReferenceBytes += size;
  recentReferenceBytes += Buffer.byteLength(JSON.stringify(history.slice(-2)));
  maximumFullReferenceBytes = Math.max(size, maximumFullReferenceBytes);
  sessions += history.length;
  for (const session of history) {
    const sources = session.messages.flatMap((message, index) => {
      if (message.role !== "user") return [];
      const text = `[Session date: ${session.date}]\n${message.content}`;
      if (typeof message.content !== "string" || text.length > 4000) {
        skippedOversizedSources++;
        return [];
      }
      return [{ sessionId: session.id, entryId: `entry-${index}`, text }];
    });
    for (let offset = 0; offset < sources.length; offset += 20) {
      extractionBatches++;
      extractionBytes +=
        Buffer.byteLength(MEMORY_EXTRACTION_PROMPT) +
        Buffer.byteLength(
          JSON.stringify({
            scopes: ["user", "project"],
            sources: sources.slice(offset, offset + 20),
          }),
        );
    }
  }
}
const report = {
  datasetSha256: sha256(raw),
  selectedCases: selected.length,
  modelCalls: 0,
  workload: {
    sessions,
    extractionBatches,
    maximumConsolidationCalls: extractionBatches,
    answerCalls: selected.length * 4,
    officialJudgeCalls: selected.length * 4,
    skippedOversizedSources,
  },
  bytes: {
    extractionInputs: extractionBytes,
    fullReference: fullReferenceBytes,
    recentReference: recentReferenceBytes,
    maximumFullReference: maximumFullReferenceBytes,
  },
  maximumRequestedOutputTokens: {
    extraction: extractionBatches * 1500,
    consolidation: extractionBatches * 1500,
    answering: selected.length * 4 * 1024,
    officialJudge: selected.length * 4 * 10,
  },
  limitations: [
    "No tokenizer or provider quote: byte totals are not token estimates.",
    "Consolidation input size depends on learned records. Run a priced pilot before selecting the full allowance.",
    "Store policy may skip batches after its per-case daily allowance; actual calls can be lower. Skips remain visible in run reports.",
    "Official judge gpt-4o-2024-08-06 needs separate access and a separate allowance; changing judge model makes scores non-official.",
  ],
  approvalRequired: {
    evaluationProvider: null,
    evaluationModel: null,
    providerInputPrice: null,
    providerOutputPrice: null,
    runBudgetUsd: null,
    judgeProvider: null,
    judgeBudgetUsd: null,
  },
};
await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
console.log(JSON.stringify(report, null, 2));
