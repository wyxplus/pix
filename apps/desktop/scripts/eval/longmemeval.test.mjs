import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { FakeOpenAiServer } from "../../../../packages/test-utils/src/index.ts";
const exec = promisify(execFile);
await test(
  "evaluation baselines exclude labels and stop before exceeding the configured allowance",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pix-eval-test-"));
    const server = new FakeOpenAiServer({
      toolPath: join(root, "fixture.txt"),
      responseText: (request) => {
        const system = JSON.stringify(
          request.messages?.filter((m) => m.role === "system" || m.role === "developer"),
        );
        if (system.includes("Extract only durable"))
          return JSON.stringify([
            {
              scope: "user",
              kind: "preference",
              content: "I prefer concise prose.",
              quote: "I prefer concise prose.",
              entryId: "m0-0",
            },
          ]);
        if (system.includes("Compare the evidence-validated"))
          return JSON.stringify([{ candidateIndex: 0, action: "add", relatedIds: [] }]);
        return undefined;
      },
    });
    try {
      await server.start();
      const agent = join(root, "agent");
      await mkdir(agent);
      await writeFile(
        join(agent, "models.json"),
        JSON.stringify({
          providers: {
            "pix-eval": {
              baseUrl: server.baseUrl,
              api: "openai-completions",
              apiKey: "fake-test-key",
              models: [{ id: "fake", contextWindow: 8192, maxTokens: 1024 }],
            },
          },
        }),
      );
      const dataset = join(root, "dataset.json");
      await writeFile(
        dataset,
        JSON.stringify([
          {
            question_id: "q1",
            question_type: "single-session-user",
            question: "What is my preference?",
            answer: "gold-label-canary-99491",
            question_date: "2026-09-20",
            haystack_session_ids: ["s1"],
            haystack_dates: ["2026-09-19"],
            haystack_sessions: [
              [{ role: "user", content: "I prefer concise prose.", has_answer: true }],
            ],
            answer_session_ids: ["s1"],
          },
        ]),
      );
      const script = fileURLToPath(new URL("./longmemeval.mjs", import.meta.url));
      const concurrentCases = JSON.parse(await readFile(dataset, "utf8"));
      concurrentCases.push({
        ...concurrentCases[0],
        question_id: "q2",
        haystack_session_ids: ["new-session", "old-session"],
        haystack_dates: ["2026-09-19", "2026-09-18"],
        haystack_sessions: [
          [{ role: "user", content: "I prefer concise prose. New session." }],
          [{ role: "user", content: "I prefer concise prose. Old session." }],
        ],
        answer_session_ids: ["new-session"],
      });
      await writeFile(dataset, JSON.stringify(concurrentCases));
      const args = [
        script,
        "--dataset",
        dataset,
        "--limit",
        "2",
        "--concurrency",
        "2",
        "--run",
        "--agent-dir",
        agent,
        "--provider",
        "pix-eval",
        "--model",
        "fake",
        "--input-per-million",
        "1",
        "--output-per-million",
        "1",
      ];
      await exec(process.execPath, [...args, "--budget-usd", "1", "--out", join(root, "normal")]);
      const report = JSON.parse(await readFile(join(root, "normal", "report.json"), "utf8"));
      assert.equal(report.results.length, 8);
      assert.equal(report.budgetExhausted, false);
      assert.equal(report.results.filter((row) => row.status === "answered").length, 8);
      assert.ok(report.calls >= 4);
      const memoryResult = report.results.find((row) => row.mode === "pix-memory");
      assert.equal(memoryResult.failedExtractions, 0);
      assert.equal(memoryResult.evidenceSessionRecall, 1);
      assert.ok(JSON.stringify(server.requests).includes("Compare the evidence-validated"));
      assert.ok(!JSON.stringify(server.requests).includes("gold-label-canary-99491"));
      assert.ok(!JSON.stringify(server.requests).includes("has_answer"));
      const orderedHistory = server.requests
        .flatMap((request) => request.messages ?? [])
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .find((text) => text.includes('"id":"old-session"') && text.includes('"id":"new-session"'));
      assert.ok(orderedHistory);
      assert.ok(
        orderedHistory.indexOf('"id":"old-session"') < orderedHistory.indexOf('"id":"new-session"'),
      );
      const completedRequests = server.requests.length;
      await exec(process.execPath, [
        ...args,
        "--budget-usd",
        "1",
        "--out",
        join(root, "normal"),
        "--resume",
      ]);
      assert.equal(server.requests.length, completedRequests, "completed pairs were billed again");
      await assert.rejects(
        exec(process.execPath, [
          ...args,
          "--budget-usd",
          "2",
          "--out",
          join(root, "normal"),
          "--resume",
        ]),
        /budget_configuration_changed/,
      );
      assert.equal(server.requests.length, completedRequests);
      const before = server.requests.length;
      await exec(process.execPath, [
        ...args,
        "--budget-usd",
        "0.00000001",
        "--out",
        join(root, "capped"),
      ]);
      const capped = JSON.parse(await readFile(join(root, "capped", "report.json"), "utf8"));
      assert.equal(capped.budgetExhausted, true);
      assert.equal(capped.calls, 0);
      assert.equal(server.requests.length, before);
    } finally {
      await server.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
);
