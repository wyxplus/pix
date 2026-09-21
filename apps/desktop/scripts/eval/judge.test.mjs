import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256 } from "./model-budget.mjs";
import { FakeOpenAiServer } from "../../../../packages/test-utils/src/index.ts";
const exec = promisify(execFile);

await test("judge pins prompts, resumes without rebilling, and binds labels to predictions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pix-judge-test-"));
  const server = new FakeOpenAiServer({
    toolPath: join(root, "fixture"),
    responseText: () => "yes",
  });
  try {
    await server.start();
    const agent = join(root, "agent"),
      run = join(root, "run"),
      out = join(root, "judge");
    await mkdir(agent);
    await mkdir(run);
    await writeFile(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          test: {
            baseUrl: server.baseUrl,
            api: "openai-completions",
            apiKey: "fake-test-key",
            models: [{ id: "fake", contextWindow: 8192, maxTokens: 1024 }],
          },
        },
      }),
    );
    const dataset = JSON.stringify([
      {
        question_id: "q1",
        question_type: "single-session-user",
        question: "Preference?",
        answer: "short",
      },
    ]);
    await writeFile(join(root, "dataset.json"), dataset);
    await writeFile(
      join(run, "report.json"),
      JSON.stringify({
        datasetSha256: sha256(dataset),
        sourceSha256: "source",
        protocolSha256: "answers",
        model: "answer-model",
      }),
    );
    const prediction = JSON.stringify({ question_id: "q1", hypothesis: "short" }) + "\n";
    await writeFile(join(run, "none.jsonl"), prediction);
    const source =
      "raise RuntimeError('must not execute upstream runner')\ndef get_anscheck_prompt(task, question, answer, response, abstention=False):\n    return question + ' ' + answer + ' ' + response\n";
    await writeFile(join(root, "upstream.py"), source);
    const args = [
      join(import.meta.dirname, "judge.mjs"),
      "--dataset",
      join(root, "dataset.json"),
      "--run",
      run,
      "--out",
      out,
      "--agent-dir",
      agent,
      "--provider",
      "test",
      "--model",
      "fake",
      "--unlimited-budget",
      "--official-script",
      join(root, "upstream.py"),
      "--official-script-sha256",
      sha256(source),
      "--concurrency",
      "2",
    ];
    await exec(process.execPath, args);
    let report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    assert.equal(report.judged, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.officialJudgeConfiguration, false);
    assert.equal(report.results[0].autoeval_label.label, true);
    assert.equal(server.requests.length, 1);
    await exec(process.execPath, [...args, "--resume"]);
    assert.equal(server.requests.length, 1);
    await writeFile(join(run, "recent.jsonl"), prediction);
    await exec(process.execPath, [...args, "--resume"]);
    assert.equal(server.requests.length, 2);
    report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    assert.equal(report.judged, 2);
    await writeFile(join(root, "upstream.py"), source + "# tampered\n");
    await assert.rejects(
      exec(process.execPath, [...args, "--resume"]),
      /official_judge_source_hash_mismatch/,
    );
    assert.equal(server.requests.length, 2);
    await writeFile(join(root, "upstream.py"), source);
    await writeFile(
      join(run, "none.jsonl"),
      JSON.stringify({ question_id: "q1", hypothesis: "changed" }) + "\n",
    );
    await assert.rejects(
      exec(process.execPath, [...args, "--resume"]),
      /prediction_changed_after_judging/,
    );
    assert.equal(server.requests.length, 2);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
