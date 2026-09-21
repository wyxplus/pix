// Fixed synthetic performance profile. No provider, credentials, tools or model calls.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { MemoryStore } from "../../src/sidecar/memory/store.ts";
import { MemoryService } from "../../src/sidecar/memory/service.ts";
import { installMemoryContext } from "../../../../packages/agent-runtime/src/memory-context.ts";
const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) throw new Error("Required: --out NEW_REPORT_JSON");
const root = await mkdtemp(join(tmpdir(), "pix-retrieval-profile-"));
const services = new Set();
const now = "2026-09-20T00:00:00Z";
const stats = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    samples: samples.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
  };
};
try {
  const store = new MemoryStore(join(root, "memory.sqlite"));
  let project;
  try {
    store.patchPreferences({ longTerm: true, shortTerm: true }, 0);
    project = store.project("profile-a", "/fixture/alpha", "Alpha");
    const other = store.project("profile-b", "/fixture/beta", "Beta");
    const records = Array.from({ length: 10_000 }, (_, index) => ({
      id: `fixture-${index}`,
      scope: index % 10 < 3 ? "user" : "project",
      projectId: index % 10 < 3 ? null : index % 10 < 8 ? project.id : other.id,
      kind: "fact",
      content:
        index % 2 === 0
          ? `条目 ${index}：验证标记 marker${index}；构建环境采用独立缓存，项目决策必须保留来源。${"记录中文检索条件与历史上下文。".repeat(10)}`
          : `Record ${index}: validation marker${index}; use an isolated build cache. ${"Preserve source evidence and applicable project conditions. ".repeat(6)}`,
      factKey: "unused-import-recomputes",
      conditions: "",
      origin: "explicit",
      status: "active",
      sources: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }));
    store.importRecords(
      records.filter((r) => r.projectId !== other.id),
      true,
      project.id,
    );
    store.importRecords(
      records.filter((r) => r.projectId === other.id),
      false,
      other.id,
    );
  } finally {
    store.close();
  }
  let maxContextBytes = 0;
  const create = () => {
    const service = new MemoryService(root);
    services.add(service);
    return service;
  };
  const close = async (service) => {
    await service.close();
    services.delete(service);
  };
  const request = (service, index) => {
    const session = {
      agent: {
        streamFunction: async (_model, context) => {
          maxContextBytes = Math.max(maxContextBytes, Buffer.byteLength(context.systemPrompt));
          return undefined;
        },
      },
    };
    installMemoryContext(session, async (query) => {
      const context = await service.call("context", project.id, query);
      if (
        context.records.length > 24 ||
        context.records.some((r) => r.scope === "project" && r.projectId !== project.id)
      )
        throw new Error("retrieval_scope_or_budget_violation");
      if (
        !context.records.some(
          (r) => r.content.includes(`marker${index};`) || r.content.includes(`marker${index}；`),
        )
      )
        throw new Error("expected_evidence_not_retrieved");
      return context;
    });
    return session.agent.streamFunction(
      {},
      {
        systemPrompt: "Benchmark reference assembly",
        messages: [{ role: "user", content: `marker${index}`, timestamp: 0 }],
      },
      {},
    );
  };
  const warm = [],
    cold = [],
    concurrent = [];
  for (let index = 0; index < 20; index++) {
    const start = performance.now();
    const service = create();
    await request(service, index * 10 + 3);
    cold.push(performance.now() - start);
    await close(service);
  }
  const service = create();
  await request(service, 3);
  for (let index = 0; index < 200; index++) {
    const start = performance.now();
    await request(service, ((index * 47) % 1000) * 10 + (index % 8));
    warm.push(performance.now() - start);
  }
  for (let batch = 0; batch < 50; batch++) {
    await Promise.all(
      Array.from({ length: 4 }, async (_, offset) => {
        const start = performance.now();
        await request(service, (((batch * 4 + offset) * 37) % 1000) * 10 + offset);
        concurrent.push(performance.now() - start);
      }),
    );
  }
  await close(service);
  const report = {
    profile: "pix-retrieval-10k-v1",
    createdAt: new Date().toISOString(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
    },
    records: 10_000,
    languageMix: { chinese: 5000, english: 5000 },
    scopeMix: { personal: 3000, currentProject: 5000, otherProject: 2000 },
    measurement:
      "Worker IPC + production scoped retrieval + production request-context serialization. Cold includes new Worker startup; OS filesystem cache is not flushed.",
    warmMs: stats(warm),
    coldProcessMs: stats(cold),
    concurrentFourMs: stats(concurrent),
    maxContextBytes,
    suggestedWarmP95Ms: 200,
    meetsSuggestedWarmP95: stats(warm).p95 <= 200,
    modelCalls: 0,
  };
  await writeFile(resolve(values.out), JSON.stringify(report, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await Promise.all([...services].map((service) => service.close()));
  await rm(root, { recursive: true, force: true });
}
