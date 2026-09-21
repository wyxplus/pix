import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  assertMemoryInput,
  assertMemoryScope,
  assertMemoryText,
  type MemoryContext,
  type MemoryInput,
  type MemoryPreferences,
  type MemoryLearningJob,
  type MemoryLearningSource,
  type MemoryCandidate,
  type MemoryConsolidationPlan,
  type MemoryConsolidationDecision,
  type MemoryProject,
  type MemoryRecord,
  type MemoryScope,
  type MemoryState,
  type MemorySuppression,
} from "@pix/contracts";

const DEFAULTS: MemoryPreferences = {
  longTerm: false,
  shortTerm: false,
  learnPersonal: true,
  learnProject: true,
  dailyTokenBudget: 0,
  revision: 0,
  epoch: 0,
};

export function memoryFactKey(content: string): string {
  return createHash("sha256")
    .update(content.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase())
    .digest("hex");
}

/** Used only by the database worker in production. */
export class MemoryStore {
  private readonly db: DatabaseSync;
  private readonly liveJobs = new Map<string, MemoryLearningJob>();
  private readonly proposals = new Map<string, MemoryConsolidationPlan & { revision: number }>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const version = Number(this.db.prepare("PRAGMA user_version").get()!.user_version);
    if (version > 2) {
      this.db.close();
      throw new Error("unsupported_memory_schema");
    }
    this.db.exec(`
      PRAGMA user_version=2;
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, identity TEXT UNIQUE NOT NULL, root TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS roots (root TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, project_id TEXT REFERENCES projects(id),
        fact_key TEXT NOT NULL, content TEXT NOT NULL, data TEXT NOT NULL,
        CHECK ((scope='user' AND project_id IS NULL) OR (scope='project' AND project_id IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(scope, project_id);
      CREATE TABLE IF NOT EXISTS suppressions (
        scope TEXT NOT NULL, project_id TEXT NOT NULL, fact_key TEXT NOT NULL,
        PRIMARY KEY(scope, project_id, fact_key)
      );
      CREATE TABLE IF NOT EXISTS suppression_sources (
        scope TEXT NOT NULL, project_id TEXT NOT NULL, fact_key TEXT NOT NULL,
        session_id TEXT NOT NULL, entry_id TEXT NOT NULL,
        PRIMARY KEY(scope, project_id, fact_key, session_id, entry_id)
      );
      CREATE TABLE IF NOT EXISTS learning_jobs (
        id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, status TEXT NOT NULL,
        day TEXT NOT NULL, reserved INTEGER NOT NULL, data TEXT NOT NULL, error TEXT
      );
      CREATE TABLE IF NOT EXISTS learning_sources (session_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY(session_id,entry_id));
      CREATE TABLE IF NOT EXISTS blocked_sources (session_id TEXT NOT NULL, entry_id TEXT NOT NULL, PRIMARY KEY(session_id,entry_id));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, content, tokenize='unicode61');
    `);
    // A crashed model request is never silently billed again on restart.
    this.db
      .prepare(
        "UPDATE learning_jobs SET status='failed', error='interrupted' WHERE status IN ('extracting','consolidating')",
      )
      .run();
    this.db
      .prepare("INSERT OR IGNORE INTO meta VALUES ('preferences', ?)")
      .run(JSON.stringify(DEFAULTS));
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('instance', ?)").run(randomUUID());
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES ('revision', '0')").run();
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private meta(key: string): string {
    return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string })
      .value;
  }

  instanceId(): string {
    return this.meta("instance");
  }
  revision(): number {
    return Number(this.meta("revision"));
  }
  preferences(): MemoryPreferences {
    return JSON.parse(this.meta("preferences"));
  }

  private bump(): void {
    this.db
      .prepare("UPDATE meta SET value=? WHERE key='revision'")
      .run(String(this.revision() + 1));
  }

  patchPreferences(patch: Partial<MemoryPreferences>, expectedRevision: number): MemoryPreferences {
    if (!patch || typeof patch !== "object" || Array.isArray(patch))
      throw new Error("invalid_preferences");
    for (const [key, value] of Object.entries(patch)) {
      if (["longTerm", "shortTerm", "learnPersonal", "learnProject"].includes(key)) {
        if (typeof value !== "boolean") throw new Error("invalid_preferences");
      } else if (key === "dailyTokenBudget") {
        if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000)
          throw new Error("invalid_budget");
      } else throw new Error("invalid_preferences");
    }
    return this.transaction(() => {
      const old = this.preferences();
      if (old.revision !== expectedRevision) throw new Error("revision_conflict");
      const next = { ...old, ...patch, revision: old.revision + 1, epoch: old.epoch + 1 };
      this.db.prepare("UPDATE meta SET value=? WHERE key='preferences'").run(JSON.stringify(next));
      this.cancelLearning();
      this.bump();
      return next;
    });
  }

  state(): MemoryState {
    const projects = this.db
      .prepare("SELECT id,root,name FROM projects ORDER BY name")
      .all() as unknown as MemoryProject[];
    const counts = { user: 0, project: 0 };
    for (const row of this.db
      .prepare("SELECT scope,COUNT(*) AS count FROM memories GROUP BY scope")
      .all()) {
      counts[row.scope as MemoryScope] = Number(row.count);
    }
    const day = new Date().toISOString().slice(0, 10);
    const budget = this.db
      .prepare("SELECT COALESCE(SUM(reserved),0) AS n FROM learning_jobs WHERE day=?")
      .get(day)!;
    const learning = { reservedTokens: Number(budget.n), completed: 0, failed: 0, pending: 0 };
    for (const row of this.db
      .prepare("SELECT status,COUNT(*) AS n FROM learning_jobs GROUP BY status")
      .all()) {
      if (row.status === "completed") learning.completed = Number(row.n);
      else if (row.status === "failed") learning.failed = Number(row.n);
      else learning.pending += Number(row.n);
    }
    return { preferences: this.preferences(), projects, counts, learning };
  }

  project(identity: string, root: string, name: string): MemoryProject {
    assertMemoryText(identity, 8192);
    assertMemoryText(root, 8192);
    assertMemoryText(name, 512);
    return this.transaction(() => {
      let row = this.db
        .prepare("SELECT id,root,name FROM projects WHERE identity=?")
        .get(identity) as unknown as MemoryProject | undefined;
      if (!row) {
        row = { id: randomUUID(), root, name };
        this.db.prepare("INSERT INTO projects VALUES (?,?,?,?)").run(row.id, identity, root, name);
      }
      this.db
        .prepare(
          "INSERT INTO roots VALUES (?,?) ON CONFLICT(root) DO UPDATE SET project_id=excluded.project_id",
        )
        .run(root, row.id);
      return row;
    });
  }

  private scope(scope: MemoryScope, projectId?: string): string | null {
    assertMemoryScope(scope);
    if (scope === "user") {
      if (projectId != null) throw new Error("out_of_scope");
      return null;
    }
    assertMemoryText(projectId, 128);
    if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(projectId))
      throw new Error("no_project");
    return projectId;
  }

  private enabled(scope: MemoryScope): void {
    const policy = this.preferences();
    if (!(scope === "user" ? policy.longTerm : policy.shortTerm)) throw new Error("scope_disabled");
  }

  list(input: { scope: MemoryScope; projectId?: string; query?: string }): MemoryRecord[] {
    const projectId = this.scope(input.scope, input.projectId);
    const rows = this.db
      .prepare("SELECT data FROM memories WHERE scope=? AND project_id IS ? ORDER BY id")
      .all(input.scope, projectId);
    const query =
      typeof input.query === "string" ? input.query.trim().toLowerCase().slice(0, 500) : "";
    return rows
      .map((row) => JSON.parse(String(row.data)) as MemoryRecord)
      .filter((row) => !query || row.content.toLowerCase().includes(query))
      .slice(0, 1000);
  }

  create(input: MemoryInput): MemoryRecord {
    assertMemoryInput(input);
    return this.transaction(() => {
      const projectId = this.scope(input.scope, input.projectId);
      this.enabled(input.scope);
      const now = new Date().toISOString();
      const item: MemoryRecord = {
        id: randomUUID(),
        scope: input.scope,
        projectId,
        kind: input.kind,
        content: input.content.trim(),
        factKey: memoryFactKey(input.content),
        conditions: input.conditions?.trim() ?? "",
        status: "active",
        origin: "explicit",
        sources: [],
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      // A direct user action may remember this exact fact again, never an entire scope.
      this.db
        .prepare("DELETE FROM suppressions WHERE scope=? AND project_id=? AND fact_key=?")
        .run(item.scope, projectId ?? "", item.factKey);
      this.db
        .prepare("DELETE FROM suppression_sources WHERE scope=? AND project_id=? AND fact_key=?")
        .run(item.scope, projectId ?? "", item.factKey);
      this.save(item);
      this.invalidate();
      return item;
    });
  }

  private save(item: MemoryRecord): void {
    this.db
      .prepare(
        "INSERT INTO memories VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fact_key=excluded.fact_key,content=excluded.content,data=excluded.data",
      )
      .run(item.id, item.scope, item.projectId, item.factKey, item.content, JSON.stringify(item));
    this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(item.id);
    this.db.prepare("INSERT INTO memory_fts VALUES (?,?)").run(item.id, item.content);
  }

  update(input: {
    id: string;
    expectedRevision: number;
    content: string;
    conditions?: string;
  }): MemoryRecord {
    assertMemoryText(input.content);
    if (
      input.conditions !== undefined &&
      (typeof input.conditions !== "string" || input.conditions.length > 1000)
    )
      throw new Error("invalid_memory_conditions");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT data FROM memories WHERE id=?").get(input.id);
      if (!row) throw new Error("memory_not_found");
      const old = JSON.parse(String(row.data)) as MemoryRecord;
      this.enabled(old.scope);
      if (old.revision !== input.expectedRevision) throw new Error("revision_conflict");
      this.suppress(old);
      for (const id of old.conflicts ?? []) {
        const row = this.db.prepare("SELECT data FROM memories WHERE id=?").get(id);
        if (!row) continue;
        const related = JSON.parse(String(row.data)) as MemoryRecord;
        if (related.scope !== old.scope || related.projectId !== old.projectId)
          throw new Error("out_of_scope");
        this.suppress(related);
        this.save({
          ...related,
          conflicts: (related.conflicts ?? []).filter((id) => id !== old.id),
          status: "superseded",
          revision: related.revision + 1,
          updatedAt: new Date().toISOString(),
        });
      }
      const item = {
        ...old,
        content: input.content.trim(),
        factKey: memoryFactKey(input.content),
        conditions: input.conditions ?? old.conditions,
        origin: "explicit" as const,
        status: "active" as const,
        sources: [],
        conflicts: [],
        revision: old.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.save(item);
      this.invalidate();
      return item;
    });
  }

  private suppress(item: MemoryRecord): void {
    this.db
      .prepare("INSERT OR IGNORE INTO suppressions VALUES (?,?,?)")
      .run(item.scope, item.projectId ?? "", item.factKey);
    for (const source of item.sources) {
      this.db
        .prepare("INSERT OR IGNORE INTO blocked_sources VALUES (?,?)")
        .run(source.sessionId, source.entryId);
      this.db
        .prepare("INSERT OR IGNORE INTO suppression_sources VALUES (?,?,?,?,?)")
        .run(item.scope, item.projectId ?? "", item.factKey, source.sessionId, source.entryId);
    }
  }

  private cancelLearning(): void {
    this.liveJobs.clear();
    this.proposals.clear();
    this.db
      .prepare(
        "UPDATE learning_jobs SET status='failed',error='policy_changed' WHERE status IN ('extracting','consolidating')",
      )
      .run();
  }

  private invalidate(): void {
    this.cancelLearning();
    const policy = this.preferences();
    this.db
      .prepare("UPDATE meta SET value=? WHERE key='preferences'")
      .run(JSON.stringify({ ...policy, revision: policy.revision + 1, epoch: policy.epoch + 1 }));
    this.bump();
  }

  forget(ids: string[]): void {
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some((id) => typeof id !== "string"))
      throw new Error("invalid_memory_ids");
    this.transaction(() => {
      for (const id of ids) {
        const row = this.db.prepare("SELECT data FROM memories WHERE id=?").get(id);
        if (!row) continue;
        this.suppress(JSON.parse(String(row.data)));
        this.db.prepare("DELETE FROM memories WHERE id=?").run(id);
        this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(id);
      }
      this.pruneConflicts(new Set(ids));
      this.invalidate();
    });
  }

  private pruneConflicts(removed: Set<string>): void {
    for (const row of this.db
      .prepare(
        "SELECT data FROM memories WHERE json_array_length(json_extract(data,'$.conflicts')) > 0",
      )
      .all()) {
      const item = JSON.parse(String(row.data)) as MemoryRecord;
      const conflicts = item.conflicts!.filter((id) => !removed.has(id));
      if (conflicts.length !== item.conflicts!.length)
        this.save({
          ...item,
          conflicts,
          revision: item.revision + 1,
          updatedAt: new Date().toISOString(),
        });
    }
  }

  clear(input: { scope: MemoryScope; projectId?: string }): void {
    const projectId = this.scope(input.scope, input.projectId);
    this.transaction(() => {
      const rows = this.db
        .prepare("SELECT id,data FROM memories WHERE scope=? AND project_id IS ?")
        .all(input.scope, projectId);
      for (const row of rows) {
        this.suppress(JSON.parse(String(row.data)));
        this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(row.id!);
      }
      this.db
        .prepare("DELETE FROM memories WHERE scope=? AND project_id IS ?")
        .run(input.scope, projectId);
      this.invalidate();
    });
  }

  projectRoots(projectId: string): string[] {
    this.scope("project", projectId);
    return this.db
      .prepare("SELECT root FROM roots WHERE project_id=?")
      .all(projectId)
      .map((row) => String(row.root));
  }

  exportRecords(personal: boolean, projectId?: string): MemoryRecord[] {
    if (typeof personal !== "boolean") throw new Error("invalid_scope");
    if (projectId) this.scope("project", projectId);
    return this.db
      .prepare(
        "SELECT data FROM memories WHERE (? AND scope='user') OR (scope='project' AND project_id=?) ORDER BY id",
      )
      .all(personal ? 1 : 0, projectId ?? null)
      .map((row) => JSON.parse(String(row.data)) as MemoryRecord);
  }

  exportSuppressions(personal: boolean, projectId?: string): MemorySuppression[] {
    if (typeof personal !== "boolean") throw new Error("invalid_scope");
    if (projectId) this.scope("project", projectId);
    return this.db
      .prepare(
        "SELECT * FROM suppressions WHERE (? AND scope='user') OR (scope='project' AND project_id=?)",
      )
      .all(personal ? 1 : 0, projectId ?? null)
      .map((row) => ({
        scope: row.scope as MemoryScope,
        projectId: row.project_id ? String(row.project_id) : null,
        factKey: String(row.fact_key),
        sources: this.db
          .prepare(
            "SELECT session_id,entry_id FROM suppression_sources WHERE scope=? AND project_id=? AND fact_key=?",
          )
          .all(row.scope!, row.project_id!, row.fact_key!)
          .map((source) => ({
            sessionId: String(source.session_id),
            entryId: String(source.entry_id),
          })),
      }));
  }

  importRecords(
    records: MemoryRecord[],
    personal: boolean,
    projectId?: string,
    suppressions: MemorySuppression[] = [],
  ): { imported: number; skipped: number } {
    if (!Array.isArray(records) || records.length > 100_000) throw new Error("invalid_archive");
    if (personal) this.enabled("user");
    if (projectId) {
      this.scope("project", projectId);
      this.enabled("project");
    }
    return this.transaction(() => {
      // A copied forgetting guard only applies to copied data. Never deletes newer local facts.
      for (const guard of suppressions) {
        if ((guard.scope === "user" && !personal) || (guard.scope === "project" && !projectId))
          continue;
        assertMemoryScope(guard.scope);
        if (!/^[a-f0-9]{64}$/.test(guard.factKey) || !Array.isArray(guard.sources))
          throw new Error("invalid_suppression");
        const mapped = guard.scope === "project" ? projectId! : "";
        this.db
          .prepare("INSERT OR IGNORE INTO suppressions VALUES (?,?,?)")
          .run(guard.scope, mapped, guard.factKey);
        for (const source of guard.sources) {
          assertMemoryText(source.sessionId, 128);
          assertMemoryText(source.entryId, 128);
          this.db
            .prepare("INSERT OR IGNORE INTO blocked_sources VALUES (?,?)")
            .run(source.sessionId, source.entryId);
          this.db
            .prepare("INSERT OR IGNORE INTO suppression_sources VALUES (?,?,?,?,?)")
            .run(guard.scope, mapped, guard.factKey, source.sessionId, source.entryId);
        }
      }
      let imported = 0,
        skipped = 0;
      const ids = new Map<string, string>();
      const pending: { source: MemoryRecord; record: MemoryRecord }[] = [];
      for (const source of records) {
        if ((source.scope === "user" && !personal) || (source.scope === "project" && !projectId)) {
          skipped++;
          continue;
        }
        const mapped = source.scope === "project" ? projectId! : null;
        assertMemoryInput({ ...source, projectId: mapped ?? undefined });
        const key = memoryFactKey(source.content);
        if (
          Array.isArray(source.sources) &&
          source.sources.some((item) =>
            this.db
              .prepare("SELECT 1 FROM blocked_sources WHERE session_id=? AND entry_id=?")
              .get(item.sessionId, item.entryId),
          )
        ) {
          skipped++;
          continue;
        }
        if (
          this.db
            .prepare("SELECT 1 FROM suppressions WHERE scope=? AND project_id=? AND fact_key=?")
            .get(source.scope, mapped ?? "", key) ||
          this.db
            .prepare("SELECT 1 FROM memories WHERE scope=? AND project_id IS ? AND fact_key=?")
            .get(source.scope, mapped, key)
        ) {
          skipped++;
          continue;
        }
        const now = new Date().toISOString();
        const record: MemoryRecord = {
          id: randomUUID(),
          scope: source.scope,
          projectId: mapped,
          kind: source.kind,
          content: source.content,
          factKey: key,
          conditions: source.conditions ?? "",
          status: source.status,
          origin: "imported",
          sources: source.sources ?? [],
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.save(record);
        ids.set(source.id, record.id);
        pending.push({ source, record });
        imported++;
      }
      for (const { source, record } of pending) {
        const conflicts = (source.conflicts ?? []).flatMap((id) =>
          ids.has(id) ? [ids.get(id)!] : [],
        );
        if (conflicts.length) this.save({ ...record, conflicts });
      }
      if (imported || suppressions.length) this.invalidate();
      return { imported, skipped };
    });
  }

  beginLearning(
    epoch: number,
    projectId: string | undefined,
    sources: MemoryLearningSource[],
  ): MemoryLearningJob | null {
    if (!Array.isArray(sources) || sources.length > 20 || !sources.length) return null;
    for (const source of sources) {
      assertMemoryText(source.sessionId, 128);
      assertMemoryText(source.entryId, 128);
      assertMemoryText(source.text, 4000);
    }
    return this.transaction(() => {
      const policy = this.preferences();
      if (epoch !== policy.epoch) return null;
      const scopes: MemoryScope[] = [];
      if (policy.longTerm && policy.learnPersonal) scopes.push("user");
      if (projectId && policy.shortTerm && policy.learnProject) {
        this.scope("project", projectId);
        scopes.push("project");
      }
      if (!scopes.length) return null;
      const fresh = sources.filter(
        (source) =>
          !this.db
            .prepare("SELECT 1 FROM learning_sources WHERE session_id=? AND entry_id=?")
            .get(source.sessionId, source.entryId) &&
          !this.db
            .prepare("SELECT 1 FROM blocked_sources WHERE session_id=? AND entry_id=?")
            .get(source.sessionId, source.entryId),
      );
      if (!fresh.length) return null;
      const day = new Date().toISOString().slice(0, 10);
      const used = Number(
        this.db
          .prepare("SELECT COALESCE(SUM(reserved),0) AS n FROM learning_jobs WHERE day=?")
          .get(day)!.n,
      );
      // Conservative character-based reservation plus fixed prompt/output allowance.
      const reserved = JSON.stringify(fresh).length * 2 + 6000;
      if (used + reserved > policy.dailyTokenBudget) return null;
      const job: MemoryLearningJob = {
        id: randomUUID(),
        epoch,
        projectId: projectId ?? null,
        scopes,
        sources: fresh,
      };
      for (const source of fresh)
        this.db
          .prepare("INSERT OR IGNORE INTO learning_sources VALUES (?,?)")
          .run(source.sessionId, source.entryId);
      this.db
        .prepare("INSERT INTO learning_jobs VALUES (?,?, 'extracting',?,?,?,NULL)")
        .run(job.id, epoch, day, reserved, JSON.stringify({ ...job, sources: [] }));
      this.liveJobs.set(job.id, job);
      return job;
    });
  }

  private validCandidates(job: MemoryLearningJob, candidates: MemoryCandidate[]): boolean {
    if (!Array.isArray(candidates) || candidates.length > 8) return false;
    try {
      for (const item of candidates) {
        assertMemoryInput({
          ...item,
          ...(item.scope === "project" ? { projectId: job.projectId } : {}),
        });
        const sources = job.sources.filter((source) => source.entryId === item.entryId);
        if (
          !job.scopes.includes(item.scope) ||
          sources.length !== 1 ||
          typeof item.quote !== "string" ||
          item.quote.trim().length < 4 ||
          !sources[0]!.text.includes(item.quote) ||
          item.content.length > 2000
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  prepareConsolidation(id: string, candidates: MemoryCandidate[]): MemoryConsolidationPlan | null {
    const job = this.liveJobs.get(id);
    if (!job || this.proposals.has(id)) return null;
    if (job.epoch !== this.preferences().epoch || !this.validCandidates(job, candidates)) {
      this.finishLearning(id, [], "invalid_evidence");
      return null;
    }
    if (!candidates.length) {
      this.finishLearning(id, []);
      return null;
    }
    const records = new Map<string, MemoryRecord>();
    for (const candidate of candidates) {
      const context = this.retrievalContext(job.projectId ?? undefined, candidate.content, true);
      for (const item of context.records)
        if (item.scope === candidate.scope && records.size < 32) records.set(item.id, item);
    }
    const plan: MemoryConsolidationPlan = {
      candidates: structuredClone(candidates),
      existing: [...records.values()],
    };
    const reserved = JSON.stringify(plan).length * 2 + 5000;
    const day = new Date().toISOString().slice(0, 10);
    const used = Number(
      this.db
        .prepare("SELECT COALESCE(SUM(reserved),0) AS n FROM learning_jobs WHERE day=?")
        .get(day)!.n,
    );
    if (used + reserved > this.preferences().dailyTokenBudget) {
      this.finishLearning(id, [], "consolidation_budget_exhausted");
      return null;
    }
    this.db
      .prepare("UPDATE learning_jobs SET status='consolidating',reserved=reserved+? WHERE id=?")
      .run(reserved, id);
    this.proposals.set(id, { ...plan, revision: this.revision() });
    return plan;
  }

  finishLearning(
    id: string,
    candidates: MemoryCandidate[],
    error?: string,
    decisions?: MemoryConsolidationDecision[],
  ): number {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT data,status FROM learning_jobs WHERE id=?").get(id);
      if (!row || !["extracting", "consolidating"].includes(String(row.status))) return 0;
      const job = this.liveJobs.get(id);
      if (!job) return 0;
      const fail = (reason: string) => {
        this.liveJobs.delete(id);
        this.proposals.delete(id);
        this.db
          .prepare("UPDATE learning_jobs SET status='failed',error=?,data=? WHERE id=?")
          .run(reason, JSON.stringify({ ...job, sources: [] }), id);
        return 0;
      };
      if (error) return fail(error.slice(0, 200));
      if (job.epoch !== this.preferences().epoch) return fail("policy_changed");
      const plan = this.proposals.get(id);
      if (plan) {
        candidates = plan.candidates;
        if (plan.revision !== this.revision()) return fail("consolidation_stale");
        if (!Array.isArray(decisions) || decisions.length !== candidates.length)
          return fail("invalid_consolidation");
        const indices = new Set<number>();
        for (const decision of decisions) {
          if (
            !decision ||
            !Number.isInteger(decision.candidateIndex) ||
            !candidates[decision.candidateIndex] ||
            indices.has(decision.candidateIndex) ||
            !["add", "duplicate", "conflict"].includes(decision.action) ||
            !Array.isArray(decision.relatedIds) ||
            new Set(decision.relatedIds).size !== decision.relatedIds.length
          )
            return fail("invalid_consolidation");
          indices.add(decision.candidateIndex);
          if (
            (decision.action === "add" && decision.relatedIds.length !== 0) ||
            (decision.action === "duplicate" && decision.relatedIds.length !== 1) ||
            (decision.action === "conflict" && !decision.relatedIds.length)
          )
            return fail("invalid_consolidation");
          for (const relatedId of decision.relatedIds) {
            const related = plan.existing.find((item) => item.id === relatedId);
            const candidate = candidates[decision.candidateIndex]!;
            if (
              !related ||
              related.scope !== candidate.scope ||
              related.projectId !== (candidate.scope === "project" ? job.projectId : null) ||
              !["active", "disputed"].includes(related.status) ||
              (decision.action === "duplicate" &&
                (related.kind !== candidate.kind || related.conditions))
            )
              return fail("out_of_scope_consolidation");
          }
        }
      } else if (decisions) return fail("missing_consolidation_plan");
      if (!this.validCandidates(job, candidates)) return fail("invalid_evidence");
      // Phase two commits against the frozen revision. Human corrections always win.
      let count = 0;
      for (const [index, item] of candidates.entries()) {
        const source = job.sources.find((source) => source.entryId === item.entryId)!;
        const projectId = item.scope === "project" ? job.projectId : null;
        const factKey = memoryFactKey(item.content);
        if (
          this.db
            .prepare("SELECT 1 FROM blocked_sources WHERE session_id=? AND entry_id=?")
            .get(source.sessionId, source.entryId)
        )
          continue;
        if (
          this.db
            .prepare("SELECT 1 FROM suppressions WHERE scope=? AND project_id=? AND fact_key=?")
            .get(item.scope, projectId ?? "", factKey)
        )
          continue;
        const now = new Date().toISOString();
        const decision = decisions?.find((decision) => decision.candidateIndex === index);
        const exact = this.db
          .prepare("SELECT data FROM memories WHERE scope=? AND project_id IS ? AND fact_key=?")
          .get(item.scope, projectId, factKey);
        const duplicate = exact
          ? (JSON.parse(String(exact.data)) as MemoryRecord)
          : decision?.action === "duplicate"
            ? plan?.existing.find((record) => record.id === decision.relatedIds[0])
            : undefined;
        if (duplicate) {
          if (duplicate.status === "active") {
            const current = JSON.parse(
              String(
                this.db.prepare("SELECT data FROM memories WHERE id=?").get(duplicate.id)!.data,
              ),
            ) as MemoryRecord;
            const sources = [
              ...current.sources,
              { sessionId: source.sessionId, entryId: source.entryId },
            ];
            const unique = [...new Map(sources.map((s) => [JSON.stringify(s), s])).values()].slice(
              -1000,
            );
            this.save({
              ...current,
              sources: unique,
              revision: current.revision + 1,
              updatedAt: now,
            });
            count++;
          }
          continue;
        }
        const newId = randomUUID();
        const conflicts = decision?.action === "conflict" ? decision.relatedIds : [];
        for (const relatedId of conflicts) {
          const related = JSON.parse(
            String(this.db.prepare("SELECT data FROM memories WHERE id=?").get(relatedId)!.data),
          ) as MemoryRecord;
          this.save({
            ...related,
            status: related.origin === "explicit" ? related.status : "disputed",
            conflicts: [...new Set([...(related.conflicts ?? []), newId])],
            revision: related.revision + 1,
            updatedAt: now,
          });
        }
        this.save({
          id: newId,
          scope: item.scope,
          projectId,
          kind: item.kind,
          content: item.content.trim(),
          factKey,
          status: conflicts.length ? "disputed" : "active",
          ...(conflicts.length ? { conflicts } : {}),
          origin: "inferred",
          conditions: "",
          sources: [{ sessionId: source.sessionId, entryId: source.entryId }],
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
        count++;
      }
      this.db
        .prepare("UPDATE learning_jobs SET status='completed',data=? WHERE id=?")
        .run(JSON.stringify({ ...job, sources: [] }), id);
      this.liveJobs.delete(id);
      this.proposals.delete(id);
      if (count) this.bump();
      return count;
    });
  }

  resolve(input: {
    id: string;
    expectedRevision: number;
    choice: "keep" | "discard";
  }): MemoryRecord {
    if (!["keep", "discard"].includes(input.choice)) throw new Error("invalid_conflict_choice");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT data FROM memories WHERE id=?").get(input.id);
      if (!row) throw new Error("memory_not_found");
      const item = JSON.parse(String(row.data)) as MemoryRecord;
      this.enabled(item.scope);
      if (item.revision !== input.expectedRevision) throw new Error("revision_conflict");
      if (!item.conflicts?.length && item.status !== "disputed")
        throw new Error("no_memory_conflict");
      const now = new Date().toISOString();
      for (const relatedId of item.conflicts ?? []) {
        const row = this.db.prepare("SELECT data FROM memories WHERE id=?").get(relatedId);
        if (!row) continue;
        const related = JSON.parse(String(row.data)) as MemoryRecord;
        if (related.scope !== item.scope || related.projectId !== item.projectId)
          throw new Error("out_of_scope");
        const conflicts = (related.conflicts ?? []).filter((id) => id !== item.id);
        if (input.choice === "keep") this.suppress(related);
        this.save({
          ...related,
          conflicts,
          status:
            input.choice === "keep"
              ? "superseded"
              : related.status === "disputed" && !conflicts.length
                ? "active"
                : related.status,
          revision: related.revision + 1,
          updatedAt: now,
        });
      }
      if (input.choice === "discard") this.suppress(item);
      const resolved: MemoryRecord = {
        ...item,
        conflicts: [],
        status: input.choice === "keep" ? "active" : "superseded",
        origin: "explicit",
        sources: input.choice === "keep" ? [] : item.sources,
        revision: item.revision + 1,
        updatedAt: now,
      };
      this.save(resolved);
      this.invalidate();
      return resolved;
    });
  }

  context(projectId: string | undefined, query: string): MemoryContext {
    return this.retrievalContext(projectId, query, false);
  }

  private retrievalContext(
    projectId: string | undefined,
    query: string,
    includeDisputed: boolean,
  ): MemoryContext {
    const policy = this.preferences();
    if (projectId && policy.shortTerm) this.scope("project", projectId);
    const project = policy.shortTerm ? (projectId ?? null) : null;
    const personal = policy.longTerm ? 1 : 0;
    const scoped = "((m.scope='user' AND ?) OR (m.scope='project' AND m.project_id=?))";
    const active = includeDisputed
      ? "json_extract(m.data,'$.status') IN ('active','disputed')"
      : "json_extract(m.data,'$.status')='active'";
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    const terms = [
      ...new Set(
        [...segmenter.segment(query.toLowerCase().slice(0, 8000))]
          .filter((part) => part.isWordLike && part.segment.length >= 2)
          .map((part) => part.segment.replace(/[^\p{L}\p{N}]/gu, ""))
          .filter(Boolean),
      ),
    ].slice(0, 24);
    const candidates = new Map<string, MemoryRecord>();
    const collect = (rows: { data?: unknown }[]) => {
      for (const row of rows) {
        const item = JSON.parse(String(row.data)) as MemoryRecord;
        candidates.set(item.id, item);
      }
    };
    if (personal || project) {
      // FTS searches the complete scope, independently of management-page pagination.
      if (terms.length) {
        const match = terms.map((term) => `"${term}"*`).join(" OR ");
        collect(
          this.db
            .prepare(
              `SELECT m.data FROM memory_fts JOIN memories m ON m.id=memory_fts.id WHERE memory_fts MATCH ? AND ${scoped} AND ${active} ORDER BY bm25(memory_fts) LIMIT 96`,
            )
            .all(match, personal, project),
        );
        // unicode61 does not split CJK phrases: use bounded word segments as a fallback.
        const cjk = terms.filter((term) =>
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(term),
        );
        if (cjk.length)
          collect(
            this.db
              .prepare(
                `SELECT m.data FROM memories m WHERE ${scoped} AND ${active} AND (${cjk.map(() => "m.content LIKE ?").join(" OR ")}) ORDER BY json_extract(m.data,'$.updatedAt') DESC LIMIT 96`,
              )
              .all(personal, project, ...cjk.map((term) => `%${term}%`)),
          );
      }
      collect(
        this.db
          .prepare(
            `SELECT m.data FROM memories m WHERE ${scoped} AND ${active} ORDER BY json_extract(m.data,'$.updatedAt') DESC LIMIT 48`,
          )
          .all(personal, project),
      );
    }
    const score = (item: MemoryRecord) =>
      terms.reduce((n, word) => n + (item.content.toLowerCase().includes(word) ? 1 : 0), 0);
    const ordered = [...candidates.values()]
      .filter((item) => item.status === "active" || (includeDisputed && item.status === "disputed"))
      .sort((a, b) => score(b) - score(a) || b.updatedAt.localeCompare(a.updatedAt));
    let length = 0;
    const records: MemoryRecord[] = [];
    for (const item of ordered) {
      const size = item.content.length + item.conditions.length + 100;
      if (length + size > 6000) continue;
      records.push(item);
      length += size;
      if (records.length === 24) break;
    }
    return {
      epoch: policy.epoch,
      revision: this.revision(),
      records,
      learning:
        policy.dailyTokenBudget > 0 &&
        ((policy.longTerm && policy.learnPersonal) || (policy.shortTerm && policy.learnProject)),
    };
  }
}
