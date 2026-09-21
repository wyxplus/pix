import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
await test("official judge aggregation rejects mismatched hypotheses and distinguishes partial coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-eval-report-"));
  try {
    const dataset = JSON.stringify([
      { question_id: "q1", question_type: "single-session-user" },
      { question_id: "q2_abs", question_type: "multi-session" },
    ]);
    await writeFile(join(root, "dataset.json"), dataset);
    const modes = ["none", "recent", "full", "pix-memory"];
    await writeFile(
      join(root, "report.json"),
      JSON.stringify({
        datasetSha256: createHash("sha256").update(dataset).digest("hex"),
        selectedCases: 2,
        results: modes.flatMap((mode) =>
          ["q1", "q2_abs"].map((questionId) => ({
            mode,
            questionId,
            status: "answered",
            ms: 20,
            failedExtractions: 0,
          })),
        ),
      }),
    );
    for (const mode of modes) {
      await writeFile(
        join(root, `${mode}.jsonl`),
        ["q1", "q2_abs"]
          .map((question_id) => JSON.stringify({ question_id, hypothesis: "fixture answer" }))
          .join("\n"),
      );
      await writeFile(
        join(root, `${mode}.jsonl.eval-results-gpt-4o`),
        JSON.stringify({
          question_id: "q1",
          hypothesis: "fixture answer",
          autoeval_label: { model: "gpt-4o-2024-08-06", label: true },
        }),
      );
    }
    const run = (out) =>
      exec(process.execPath, [
        new URL("./report.mjs", import.meta.url).pathname,
        "--dataset",
        join(root, "dataset.json"),
        "--run",
        root,
        "--out",
        join(root, out),
      ]);
    await run("partial.json");
    const report = JSON.parse(await readFile(join(root, "partial.json"), "utf8"));
    assert.equal(report.full500Scored, false);
    assert.equal(report.coverageComplete, false);
    assert.equal(report.full500AlternativeScored, false);
    assert.equal(report.modes.none.qaAccuracy, null);
    assert.equal(report.modes.none.partialAccuracy, 1);
    for (const mode of modes) {
      await writeFile(
        join(root, `${mode}.jsonl.eval-results-gpt-4o`),
        ["q1", "q2_abs"]
          .map((question_id) =>
            JSON.stringify({
              question_id,
              hypothesis: "fixture answer",
              autoeval_label: {
                model: "alternate-judge",
                label: mode === "pix-memory" || question_id === "q1",
              },
            }),
          )
          .join("\n"),
      );
    }
    await run("complete.json");
    const complete = JSON.parse(await readFile(join(root, "complete.json"), "utf8"));
    assert.equal(complete.coverageComplete, true);
    assert.equal(complete.full500Scored, false);
    assert.equal(complete.modes.none.qaAccuracy, 0.5);
    assert.equal(complete.modes["pix-memory"].qaAccuracy, 1);
    assert.equal(complete.pairedComparisons.none.accuracyDelta, 0.5);
    assert.equal(complete.pairedComparisons.none.memoryWins, 1);
    assert.ok(complete.modes.none.qaAccuracy95CI[0] < 0.5);
    assert.ok(complete.modes.none.qaAccuracy95CI[1] > 0.5);
    await writeFile(
      join(root, "none.jsonl.eval-results-gpt-4o"),
      JSON.stringify({
        question_id: "q1",
        hypothesis: "modified",
        autoeval_label: { model: "gpt-4o-2024-08-06", label: true },
      }),
    );
    await assert.rejects(run("invalid.json"), /mismatched_judge/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
