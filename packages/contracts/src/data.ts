import type { SideChatArchive } from "./index.ts";

export interface StorageProfileView {
  mode: "legacy" | "custom" | "portable" | "environment";
  root: string;
  desktop: string;
  agent: string;
  memory: string;
  archives: string;
  locator: string;
  externalAgent: boolean;
  pendingRoot?: string;
  migrationError?: string;
}
export interface ArchiveSummary {
  id: string;
  createdAt: string;
  memoryCount: number;
  sessions: { id: string; title: string }[];
  warnings: string[];
  attachmentCount?: number;
  sideChatCount?: number;
}
export interface NativeTransferPreview {
  id: string;
  target: "claude" | "codex";
  version: string;
  directory: string;
  cwd: string;
  sessions: { sourceId: string; branch: string; targetId: string }[];
  warnings: string[];
  delivered: boolean;
}
export interface DataApi {
  preferences: {
    read(): Promise<Record<string, string> | null>;
    patch(
      values: Record<string, string | null>,
      initialize?: boolean,
    ): Promise<Record<string, string>>;
  };
  storage: {
    state(): Promise<StorageProfileView>;
    choose(): Promise<StorageProfileView | undefined>;
    cancel(): Promise<StorageProfileView>;
  };
  archives: {
    exportPick(input: {
      personal: boolean;
      project: boolean;
      sessions: boolean;
      cwd?: string;
      format: "pix" | "markdown";
    }): Promise<{ path: string; warnings: string[] } | undefined>;
    importPick(): Promise<ArchiveSummary | undefined>;
    list(): Promise<ArchiveSummary[]>;
    restoreMemories(input: {
      archiveId: string;
      personal: boolean;
      project: boolean;
      cwd?: string;
    }): Promise<{ imported: number; skipped: number }>;
    continueSession(input: {
      archiveId: string;
      sessionId: string;
      cwd: string;
    }): Promise<{ sideChats: SideChatArchive }>;
    previewNative(input: {
      archiveId: string;
      target: "claude" | "codex";
      cwd: string;
    }): Promise<NativeTransferPreview | undefined>;
    deliverNative(id: string): Promise<NativeTransferPreview>;
  };
}
