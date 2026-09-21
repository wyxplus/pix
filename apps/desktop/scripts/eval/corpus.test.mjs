import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memoryCases } from "./corpus/memory.mjs";
import { runMemoryCase } from "./corpus/memory-runner.mjs";

await test("independent memory expectations stay out of answering input; real Git topology stays isolated", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-corpus-boundary-"));
  try {
    const item = structuredClone(
      memoryCases.find((c) => c.id === "memory.scope.project-exception"),
    );
    item.hiddenExpectations.answerIncludes = ["HIDDEN_EVALUATOR_CANARY_529"];
    const requests = [];
    const result = await runMemoryCase(item, root, {
      complete: async (...args) => {
        requests.push(args);
        return "yarn@4";
      },
    });
    assert.equal(result.status, "failed");
    assert.ok(result.failures.includes("answer_missing:HIDDEN_EVALUATOR_CANARY_529"));
    assert.ok(JSON.stringify(requests).includes("yarn@4"));
    assert.ok(!JSON.stringify(requests).includes("HIDDEN_EVALUATOR_CANARY_529"));
    assert.equal(requests.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
