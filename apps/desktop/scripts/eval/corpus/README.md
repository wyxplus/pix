# Pix independent acceptance corpus v1

The corpus is separate from unit-test totals and LongMemEval. Cases have stable IDs, frozen input events, independent expectations, and explicit execution requirements. Results report `passed`, `failed`, `blocked` or `not_tested`; missing targets, model access or OS runners never count as passed.

- 80 memory scenarios: 8 categories × 10, split by scenario into 40 development and 40 reserved acceptance cases. Real extraction/answering checks require an explicitly budgeted model. Deterministic state checks use the production memory service; they are not a semantic score.
- 40 export/storage scenarios: scoped data, complete session trees, attachments, consistency, storage profiles, migration and platform behavior.
- 40 native portability scenarios: Pix round trips, Claude/Codex target reading and continuation, scope/forgetting, branches/media, rejection paths and idempotent delivery.

All content is synthetic. Expectations are loaded only by the scorer and never supplied to extraction, consolidation or answering calls. Results record input hashes, implementation revision, client/OS versions and evidence paths. A reserved split prevents tuning on its answers within the evaluation workflow; it is not a claim that this repository's authors cannot read those files.
