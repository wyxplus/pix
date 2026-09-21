import { open, link, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
const { values } = parseArgs({ options: { out: { type: "string" } } });
if (!values.out) throw new Error("Required: --out NEW_DATASET_FILE");
const expected = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442";
const source =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";
const path = resolve(values.out),
  staging = `${path}.${randomUUID()}.tmp`;
const file = await open(staging, "wx", 0o600);
try {
  const response = await fetch(source, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`dataset_download_${response.status}`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 300_000_000) throw new Error("dataset_too_large");
    hash.update(chunk);
    await file.writeFile(chunk);
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== expected)
    throw new Error(
      "dataset_revision_changed: review the new dataset before changing the pinned digest",
    );
  await file.sync();
  await file.close();
  // link fails if an output exists: never replace a user's dataset.
  await link(staging, path);
  console.log(JSON.stringify({ path, source, bytes, sha256, modelCalls: 0 }, null, 2));
} finally {
  await file.close();
  await unlink(staging).catch(() => {});
}
