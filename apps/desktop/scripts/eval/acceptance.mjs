// Independent acceptance cases. No model calls unless --run-model and a priced budget are supplied.
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { memoryCases } from "./corpus/memory.mjs";
import { storageCases, nativeCases, fixture, syntheticPlan } from "./corpus/engineering.mjs";
import { runMemoryCase } from "./corpus/memory-runner.mjs";
import { EvaluationModel, atomicReport, sha256 } from "./model-budget.mjs";
import { validationSource } from "../validation-source.mjs";
const exec = promisify(execFile);
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    suite: { type: "string", default: "all" },
    split: { type: "string", default: "all" },
    "run-model": { type: "boolean", default: false },
    "agent-dir": { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    "budget-usd": { type: "string" },
    "unlimited-budget": { type: "boolean", default: false },
    "input-per-million": { type: "string" },
    "output-per-million": { type: "string" },
    "claude-bin": { type: "string" },
    "codex-bin": { type: "string" },
    "platform-evidence": { type: "string" },
    "native-ui-evidence": { type: "string" },
    resume: { type: "boolean", default: false },
    "manifest-only": { type: "boolean", default: false },
  },
});
if (!values.out)
  throw new Error("Required: --out NEW_DIRECTORY [--suite memory|storage|native|all]");
if (
  !["all", "memory", "storage", "native"].includes(values.suite) ||
  !["all", "development", "reserved"].includes(values.split)
)
  throw new Error("invalid_selection");
const all = [...memoryCases, ...storageCases, ...nativeCases];
if (
  memoryCases.length !== 80 ||
  storageCases.length !== 40 ||
  nativeCases.length !== 40 ||
  new Set(all.map((c) => c.id)).size !== 160
)
  throw new Error("corpus_cardinality_or_identity_mismatch");
const manifest = all.map(({ run, ...c }) => ({
  ...c,
  ...(run ? { procedureSha256: sha256(run.toString()) } : {}),
}));
const corpusSha256 = sha256(JSON.stringify(manifest));
const selected = all.filter(
  (c) =>
    (values.suite === "all" || c.suite === values.suite) &&
    (values.split === "all" || c.split === values.split),
);
const out = resolve(values.out);
const sourceSha256 = await validationSource(resolve(import.meta.dirname, "../../../.."));
const converterSha256 = sha256(
  (
    await readFile(
      resolve(import.meta.dirname, "../../src/sidecar/transfers/native-history.ts"),
      "utf8",
    )
  ).replaceAll("\r\n", "\n"),
);
const protocolSha256 = sha256(
  (
    await Promise.all(
      [
        "acceptance.mjs",
        "model-budget.mjs",
        "corpus/memory-runner.mjs",
        "corpus/engineering.mjs",
        "../probe-claude-transfer.mjs",
        "../probe-codex-continuation.mjs",
      ].map((file) => readFile(resolve(import.meta.dirname, file), "utf8")),
    )
  )
    .map((text) => text.replaceAll("\r\n", "\n"))
    .join("\0"),
);
if (!values.resume) await mkdir(out, { recursive: false, mode: 0o700 });
const lock = join(out, "run.lock");
await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
  flag: "wx",
  mode: 0o600,
});
let report = {
  version: 1,
  corpusSha256,
  sourceSha256,
  protocolSha256,
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  selectedCases: selected.length,
  selection: { suite: values.suite, split: values.split },
  results: [],
  modelCalls: 0,
};
let model;
try {
  if (values.resume) {
    report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    if (report.corpusSha256 !== corpusSha256) throw new Error("corpus_changed");
    if (report.sourceSha256 !== sourceSha256) throw new Error("implementation_changed");
    if (report.protocolSha256 !== protocolSha256) throw new Error("evaluation_protocol_changed");
    if (report.selection?.suite !== values.suite || report.selection?.split !== values.split)
      throw new Error("acceptance_selection_changed");
  }
  await atomicReport(join(out, "manifest.json"), manifest);
  if (values["manifest-only"]) {
    report.manifestOnly = true;
    await atomicReport(join(out, "report.json"), report);
    console.log(`Validated ${all.length} independent case definitions; no execution.`);
  } else {
    const evidence = values["platform-evidence"]
      ? JSON.parse(await readFile(resolve(values["platform-evidence"]), "utf8"))
      : {};
    const nativeUi = values["native-ui-evidence"]
      ? JSON.parse(await readFile(resolve(values["native-ui-evidence"]), "utf8"))
      : {};
    if (values["run-model"] && (!values["agent-dir"] || !values.provider || !values.model))
      throw new Error("explicit_agent_directory_provider_and_model_required");
    if (values["run-model"])
      model = await EvaluationModel.open({
        agentDir: resolve(values["agent-dir"] ?? ""),
        provider: values.provider,
        model: values.model,
        budgetUsd: Number(values["budget-usd"]),
        unlimited: values["unlimited-budget"],
        inputPerMillion: Number(values["input-per-million"]),
        outputPerMillion: Number(values["output-per-million"]),
        ledgerPath: join(out, "model-ledger.json"),
      });
    if (model)
      report.model = {
        provider: model.options.provider,
        id: model.options.model,
        pricesKnown: model.options.inputPerMillion !== null,
      };
    for (const item of selected) {
      if (report.results.some((r) => r.id === item.id && r.status === "passed")) continue;
      report.results = report.results.filter((r) => r.id !== item.id);
      const start = performance.now(),
        root = await mkdtemp(join(tmpdir(), "pix-acceptance-"));
      let context, result;
      try {
        if (item.suite === "memory") result = await runMemoryCase(item, root, model);
        else {
          context = await fixture(root);
          context.platform = async (target) => {
            const item = evidence[target];
            return item?.passed === true &&
              item?.memorySmoke === true &&
              item?.migrationSmoke === true &&
              item?.installed === true &&
              item?.sourceSha256 === sourceSha256
              ? { status: "passed", evidence: item }
              : { status: "blocked", reason: `installed_package_evidence_required:${target}` };
          };
          context.plan = (archive, name) => syntheticPlan(context, archive, name);
          context.native = async (target, id, messages) => {
            const binary = values[`${target}-bin`];
            if (!binary) return { status: "blocked", reason: `${target}_binary_required` };
            const branchPath = join(root, "branch.json"),
              reportPath = join(root, "target-report.json");
            await writeFile(
              branchPath,
              JSON.stringify({ sourceSessionId: item.id, leafId: "selected", messages }),
            );
            const script = resolve(
              import.meta.dirname,
              "..",
              target === "claude" ? "probe-claude-transfer.mjs" : "probe-codex-continuation.mjs",
            );
            await exec(process.execPath, [script, resolve(binary)], {
              env: {
                ...process.env,
                PIX_PROBE_BRANCH: branchPath,
                PIX_PROBE_REPORT: reportPath,
                PIX_PROBE_KEEP: "",
              },
              timeout: 180000,
              maxBuffer: 4_000_000,
            });
            const raw = JSON.parse(await readFile(reportPath, "utf8"));
            const { transcript: _transcript, root: _temporaryRoot, ...proof } = raw;
            if (
              !proof.conversionColdResume ||
              !proof.conversionReceivesHistory ||
              proof.paidModelCalls !== 0
            )
              throw new Error("target_history_or_resume_failed");
            if (
              target === "codex" &&
              (!proof.conversionVisibleHistory || !proof.conversionListedBeforeAnyModelTurn)
            )
              throw new Error("target_list_or_visible_history_failed");
            const ui = nativeUi[target];
            if (
              id === "picker-history" &&
              !(
                ui?.converterSha256 === converterSha256 &&
                ui?.version === proof.version &&
                ui?.messagesSha256 === sha256(JSON.stringify(messages)) &&
                ui?.pickerVisible === true &&
                ui?.historyPreviewVisible === true &&
                ui?.evidenceType === "observed-native-terminal"
              )
            )
              return {
                status: "not_tested",
                reason: "native_picker_requires_visual_confirmation",
                protocolEvidence: proof,
              };
            return {
              status: "passed",
              evidence: proof,
              ...(id === "picker-history" ? { nativeUiEvidence: ui } : {}),
              measurement:
                "real target parser and next-turn input; local synthetic model; not model quality",
            };
          };
          result = (await item.run(context)) ?? { status: "passed" };
        }
      } catch (e) {
        result = {
          status:
            e.message.startsWith("blocked:") || e.message === "eval_budget_exhausted"
              ? "blocked"
              : "failed",
          reason: e.message,
        };
      } finally {
        if (context)
          try {
            context.store.close();
          } catch {
            /* Some cases deliberately close before copying. */
          }
        await rm(root, { recursive: true, force: true });
      }
      const row = {
        id: item.id,
        suite: item.suite,
        category: item.category,
        split: item.split ?? null,
        ms: performance.now() - start,
        ...result,
      };
      report.results.push(row);
      report.modelCalls = model?.ledger.calls.length ?? 0;
      report.reservedUsd = model ? model.ledger.reservedUsd : 0;
      report.unlimitedBudget = model?.options.unlimited ?? false;
      report.observedInputTokens = model?.ledger.inputTokens ?? 0;
      report.observedOutputTokens = model?.ledger.outputTokens ?? 0;
      report.counts = Object.fromEntries(
        ["passed", "failed", "blocked", "not_tested"].map((status) => [
          status,
          report.results.filter((r) => r.status === status).length,
        ]),
      );
      report.acceptanceComplete =
        report.results.length === selected.length &&
        report.results.every((r) => r.status === "passed");
      await atomicReport(join(out, "report.json"), report);
      console.log(`${row.status.padEnd(10)} ${row.id}${row.reason ? `: ${row.reason}` : ""}`);
    }
    report.completedAt = new Date().toISOString();
    await atomicReport(join(out, "report.json"), report);
    console.log(
      JSON.stringify({
        report: join(out, "report.json"),
        counts: report.counts,
        acceptanceComplete: report.acceptanceComplete,
        modelCalls: report.modelCalls,
      }),
    );
    if (report.counts.failed) process.exitCode = 1;
  }
} finally {
  await rm(lock, { force: true });
}
