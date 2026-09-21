export interface ArchiveSession {
  id: string;
  title: string;
  jsonl: string;
}

export function validateSession(session: ArchiveSession): void {
  if (!session || typeof session.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.id))
    throw new Error("invalid_archive_id");
  if (
    typeof session.title !== "string" ||
    session.title.length > 2000 ||
    typeof session.jsonl !== "string"
  )
    throw new Error("invalid_archive_session");
  const rows = session.jsonl
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = rows[0];
  if (
    !header ||
    header.type !== "session" ||
    header.version !== 3 ||
    header.id !== session.id ||
    typeof header.cwd !== "string"
  )
    throw new Error("unsupported_session_version");
  const ids = new Set<string>();
  for (const row of rows.slice(1)) {
    if (typeof row.type !== "string" || typeof row.id !== "string" || ids.has(row.id))
      throw new Error("invalid_session_tree");
    if (row.parentId != null && (typeof row.parentId !== "string" || !ids.has(row.parentId)))
      throw new Error("invalid_session_parent");
    ids.add(row.id);
  }
}
