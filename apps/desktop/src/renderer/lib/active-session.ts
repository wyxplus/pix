import { normalizePathKey, type HostSnapshot, type SessionThreadSummary } from "@pix/contracts";

type SessionIdentity = Pick<HostSnapshot, "sessionId" | "sessionFile">;

/** List responses and cached rows can outlive navigation; only the snapshot owns selection. */
export function threadMatchesSession(
  thread: Pick<SessionThreadSummary, "id" | "path">,
  session: SessionIdentity | undefined,
): boolean {
  if (!session) return false;
  if (session.sessionId && thread.id) return thread.id === session.sessionId;
  return Boolean(
    session.sessionFile && normalizePathKey(thread.path) === normalizePathKey(session.sessionFile),
  );
}

export function markActiveSession(
  threads: SessionThreadSummary[],
  session: SessionIdentity | undefined,
): SessionThreadSummary[] {
  return threads.map((thread) => {
    const active = threadMatchesSession(thread, session);
    return active === thread.active ? thread : { ...thread, active };
  });
}
