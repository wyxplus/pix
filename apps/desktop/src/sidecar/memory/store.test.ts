import { afterEach, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "./store.ts";

const stores: MemoryStore[] = [];
const paths: string[] = [];
function setup() {
  const store = new MemoryStore(":memory:");
  stores.push(store);
  const a = store.project("/git/a", "/work/a", "a");
  const b = store.project("/git/b", "/work/b", "b");
  return { store, a, b };
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  paths.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
const modes = [
  { longTerm: false, shortTerm: false },
  { longTerm: true, shortTerm: false },
  { longTerm: false, shortTerm: true },
  { longTerm: true, shortTerm: true },
];
describe("memory policy transitions", () => {
  for (const [fromIndex, from] of modes.entries())
    for (const [toIndex, to] of modes.entries()) {
      it(`${fromIndex} → ${toIndex}: stored records survive; provider visibility follows policy`, () => {
        const { store, a, b } = setup();
        store.patchPreferences(modes[3]!, 0);
        store.create({ scope: "user", kind: "preference", content: "Use Chinese" });
        store.create({
          scope: "project",
          projectId: a.id,
          kind: "fact",
          content: "A private deployment",
        });
        store.create({
          scope: "project",
          projectId: b.id,
          kind: "fact",
          content: "B private deployment",
        });
        store.patchPreferences(from, store.preferences().revision);
        store.patchPreferences(to, store.preferences().revision);
        const records = store.context(a.id, "deployment").records;
        expect(records.some((r) => r.scope === "user")).toBe(to.longTerm);
        expect(records.some((r) => r.projectId === a.id)).toBe(to.shortTerm);
        expect(records.some((r) => r.projectId === b.id)).toBe(false);
        expect(store.list({ scope: "user" })).toHaveLength(1);
        for (const [scope, enabled] of [
          ["user", to.longTerm],
          ["project", to.shortTerm],
        ] as const) {
          const create = () =>
            store.create({
              scope,
              kind: "fact",
              content: "new fact",
              ...(scope === "project" ? { projectId: a.id } : {}),
            });
          if (enabled) expect(create).not.toThrow();
          else expect(create).toThrow("scope_disabled");
        }
      });
    }
});
it("defaults off and rejects cross-scope input", () => {
  const { store, a } = setup();
  expect(store.context(a.id, "").records).toEqual([]);
  expect(() => store.create({ scope: "user", kind: "fact", content: "x" })).toThrow(
    "scope_disabled",
  );
  expect(() =>
    store.create({ scope: "user", projectId: a.id, kind: "fact", content: "x" }),
  ).toThrow("out_of_scope");
  expect(() => store.patchPreferences({ revision: 100 }, 0)).toThrow("invalid_preferences");
});
it("shares Git worktrees, isolates clones, and enforces optimistic correction", () => {
  const { store, a } = setup();
  expect(store.project("/git/a", "/work/worktree", "worktree").id).toBe(a.id);
  expect(store.project("/git/clone", "/work/clone", "clone").id).not.toBe(a.id);
  store.patchPreferences({ shortTerm: true }, 0);
  const item = store.create({ scope: "project", projectId: a.id, kind: "fact", content: "old" });
  store.update({ id: item.id, expectedRevision: 1, content: "corrected" });
  expect(() => store.update({ id: item.id, expectedRevision: 1, content: "stale" })).toThrow(
    "revision_conflict",
  );
  expect(store.context(a.id, "corrected").records[0]?.content).toBe("corrected");
});
it("clears the entire scope beyond UI pagination while disabled", () => {
  const { store, a } = setup();
  store.patchPreferences({ longTerm: true, shortTerm: true }, 0);
  for (let i = 0; i < 1005; i++)
    store.create({ scope: "user", kind: "fact", content: `fact ${i}` });
  store.create({ scope: "project", projectId: a.id, kind: "fact", content: "keep" });
  store.patchPreferences({ longTerm: false }, store.preferences().revision);
  store.clear({ scope: "user" });
  expect(store.state().counts).toEqual({ user: 0, project: 1 });
  expect(store.preferences().epoch).toBeGreaterThan(3);
});
it("reopens durable records and policy after cold start", () => {
  const path = mkdtempSync(join(tmpdir(), "pix-memory-"));
  paths.push(path);
  const first = new MemoryStore(join(path, "memory.sqlite"));
  first.patchPreferences({ longTerm: true }, 0);
  first.create({ scope: "user", kind: "fact", content: "durable" });
  const instance = first.instanceId();
  first.close();
  const next = new MemoryStore(join(path, "memory.sqlite"));
  stores.push(next);
  expect(next.instanceId()).toBe(instance);
  expect(next.context(undefined, "durable").records[0]?.content).toBe("durable");
});

function learningFixture() {
  const { store, a } = setup();
  store.patchPreferences({ longTerm: true, shortTerm: true, dailyTokenBudget: 100_000 }, 0);
  const source = {
    sessionId: "s1",
    entryId: "e1",
    text: "I prefer Chinese across all projects. Project A uses pnpm.",
  };
  const candidate = {
    scope: "project" as const,
    kind: "fact" as const,
    content: "Project A uses pnpm.",
    quote: "Project A uses pnpm.",
    entryId: "e1",
  };
  return { store, a, source, candidate };
}
it("does not reserve model calls with zero budget", () => {
  const { store, a } = setup();
  store.patchPreferences({ longTerm: true }, 0);
  expect(
    store.beginLearning(1, a.id, [{ sessionId: "s", entryId: "e", text: "remember text" }]),
  ).toBeNull();
});
it("extracts and consolidates once with evidence and scope", () => {
  const { store, a, source, candidate } = learningFixture();
  const job = store.beginLearning(store.preferences().epoch, a.id, [source])!;
  expect(job).not.toBeNull();
  expect(store.finishLearning(job.id, [candidate])).toBe(1);
  expect(store.finishLearning(job.id, [candidate])).toBe(0);
  expect(store.beginLearning(store.preferences().epoch, a.id, [source])).toBeNull();
  expect(store.context(a.id, "pnpm").records[0]?.sources).toEqual([
    { sessionId: "s1", entryId: "e1" },
  ]);
});
it.each(["disable", "clear", "correct"])("rejects a stale extraction after %s", (operation) => {
  const { store, a, source, candidate } = learningFixture();
  const job = store.beginLearning(store.preferences().epoch, a.id, [source])!;
  if (operation === "disable")
    store.patchPreferences({ shortTerm: false }, store.preferences().revision);
  if (operation === "clear") store.clear({ scope: "project", projectId: a.id });
  if (operation === "correct")
    store.create({ scope: "project", projectId: a.id, kind: "fact", content: "Use npm instead" });
  expect(store.finishLearning(job.id, [candidate])).toBe(0);
  expect(
    store.list({ scope: "project", projectId: a.id }).some((item) => item.content.includes("pnpm")),
  ).toBe(false);
});
it("blocks quoted evidence fabrication and scope escalation", () => {
  const { store, a, source, candidate } = learningFixture();
  store.patchPreferences({ longTerm: false }, store.preferences().revision);
  const job = store.beginLearning(store.preferences().epoch, a.id, [source])!;
  expect(store.finishLearning(job.id, [{ ...candidate, scope: "user" }])).toBe(0);
  const other = store.beginLearning(store.preferences().epoch, a.id, [
    { ...source, entryId: "e2" },
  ])!;
  expect(
    store.finishLearning(other.id, [{ ...candidate, entryId: "e2", quote: "fabricated evidence" }]),
  ).toBe(0);
});
it("does not resurrect forgotten facts from imports or source replay", () => {
  const { store, a, source, candidate } = learningFixture();
  const job = store.beginLearning(store.preferences().epoch, a.id, [source])!;
  store.finishLearning(job.id, [candidate]);
  const exported = store.exportRecords(false, a.id);
  store.forget([exported[0]!.id]);
  expect(store.importRecords(exported, false, a.id)).toEqual({ imported: 0, skipped: 1 });
  expect(store.beginLearning(store.preferences().epoch, a.id, [source])).toBeNull();
});
it("maps imported projects explicitly and leaves preferences unchanged", () => {
  const { store, a, b } = setup();
  store.patchPreferences({ shortTerm: true }, 0);
  store.create({ scope: "project", projectId: a.id, kind: "fact", content: "from A" });
  const exported = store.exportRecords(false, a.id);
  expect(store.importRecords(exported, false)).toEqual({ imported: 0, skipped: 1 });
  expect(store.importRecords(exported, false, b.id)).toEqual({ imported: 1, skipped: 0 });
  expect(store.importRecords(exported, false, b.id)).toEqual({ imported: 0, skipped: 1 });
  expect(store.preferences().longTerm).toBe(false);
});
it("retrieves indexed evidence beyond management pagination and handles CJK queries", () => {
  const { store } = setup();
  store.patchPreferences({ longTerm: true }, 0);
  const old = store.create({
    scope: "user",
    kind: "fact",
    content: "Use the zephyr database; 数据库采用星河引擎。",
  });
  for (let i = 0; i < 1050; i++)
    store.create({ scope: "user", kind: "fact", content: `Unrelated item ${i}` });
  expect(store.context(undefined, "zephyr database").records[0]?.id).toBe(old.id);
  expect(store.context(undefined, "数据库").records[0]?.id).toBe(old.id);
});
