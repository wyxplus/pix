import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export async function atomicReport(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
  await rename(temp, path);
}
/** Serial single-process spending journal. An uncertain call retains its reservation. */
export class EvaluationModel {
  static async open(options) {
    const { budgetUsd, inputPerMillion, outputPerMillion } = options;
    const unlimited = options.unlimited === true;
    const priced = [inputPerMillion, outputPerMillion].every((n) => Number.isFinite(n) && n > 0);
    if (!unlimited && (!priced || !Number.isFinite(budgetUsd) || budgetUsd <= 0))
      throw new Error("explicit_positive_budget_and_prices_required");
    options = {
      ...options,
      unlimited,
      budgetUsd: unlimited ? null : budgetUsd,
      inputPerMillion: priced ? inputPerMillion : null,
      outputPerMillion: priced ? outputPerMillion : null,
    };
    const runtime = await ModelRuntime.create({
      authPath: join(options.agentDir, "auth.json"),
      modelsPath: join(options.agentDir, "models.json"),
      modelsStorePath: join(dirname(options.ledgerPath), "model-cache.json"),
      allowModelNetwork: false,
    });
    const model = runtime.getModel(options.provider, options.model);
    if (!model) throw new Error("configured_model_not_found");
    const config = {
      provider: options.provider,
      model: options.model,
      inputPerMillion: options.inputPerMillion,
      outputPerMillion: options.outputPerMillion,
      unlimited,
      endpointSha256: sha256(model.baseUrl ?? ""),
    };
    let ledger = {
      version: 2,
      config,
      budgetUsd: options.budgetUsd,
      reservedUsd: priced ? 0 : null,
      inputTokens: 0,
      outputTokens: 0,
      calls: [],
    };
    try {
      ledger = JSON.parse(await readFile(options.ledgerPath, "utf8"));
      if (
        ledger.version !== 2 ||
        JSON.stringify(ledger.config) !== JSON.stringify(config) ||
        ledger.budgetUsd !== options.budgetUsd
      )
        throw new Error("evaluation_budget_configuration_changed");
      const events = (await readFile(`${options.ledgerPath}.journal.jsonl`, "utf8")).split("\n");
      if (events.pop() !== "") throw new Error("budget_journal_truncated_requires_review");
      const calls = new Map();
      for (const line of events) {
        const event = JSON.parse(line);
        if (event.kind === "reserve") {
          if (calls.has(event.call.sequence)) throw new Error("invalid_budget_journal");
        } else if (event.kind !== "settle" || !calls.has(event.call.sequence))
          throw new Error("invalid_budget_journal");
        calls.set(event.call.sequence, event.call);
      }
      ledger.calls = [...calls.values()];
      ledger.reservedUsd = priced ? ledger.calls.reduce((n, c) => n + c.reservedUsd, 0) : null;
      ledger.inputTokens = ledger.calls.reduce((n, c) => n + (c.inputTokens ?? 0), 0);
      ledger.outputTokens = ledger.calls.reduce((n, c) => n + (c.outputTokens ?? 0), 0);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      // A missing journal for an existing ledger is never interpreted as a fresh allowance.
      try {
        await readFile(options.ledgerPath);
        throw new Error("budget_journal_missing_requires_review");
      } catch (missing) {
        if (missing.code !== "ENOENT") throw missing;
      }
      await atomicReport(options.ledgerPath, ledger);
      await writeFile(`${options.ledgerPath}.journal.jsonl`, "", {
        flag: "wx",
        mode: 0o600,
        flush: true,
      });
    }
    const instance = new EvaluationModel();
    Object.assign(instance, { runtime, model, ledger, options });
    return instance;
  }
  async persist(kind, call) {
    this.persistence = (this.persistence ?? Promise.resolve()).then(async () => {
      await appendFile(
        `${this.options.ledgerPath}.journal.jsonl`,
        JSON.stringify({ kind, call }) + "\n",
        { mode: 0o600, flush: true },
      );
      const { calls, ...summary } = this.ledger;
      await atomicReport(this.options.ledgerPath, { ...summary, callCount: calls.length });
    });
    await this.persistence;
  }
  async complete(systemPrompt, text, maxTokens = 1024, temperature = 0) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.completeOnce(systemPrompt, text, maxTokens, temperature, attempt);
      } catch (error) {
        if (!error.retryable || attempt >= 2 || this.providerUnavailable) throw error;
        await delay(1000 * 2 ** attempt);
      }
    }
  }
  async completeOnce(systemPrompt, text, maxTokens, temperature, retryAttempt) {
    if (this.providerUnavailable) throw new Error("eval_provider_unavailable");
    const { inputPerMillion, outputPerMillion, budgetUsd } = this.options;
    const reserve =
      inputPerMillion === null
        ? null
        : ((Buffer.byteLength(systemPrompt) + Buffer.byteLength(text) + 2048) * inputPerMillion +
            maxTokens * outputPerMillion) /
          1e6;
    if (!this.options.unlimited && this.ledger.reservedUsd + reserve > budgetUsd)
      throw new Error("eval_budget_exhausted");
    const call = {
      sequence: this.ledger.calls.length + 1,
      inputSha256: sha256(JSON.stringify([systemPrompt, text])),
      maxTokens,
      retryAttempt,
      reservedUsd: reserve,
      status: "pending",
      startedAt: new Date().toISOString(),
    };
    if (reserve !== null) this.ledger.reservedUsd += reserve;
    this.ledger.calls.push(call);
    await this.persist("reserve", call);
    try {
      const result = await this.runtime.completeSimple(
        this.model,
        { systemPrompt, messages: [{ role: "user", content: text, timestamp: Date.now() }] },
        { maxTokens, temperature, signal: AbortSignal.timeout(120000) },
      );
      const input = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite,
        output = result.usage.output;
      this.ledger.inputTokens += input;
      this.ledger.outputTokens += output;
      Object.assign(call, {
        inputTokens: input,
        outputTokens: output,
        stopReason: result.stopReason,
        observedUsd:
          inputPerMillion === null
            ? null
            : (input * inputPerMillion + output * outputPerMillion) / 1e6,
      });
      if (result.stopReason === "error" || result.stopReason === "aborted") {
        // Keep only structured diagnostics, never raw provider responses or credentials.
        const message = String(result.errorMessage ?? "");
        const status = Number(message.match(/^(\d{3})(?::|\s)/)?.[1]) || null;
        let body = {};
        try {
          body = JSON.parse(message.slice(message.indexOf("{")));
        } catch {
          /* non-JSON error */
        }
        const rawCode = body.error?.code ?? body.code;
        const code =
          typeof rawCode === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(rawCode) ? rawCode : null;
        const resetSeconds = Number(body.reset_seconds ?? body.error?.reset_seconds) || null;
        Object.assign(call, { providerStatus: status, providerCode: code, resetSeconds });
        this.consecutiveFailures = (this.consecutiveFailures ?? 0) + 1;
        if (
          [401, 402, 403].includes(status) ||
          [
            "model_cooldown",
            "insufficient_quota",
            "usage_limit_reached",
            "insufficient_balance",
          ].includes(code) ||
          this.consecutiveFailures >= 8
        ) {
          this.providerUnavailable = { status, code, resetSeconds, at: new Date().toISOString() };
          this.ledger.providerUnavailable = this.providerUnavailable;
        }
        const error = new Error(
          this.providerUnavailable ? "eval_provider_unavailable" : "model_request_failed",
        );
        error.retryable =
          !this.providerUnavailable &&
          (status === 429 || status >= 500 || result.stopReason === "aborted");
        throw error;
      }
      this.consecutiveFailures = 0;
      if (!this.providerUnavailable) delete this.ledger.providerUnavailable;
      call.status = "completed";
      return result.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim();
    } catch (e) {
      call.status = "failed";
      call.error = e.message;
      throw e;
    } finally {
      call.completedAt = new Date().toISOString();
      await this.persist("settle", call);
    }
  }
}
