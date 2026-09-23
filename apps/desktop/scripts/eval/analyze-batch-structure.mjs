// Structural analysis: entryId uniqueness within learning batches.
// No model calls — purely deterministic dataset structure.
import { readFile } from "node:fs/promises";
const dataset = JSON.parse(
  await readFile("E:/code/ai/pix/artifacts/longmemeval_s_cleaned.json", "utf8"),
);

let totalBatches = 0,
  singleSessionBatches = 0,
  uniqueEntryIdBatches = 0,
  batchesWithCollision = 0;
for (const item of dataset) {
  const history = item.haystack_sessions
    .map((messages, i) => ({
      id: item.haystack_session_ids[i],
      messages: messages.map(({ role, content }) => ({ role, content })),
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const sources = history.flatMap((session) =>
    session.messages.flatMap((message, index) => {
      if (message.role !== "user") return [];
      const text = `[Session date: x]\n${message.content}`;
      if (typeof message.content !== "string" || text.length > 4000) return [];
      return [{ sessionId: session.id, entryId: `entry-${index}` }];
    }),
  );
  for (let offset = 0; offset < sources.length; offset += 20) {
    const batch = sources.slice(offset, offset + 20);
    totalBatches++;
    const sessions = new Set(batch.map((s) => s.sessionId));
    const ids = new Set(batch.map((s) => s.entryId));
    if (sessions.size === 1) singleSessionBatches++;
    if (ids.size === batch.length) uniqueEntryIdBatches++;
    else batchesWithCollision++;
  }
}
console.log(
  JSON.stringify(
    { totalBatches, singleSessionBatches, uniqueEntryIdBatches, batchesWithCollision },
    null,
    1,
  ),
);
