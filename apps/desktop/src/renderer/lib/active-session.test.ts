import type { HostSnapshot, SessionThreadSummary } from "@pix/contracts";
import { describe, expect, it } from "vite-plus/test";
import { markActiveSession, threadMatchesSession } from "./active-session.ts";
import { useShellStore } from "../store/shell-store.ts";

const current = { sessionId: "new", sessionFile: "/var/sessions/new.jsonl" };
const rows: SessionThreadSummary[] = [
  {
    id: "old",
    path: "/var/sessions/old.jsonl",
    cwd: "/project",
    title: "Old",
    modifiedAt: "2026-09-13",
    messageCount: 2,
    active: true,
  },
  {
    id: "new",
    path: current.sessionFile,
    cwd: "/project",
    title: "New",
    modifiedAt: "2026-09-14",
    messageCount: 1,
    active: false,
  },
];

describe("active session identity", () => {
  it("ignores stale list flags without changing messages, titles or ordering", () => {
    expect(markActiveSession(rows, current)).toEqual([
      { ...rows[0], active: false },
      { ...rows[1], active: true },
    ]);
    expect(markActiveSession(rows, undefined).every((row) => !row.active)).toBe(true);
  });

  it("prefers the session ID and normalizes path aliases when IDs are unavailable", () => {
    expect(threadMatchesSession({ id: "old", path: current.sessionFile }, current)).toBe(false);
    expect(threadMatchesSession({ id: "", path: "/private/var/sessions/new.jsonl" }, current)).toBe(
      true,
    );
  });

  it("keeps the current selection when an old list finishes after navigation or model recovery", () => {
    const initial = useShellStore.getState();
    try {
      const snapshot: HostSnapshot = {
        ...current,
        runtimeId: "runtime",
        sequence: 0,
        cwd: "/project",
        agentDir: "/agent",
        queuedMessages: { steering: [], followUp: [] },
        slashCommands: [],
        activeTools: [],
        projectTrusted: true,
        resources: { extensions: 0, skills: 0, prompts: 0, themes: 0, contextFiles: 0 },
        configuredPackages: { global: 0, project: 0 },
        diagnostics: [],
      };
      useShellStore.setState({ snapshot, threads: rows });
      useShellStore.getState().setThreads(rows);
      expect(
        useShellStore
          .getState()
          .threads.filter((row) => row.active)
          .map((row) => row.id),
      ).toEqual(["new"]);
      useShellStore
        .getState()
        .acceptSnapshot({ ...snapshot, sessionId: "old", sessionFile: rows[0]!.path });
      expect(
        useShellStore
          .getState()
          .threads.filter((row) => row.active)
          .map((row) => row.id),
      ).toEqual(["old"]);
      useShellStore.getState().applySessionOpen({ snapshot, threads: rows, history: [] });
      expect(
        useShellStore
          .getState()
          .threads.filter((row) => row.active)
          .map((row) => row.id),
      ).toEqual(["new"]);
    } finally {
      useShellStore.setState(initial, true);
    }
  });
});
