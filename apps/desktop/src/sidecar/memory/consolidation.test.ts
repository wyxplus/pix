import { afterEach, expect, it } from "vite-plus/test";
import { MemoryStore } from "./store.ts";
import type { MemoryCandidate } from "@pix/contracts";
const stores: MemoryStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function setup() {
  const store = new MemoryStore(":memory:");
  stores.push(store);
  store.patchPreferences({ longTerm: true, shortTerm: true, dailyTokenBudget: 1_000_000 }, 0);
  const project = store.project("p", "/p", "p");
  return { store, project };
}
function propose(store: MemoryStore, text: string, entry = "e1") {
  const job = store.beginLearning(store.preferences().epoch, undefined, [
    { sessionId: "s", entryId: entry, text },
  ])!;
  const candidate: MemoryCandidate = {
    scope: "user",
    kind: "preference",
    content: text,
    quote: text,
    entryId: entry,
  };
  const plan = store.prepareConsolidation(job.id, [candidate]);
  return { job, plan };
}
it("merges equivalent statements while preserving explicit content and independent source evidence", () => {
  const { store } = setup();
  const old = store.create({
    scope: "user",
    kind: "preference",
    content: "Use concise Chinese in all projects.",
  });
  const { job, plan } = propose(store, "Across projects I prefer brief Chinese explanations.");
  expect(plan?.existing.map((r) => r.id)).toContain(old.id);
  expect(
    store.finishLearning(job.id, [], undefined, [
      { candidateIndex: 0, action: "duplicate", relatedIds: [old.id] },
    ]),
  ).toBe(1);
  const records = store.list({ scope: "user" });
  expect(records).toHaveLength(1);
  expect(records[0]?.content).toBe(old.content);
  expect(records[0]?.origin).toBe("explicit");
  expect(records[0]?.sources).toEqual([{ sessionId: "s", entryId: "e1" }]);
});
it("quarantines a changed preference, keeps explicit authority, and accepts a revision-checked user resolution", () => {
  const { store } = setup();
  const old = store.create({
    scope: "user",
    kind: "preference",
    content: "Use English across projects.",
  });
  const { job } = propose(store, "Now use Chinese across all projects.");
  store.finishLearning(job.id, [], undefined, [
    { candidateIndex: 0, action: "conflict", relatedIds: [old.id] },
  ]);
  expect(store.context(undefined, "language").records.map((r) => r.content)).toEqual([old.content]);
  const incoming = store.list({ scope: "user" }).find((r) => r.status === "disputed")!;
  expect(() => store.resolve({ id: incoming.id, expectedRevision: 0, choice: "keep" })).toThrow(
    "revision_conflict",
  );
  store.resolve({ id: incoming.id, expectedRevision: incoming.revision, choice: "keep" });
  expect(store.context(undefined, "language").records.map((r) => r.content)).toEqual([
    incoming.content,
  ]);
  expect(store.list({ scope: "user" }).find((r) => r.id === old.id)?.status).toBe("superseded");
  const again = store.beginLearning(store.preferences().epoch, undefined, [
    { sessionId: "another", entryId: "e2", text: old.content },
  ])!;
  expect(
    store.finishLearning(again.id, [
      {
        scope: "user",
        kind: "preference",
        content: old.content,
        quote: old.content,
        entryId: "e2",
      },
    ]),
  ).toBe(0);
});
it("withholds both inferred contradictions and restores the prior fact when the incoming fact is discarded", () => {
  const { store } = setup();
  const initial = propose(store, "Always use English across projects.");
  store.finishLearning(initial.job.id, [], undefined, [
    { candidateIndex: 0, action: "add", relatedIds: [] },
  ]);
  const old = store.list({ scope: "user" })[0]!;
  const next = propose(store, "Always use French across projects.", "e2");
  store.finishLearning(next.job.id, [], undefined, [
    { candidateIndex: 0, action: "conflict", relatedIds: [old.id] },
  ]);
  expect(store.context(undefined, "language").records).toEqual([]);
  const incoming = store.list({ scope: "user" }).find((r) => r.id !== old.id)!;
  store.resolve({ id: incoming.id, expectedRevision: incoming.revision, choice: "discard" });
  expect(store.context(undefined, "language").records.map((r) => r.id)).toEqual([old.id]);
});
it("rejects cross-scope IDs, invented IDs, incomplete decisions and missing plans without partial commits", () => {
  for (const related of ["foreign", "missing"]) {
    const { store, project } = setup();
    const foreign = store.create({
      scope: "project",
      projectId: project.id,
      kind: "preference",
      content: "project-only",
    });
    const { job } = propose(store, "Use brief prose everywhere.");
    expect(
      store.finishLearning(job.id, [], undefined, [
        {
          candidateIndex: 0,
          action: "duplicate",
          relatedIds: [related === "foreign" ? foreign.id : "missing"],
        },
      ]),
    ).toBe(0);
    expect(store.list({ scope: "user" })).toEqual([]);
    expect(store.state().learning.failed).toBe(1);
  }
  const { store } = setup();
  const { job } = propose(store, "Use Chinese everywhere.");
  expect(store.finishLearning(job.id, [], undefined, [])).toBe(0);
  expect(store.state().learning.pending).toBe(0);
});
it("retains unresolved facts in consolidation without exposing them to answering context", () => {
  const { store } = setup();
  const initial = propose(store, "Use English everywhere.");
  store.finishLearning(initial.job.id, [], undefined, [
    { candidateIndex: 0, action: "add", relatedIds: [] },
  ]);
  const old = store.list({ scope: "user" })[0]!;
  const next = propose(store, "Use French everywhere.", "e2");
  store.finishLearning(next.job.id, [], undefined, [
    { candidateIndex: 0, action: "conflict", relatedIds: [old.id] },
  ]);
  const incoming = store.list({ scope: "user" }).find((r) => r.id !== old.id)!;
  const paraphrase = propose(store, "Across projects prefer French explanations.", "e3");
  expect(paraphrase.plan?.existing.map((r) => r.id)).toContain(incoming.id);
  expect(
    store.finishLearning(paraphrase.job.id, [], undefined, [
      { candidateIndex: 0, action: "duplicate", relatedIds: [incoming.id] },
    ]),
  ).toBe(0);
  expect(store.context(undefined, "language").records).toEqual([]);
  expect(store.list({ scope: "user" })).toHaveLength(2);
});
it("stops on insufficient second-phase budget and never reserves more than the daily cap", () => {
  const { store } = setup();
  store.patchPreferences({ dailyTokenBudget: 10_000 }, store.preferences().revision);
  expect(propose(store, "Use Chinese everywhere.").plan).toBeNull();
  expect(store.state().learning.pending).toBe(0);
  expect(store.state().learning.failed).toBe(1);
  expect(store.state().learning.reservedTokens).toBeLessThanOrEqual(10_000);
});
it("invalidates proposals after forgetting or explicit correction, and rejects competing stale consolidation", () => {
  const { store } = setup();
  const one = propose(store, "Use concise text everywhere.");
  const two = propose(store, "Prefer Chinese everywhere.", "e2");
  expect(
    store.finishLearning(one.job.id, [], undefined, [
      { candidateIndex: 0, action: "add", relatedIds: [] },
    ]),
  ).toBe(1);
  expect(
    store.finishLearning(two.job.id, [], undefined, [
      { candidateIndex: 0, action: "add", relatedIds: [] },
    ]),
  ).toBe(0);
  const pending = propose(store, "Prefer plain text everywhere.", "e3");
  store.clear({ scope: "user" });
  expect(
    store.finishLearning(pending.job.id, [], undefined, [
      { candidateIndex: 0, action: "add", relatedIds: [] },
    ]),
  ).toBe(0);
  expect(store.list({ scope: "user" })).toEqual([]);
});
it("marks malformed or ambiguous evidence failed instead of leaving an unfinishable pending job", () => {
  const { store } = setup();
  const job = store.beginLearning(store.preferences().epoch, undefined, [
    { sessionId: "s", entryId: "e", text: "hello there" },
  ])!;
  expect(store.prepareConsolidation(job.id, [null as unknown as MemoryCandidate])).toBeNull();
  expect(store.state().learning.pending).toBe(0);
  expect(store.state().learning.failed).toBe(1);
});
it("exports forgetting guards and imports them before old records without reviving deleted evidence", () => {
  const { store } = setup();
  const learned = propose(store, "Always prefer Chinese explanations.");
  store.finishLearning(learned.job.id, [], undefined, [
    { candidateIndex: 0, action: "add", relatedIds: [] },
  ]);
  const old = store.exportRecords(true);
  store.forget([old[0]!.id]);
  const guards = store.exportSuppressions(true);
  expect(guards[0]?.sources).toEqual([{ sessionId: "s", entryId: "e1" }]);
  const target = setup().store;
  expect(target.importRecords(old, true, undefined, guards)).toEqual({ imported: 0, skipped: 1 });
  expect(
    target.beginLearning(target.preferences().epoch, undefined, [
      { sessionId: "s", entryId: "e1", text: old[0]!.content },
    ]),
  ).toBeNull();
  expect(target.list({ scope: "user" })).toEqual([]);
});
it("preserves adopted provenance and conflict links across a new database and a repeated archive", () => {
  const { store } = setup();
  const initial = propose(store, "Use English everywhere.");
  store.finishLearning(initial.job.id, [], undefined, [
    { candidateIndex: 0, action: "add", relatedIds: [] },
  ]);
  const old = store.list({ scope: "user" })[0]!;
  const next = propose(store, "Use French everywhere.", "e2");
  store.finishLearning(next.job.id, [], undefined, [
    { candidateIndex: 0, action: "conflict", relatedIds: [old.id] },
  ]);
  const target = setup().store;
  const exported = store.exportRecords(true);
  expect(target.importRecords(exported, true).imported).toBe(2);
  const copied = target.list({ scope: "user" });
  expect(copied.every((item) => item.sources.length === 1 && item.conflicts?.length === 1)).toBe(
    true,
  );
  expect(copied[0]?.conflicts).toContain(copied[1]?.id);
  expect(target.importRecords(exported, true)).toEqual({ imported: 0, skipped: 2 });
  target.forget([copied[1]!.id]);
  expect(target.list({ scope: "user" })[0]?.conflicts).toEqual([]);
  const remaining = target.list({ scope: "user" })[0]!;
  target.resolve({ id: remaining.id, expectedRevision: remaining.revision, choice: "keep" });
  expect(target.context(undefined, "language").records).toHaveLength(1);
});
it("a confirmed correction remains portable even when its previous source is suppressed", () => {
  const { store } = setup();
  const initial = propose(store, "Use English everywhere.");
  store.finishLearning(initial.job.id, [], undefined, [
    { candidateIndex: 0, action: "add", relatedIds: [] },
  ]);
  const old = store.list({ scope: "user" })[0]!;
  store.update({ id: old.id, expectedRevision: old.revision, content: "Use French everywhere." });
  const target = setup().store;
  expect(
    target.importRecords(store.exportRecords(true), true, undefined, store.exportSuppressions(true))
      .imported,
  ).toBe(1);
  expect(target.context(undefined, "language").records[0]?.content).toBe("Use French everywhere.");
});
