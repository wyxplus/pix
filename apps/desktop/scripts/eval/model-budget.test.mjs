import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvaluationModel } from "./model-budget.mjs";

await test("durable budget retains uncertain calls across restart and rejects journal loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-budget-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: "http://127.0.0.1:9",
            api: "openai-completions",
            apiKey: "local-only",
            models: [{ id: "fixture", contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      }),
    );
    const options = {
      agentDir,
      provider: "fixture",
      model: "fixture",
      budgetUsd: 0.006,
      inputPerMillion: 1,
      outputPerMillion: 1,
      ledgerPath: join(root, "ledger.json"),
    };
    const model = await EvaluationModel.open(options);
    let calls = 0;
    model.runtime = {
      completeSimple: async () => {
        calls++;
        throw new Error("uncertain_network_failure");
      },
    };
    await assert.rejects(model.complete("system", "question"), /uncertain_network_failure/);
    assert.equal(calls, 1);
    const before = model.ledger.reservedUsd;
    const resumed = await EvaluationModel.open(options);
    assert.equal(resumed.ledger.reservedUsd, before);
    assert.equal(resumed.ledger.calls[0].status, "failed");
    resumed.runtime = model.runtime;
    await assert.rejects(resumed.complete("system", "question"), /budget_exhausted/);
    assert.equal(calls, 1);
    await assert.rejects(
      EvaluationModel.open({ ...options, budgetUsd: 1 }),
      /configuration_changed/,
    );
    const journal = `${options.ledgerPath}.journal.jsonl`;
    await appendFile(journal, '{"kind":"reserve"');
    await assert.rejects(EvaluationModel.open(options), /journal_truncated/);
    await rm(journal);
    await assert.rejects(EvaluationModel.open(options), /journal_missing/);
    assert.ok((await readFile(options.ledgerPath, "utf8")).includes("reservedUsd"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("explicit unlimited mode keeps unknown prices null and journals concurrent requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-unlimited-"));
  try {
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: "http://127.0.0.1:9",
            api: "openai-completions",
            apiKey: "local-only",
            models: [{ id: "fixture", contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      }),
    );
    const options = {
      agentDir: root,
      provider: "fixture",
      model: "fixture",
      unlimited: true,
      ledgerPath: join(root, "ledger.json"),
    };
    const model = await EvaluationModel.open(options);
    model.runtime = {
      completeSimple: async () => ({
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        content: [{ type: "text", text: "ok" }],
      }),
    };
    assert.deepEqual(
      await Promise.all(
        Array.from({ length: 8 }, (_, i) => model.complete("system", `question ${i}`)),
      ),
      Array(8).fill("ok"),
    );
    const resumed = await EvaluationModel.open(options);
    assert.equal(resumed.ledger.calls.length, 8);
    assert.equal(new Set(resumed.ledger.calls.map((c) => c.sequence)).size, 8);
    assert.equal(resumed.ledger.inputTokens, 800);
    assert.equal(resumed.ledger.outputTokens, 80);
    assert.equal(resumed.ledger.reservedUsd, null);
    assert.equal(resumed.ledger.budgetUsd, null);
    assert.ok(
      resumed.ledger.calls.every((c) => c.status === "completed" && c.observedUsd === null),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test("provider cooldown stops new requests; fresh recovery and bounded transient retries are journaled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-provider-stop-"));
  try {
    await writeFile(
      join(root, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: "http://127.0.0.1:9",
            api: "openai-completions",
            apiKey: "local-only",
            models: [{ id: "fixture", contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      }),
    );
    const options = {
      agentDir: root,
      provider: "fixture",
      model: "fixture",
      unlimited: true,
      ledgerPath: join(root, "ledger.json"),
    };
    const model = await EvaluationModel.open(options);
    let calls = 0;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    model.runtime = {
      completeSimple: async () => {
        calls++;
        return {
          usage,
          stopReason: "error",
          errorMessage:
            '429: {"code":"model_cooldown","reset_seconds":500000,"message":"secret-canary-not-for-ledger"}',
          content: [],
        };
      },
    };
    await assert.rejects(model.complete("system", "question"), /eval_provider_unavailable/);
    await assert.rejects(model.complete("system", "another question"), /eval_provider_unavailable/);
    assert.equal(calls, 1);
    assert.equal(model.ledger.calls.length, 1);
    assert.equal(model.providerUnavailable.resetSeconds, 500000);
    assert.ok(
      !(await readFile(options.ledgerPath + ".journal.jsonl", "utf8")).includes("secret-canary"),
    );
    const recovered = await EvaluationModel.open(options);
    let recoveredCalls = 0;
    recovered.runtime = {
      completeSimple: async () => {
        recoveredCalls++;
        return recoveredCalls === 1
          ? {
              usage,
              stopReason: "error",
              errorMessage: '503: {"error":{"code":"overloaded"}}',
              content: [],
            }
          : {
              usage: { ...usage, input: 20, output: 1 },
              stopReason: "stop",
              content: [{ type: "text", text: "READY" }],
            };
      },
    };
    assert.equal(await recovered.complete("system", "question"), "READY");
    assert.equal(recoveredCalls, 2);
    assert.equal(recovered.ledger.calls.length, 3);
    assert.equal(recovered.ledger.calls[2].retryAttempt, 1);
    assert.equal(recovered.ledger.providerUnavailable, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
