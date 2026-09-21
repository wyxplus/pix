// Follow an active answer run and score new predictions with judge.mjs.
// Pass the same judge arguments, including --run and --out. Existing labels are reused.
import { readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0 || !args[index + 1]) throw new Error(`required:${name}`);
  return resolve(args[index + 1]);
};
const run = option("run"),
  out = option("out"),
  lock = join(out, "follow.lock");
await writeFile(lock, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
try {
  let stalled = 0;
  while (true) {
    const answers = JSON.parse(await readFile(join(run, "report.json"), "utf8"));
    const scored = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    const available = answers.results.filter((row) => row.status === "answered").length;
    if (available > scored.judged || scored.failed) {
      const code = await new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            join(import.meta.dirname, "judge.mjs"),
            ...args,
            ...(args.includes("--resume") ? [] : ["--resume"]),
          ],
          { stdio: "inherit" },
        );
        child.once("error", reject);
        child.once("exit", resolve);
      });
      const latest = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
      if (latest.providerUnavailable) throw new Error("eval_provider_unavailable");
      stalled = code !== 0 && latest.judged <= scored.judged ? stalled + 1 : 0;
      if (stalled >= 3) throw new Error("judge_failed_three_attempts_without_progress");
      continue;
    }
    if (answers.completedAt) {
      console.log(
        JSON.stringify({
          finished: true,
          answerCoverageComplete: answers.coverageComplete,
          judged: scored.judged,
          failed: scored.failed,
        }),
      );
      if (!answers.coverageComplete) process.exitCode = 1;
      break;
    }
    const producer = JSON.parse(await readFile(join(run, "run.lock"), "utf8"));
    process.kill(producer.pid, 0);
    await setTimeout(20_000);
  }
} finally {
  await rm(lock, { force: true });
}
