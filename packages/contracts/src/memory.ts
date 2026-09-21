export type MemoryScope = "user" | "project";
export type MemoryKind = "preference" | "decision" | "procedure" | "fact" | "state";
export type MemoryStatus = "active" | "disputed" | "superseded" | "archived";

export interface MemoryPreferences {
  longTerm: boolean;
  shortTerm: boolean;
  learnPersonal: boolean;
  learnProject: boolean;
  dailyTokenBudget: number;
  revision: number;
  epoch: number;
}

export interface MemorySource {
  sessionId: string;
  entryId: string;
}
export interface MemorySuppression {
  scope: MemoryScope;
  projectId: string | null;
  factKey: string;
  sources: MemorySource[];
}

export interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  kind: MemoryKind;
  content: string;
  factKey: string;
  status: MemoryStatus;
  origin: "explicit" | "inferred" | "imported";
  conditions: string;
  sources: MemorySource[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  conflicts?: string[];
}

export interface MemoryInput {
  scope: MemoryScope;
  projectId?: string;
  kind: MemoryKind;
  content: string;
  conditions?: string;
}

export interface MemoryProject {
  id: string;
  root: string;
  name: string;
}

export interface MemoryContext {
  epoch: number;
  revision: number;
  records: MemoryRecord[];
  learning: boolean;
}

export interface MemoryState {
  preferences: MemoryPreferences;
  projects: MemoryProject[];
  counts: { user: number; project: number };
  learning: { reservedTokens: number; completed: number; failed: number; pending: number };
}

export interface MemoryApi {
  state(): Promise<MemoryState>;
  preferences(
    patch: Partial<Omit<MemoryPreferences, "revision" | "epoch">>,
    expectedRevision: number,
  ): Promise<MemoryPreferences>;
  project(cwd: string): Promise<MemoryProject>;
  list(input: { scope: MemoryScope; projectId?: string; query?: string }): Promise<MemoryRecord[]>;
  create(input: MemoryInput): Promise<MemoryRecord>;
  update(input: {
    id: string;
    expectedRevision: number;
    content: string;
    conditions?: string;
  }): Promise<MemoryRecord>;
  forget(ids: string[]): Promise<void>;
  resolve(input: {
    id: string;
    expectedRevision: number;
    choice: "keep" | "discard";
  }): Promise<MemoryRecord>;
  clear(input: { scope: MemoryScope; projectId?: string }): Promise<void>;
}

export function assertMemoryScope(value: unknown): asserts value is MemoryScope {
  if (value !== "user" && value !== "project") throw new Error("invalid_memory_scope");
}

export function assertMemoryText(value: unknown, limit = 4000): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error("invalid_memory_text");
  }
}

export function assertMemoryInput(value: unknown): asserts value is MemoryInput {
  if (!value || typeof value !== "object") throw new Error("invalid_memory_input");
  const item = value as Record<string, unknown>;
  assertMemoryScope(item.scope);
  assertMemoryText(item.content);
  if (!["preference", "decision", "procedure", "fact", "state"].includes(String(item.kind))) {
    throw new Error("invalid_memory_kind");
  }
  if (item.scope === "project") assertMemoryText(item.projectId, 128);
  if (item.scope === "user" && item.projectId != null) throw new Error("out_of_scope");
  if (
    item.conditions !== undefined &&
    (typeof item.conditions !== "string" || item.conditions.length > 1000)
  ) {
    throw new Error("invalid_memory_conditions");
  }
}

export interface MemoryLearningSource extends MemorySource {
  text: string;
}
export interface MemoryLearningJob {
  id: string;
  epoch: number;
  projectId: string | null;
  sources: MemoryLearningSource[];
  scopes: MemoryScope[];
}
export interface MemoryCandidate {
  scope: MemoryScope;
  kind: MemoryKind;
  content: string;
  quote: string;
  entryId: string;
}

export interface MemoryConsolidationPlan {
  candidates: MemoryCandidate[];
  existing: MemoryRecord[];
}
export interface MemoryConsolidationDecision {
  candidateIndex: number;
  action: "add" | "duplicate" | "conflict";
  relatedIds: string[];
}
