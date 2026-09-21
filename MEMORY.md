# Memory and data portability

Pix provides two independently controlled memory scopes in **Settings → Memory**: personal long-term memory across projects and project short-term memory across sessions. Both default to off. “Short-term” describes the project boundary; it does not mean that records disappear when a session closes. Turning a scope off stops reading and learning from it without deleting it; forgetting and clearing remain available.

## Architecture and learning

```text
React settings / conversations
       │ typed IPC
Tauri → Node Sidecar ── Memory service → SQLite Worker
       │                 │ policy + revision + project identity
       └─ Agent Host ────┘
           │ per-provider-request retrieval
           └─ pi SDK / model
```

The Worker is the single database owner. SQLite stores records, project identities, revisions, evidence references, forgetting guards and learning jobs. Git worktrees share a common Git-directory identity; independent clones remain separate. Project identity currently depends on its canonical path/common Git-directory path: moving or renaming a project folder does not automatically retain its memory association. Three independent acceptance cases expose this limitation. Retrieval combines FTS and CJK word matching with bounded recent records. Answer context contains at most 24 active records within a 6,000-character retrieval budget; record content is limited to 4,000 characters and conditions to 1,000. Management-page pagination does not limit indexed search.

Memory is injected into each provider request, including tool continuations. It is not appended to the durable conversation transcript or the compaction request. A policy change aborts active hosts and invalidates pending learning jobs. Imported/quoted memory is reference data, not permission to run tools or change settings.

Optional automatic learning uses two separate model calls:

1. **Extraction:** newly observed user messages only, with exact quoted evidence, scope restrictions, no tools and no conversation-history access. Invalid evidence and oversized inputs are rejected.
2. **Consolidation:** candidates are compared with a bounded set of active and disputed records. Equivalent facts merge provenance. Conflicts are withheld for review; existing explicitly entered facts retain priority. The entire result commits against a frozen database revision, so a concurrent correction or deletion wins.

Settings offers revision-checked editing and conflict resolution. Accepting a conflicting fact supersedes its related facts; discarding it preserves the earlier fact where no other dispute remains. Unresolved facts remain available to consolidation but are excluded from answering context. Semantic decisions still depend on the model and retrieved neighbors; this implementation does not guarantee detection of every paraphrase or contradiction, including contradictions within one extraction batch.

Automatic learning defaults to **zero daily budget**. Enabling memory alone makes no extra model calls. The daily allowance counts conservative token reservations for both stages, not actual billing. State exposes reserved tokens and pending/completed/failed jobs. Interrupted jobs are marked failed rather than automatically billed again. Forgetting stores normalized-fact hashes and source guards so reprocessing old evidence cannot silently recreate the same memory.

## Export, import and continuation

The native `.pixarchive` is a checksummed, compressed package with selected memory scopes, forgetting guards, provenance, complete pi JSONL session trees and associated side conversations. Export includes archived/hidden sessions under registered project roots and worktrees. One source project maps explicitly to the currently selected destination project. Importing multiple source projects in one package is rejected until a mapping UI exists.

Import validates the entire archive before staging it in a content-addressed local store. Import does not enable memory, learn from history or execute model turns. Adopting memory is a separate action and honors the current scope switches and local forgetting guards. Exported guards are applied before copied records. Existing local facts are not overwritten. Legacy packages remain readable; guards missing from old packages cannot be reconstructed from absent evidence.

**Attachments:** files explicitly referenced by attachment metadata are packed when readable and authorized. Each file is limited to 12 MB and the total attachment payload to 48 MB; repeated bytes are deduplicated. Missing, unauthorized, changed or oversized files produce explicit archive warnings. Arbitrary paths in prose/tool output are not read. Packed files are verified and remapped to local paths on restoration; unpacking cannot use source filenames to escape the destination. Native archives also preserve embedded image data. The complete compressed/uncompressed archive is bounded to 128 MiB.

**Side conversations:** restoring a Pix session also restores its selections, source context, messages, drafts, attachments and active selection. New stable IDs bind these to the restored session. Previously streaming conversations become stopped, stale request IDs are removed, and access mode resets to default. Repeating restoration preserves newer edits.

**Continuation:** the first continuation clones the archived session through Pix's session import path. Later clicks reopen that same restored copy instead of making duplicates. A journal records pending/completed work; an ambiguous crash stops a retry and asks the user to inspect recent sessions rather than blindly cloning again. Original archive bytes remain unchanged.

Markdown export provides readable reference material for other tools. It omits thinking blocks and structured tool calls; it is not a lossless import format. Original transcripts may contain information that was subsequently forgotten from the memory database. Forgetting a memory is not transcript redaction.

## Storage and portable mode

Existing installations keep their previous layout until a new location is selected. `PIX_DATA_DIR` retains its desktop-data meaning. `PIX_STORAGE_DIR=/absolute/path` opts into a unified root; explicit `PI_CODING_AGENT_DIR` and session-directory overrides keep their precedence.

```text
<data root>/
  desktop/             # settings, UI preferences, side chats, managed attachments/runtimes
  agent/               # pi settings/auth/resources/sessions, unless explicitly overridden
  memory/memory.sqlite
  archives/            # staged archives, restored assets/sessions and continuation journals
  tmp/
```

Settings schedules a new location for the next launch. Startup takes an exclusive Pix directory lock, copies and verifies files before opening agents/databases, rewrites copied references to Pix-managed attachments/session files, then atomically activates the new location. The old source remains intact. Failed migrations keep the previous profile and expose an error. An unavailable configured root causes a startup error instead of silently selecting another profile. Symlinks require manual handling. Other programs sharing a legacy pi directory are outside Pix's lock and should be closed during migration.

Reference rewriting is restricted to copied Pix data. Explicitly overridden external agent/session directories and arbitrary external file paths remain external; their original files must stay available. Browser preferences migrate once to `desktop/preferences.json`. Tauri window geometry and OS WebView caches may still use platform locations. Normal mode uses a small location file in the OS app-config directory to find a custom root.

For portable mode, place `pix-portable.json` beside the executable, or beside `Pix.app` on macOS. Pix creates sibling `PixData`; it does not write inside a signed app bundle. The marker selects a layout rather than automatically importing an older installation. Portable operation requires write access to that parent directory.

## Pix → Claude Code / Codex

| Destination                                | Support in this implementation                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Pix → Pix                                  | Native package, memory adoption, attachments/side chats and repeatable continuation |
| Pix → other agents                         | Markdown context reference                                                          |
| Pix → Claude Code CLI **2.1.87**           | Experimental native history conversion; version checked at preview and delivery     |
| Pix → Codex CLI **0.155.0-alpha.9.2**      | Experimental native history conversion; version checked at preview and delivery     |
| Other client versions, desktop and IDE UIs | Not verified; use Markdown until their conformance checks pass                      |

After importing an archive, open a destination project in Pix and select **Preview transfer** in Settings → Memory. Choose the target CLI executable and its data location. Claude requires an existing native project-session folder that already contains matching workspace metadata; Pix does not guess Claude's opaque folder encoding. Codex uses the selected `CODEX_HOME` directory. The preview shows destination, version, session count and conversion limitations before **Confirm delivery** writes files.

Each branch and side conversation becomes a separate target session. Shared prefixes are duplicated; source identity and timestamps remain reference text. Tools are inert historical references, not executable calls. Hidden reasoning, target credentials/configuration and source access permissions are excluded. Unsent side-chat drafts are labeled as reference material. Packed attachments are delivered under the target directory and survive removal of Pix data; embedded image blocks remain in the Pix archive. Active memories are reference context, not entries in the target's automatic memory store.

A private journal allocates IDs before delivery. Files are published exclusively and verified after writing. A retry reuses IDs and never overwrites a conversation continued in the target. Delivery itself makes no model calls. Future turns use the target client's permissions and billing. This is version-pinned compatibility with private formats, not a claim of an official portable-session API.

Installed CLI conformance was checked with isolated profiles and a localhost fake model: native history visibility, cold resume, subsequent-turn context, and actual CLI picker/transcript preview. Per-run evidence, including these conformance records, is written to the gitignored `apps/desktop/scripts/eval/fixtures/` and stays on the machine that produced it; only the probes and their commands are tracked. The older Codex `thread/inject_items` probe is retained as a negative control: persistence alone did not make imported history visible. Native conversion has separate positive checks.

```sh
node apps/desktop/scripts/probe-claude-transfer.mjs /absolute/path/to/claude
node apps/desktop/scripts/probe-codex-continuation.mjs /absolute/path/to/codex
```

These developer probes use temporary profiles and local model responses; they do not call paid providers. Native picker inspection is a separate manual check and must not be inferred from protocol success.

## Observable evaluation

```sh
pnpm test:memory
pnpm check
pnpm check:rust
```

`test:memory` builds production bundles, checks storage/archive/consolidation/native conversion invariants, uses the real SDK and production Worker/Sidecar with a localhost fake model, and exercises settings persistence and the transfer preview in a browser. Coverage includes all sixteen policy transitions, scope isolation, correction races, forgotten-source suppression, conflict quarantine/resolution, portable attachment bytes, side-chat restoration, repeated continuation, migration references, target-version changes and protection of continued target sessions. Fake responses verify engineering behavior; they do not measure model quality.

The fixed local performance profile seeds 10,000 records (50% Chinese, 50% English; personal/current/other-project scopes), then measures the production Worker, retrieval and request-context assembly:

```sh
pnpm eval:memory:retrieval --out /absolute/new-retrieval-report.json
```

On Apple M4 / Node 24.14.0, warm p95 was **12.64 ms** over 200 queries; four concurrent requests had p95 **47.41 ms**, and a new Worker plus its first query had p95 **63.75 ms** over 20 starts. OS filesystem caches were not flushed. These are local synthetic measurements, exclude remote model latency, and are not a cross-platform guarantee. The report records the machine, fixture profile, scope checks and sample counts; the warm p95 meets the proposed 200 ms engineering target.

### LongMemEval-S

The runner follows the [official LongMemEval data/output format](https://github.com/xiaowu0162/LongMemEval#-testing-your-system). Download and validate the pinned public revision without model calls:

```sh
pnpm eval:memory:fetch --out /absolute/longmemeval_s_cleaned.json
pnpm eval:memory --dataset /absolute/longmemeval_s_cleaned.json --out /absolute/new-validation-dir
```

The verified public file contains 500 cases, is 277,383,467 bytes, and has SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`. The fetch command rejects a changed revision instead of silently replacing it. All 500 cases passed structural dry-run validation with zero model calls; this is **not a benchmark score**.

A real run requires `--run`, `--agent-dir`, `--provider`, `--model`, and either explicit `--budget-usd` / `--input-per-million` / `--output-per-million`, or the explicitly authorized `--unlimited-budget` flag. Unknown prices remain `null` in unlimited mode; observed tokens are still journaled. `--concurrency` accepts 1–32 independent cases. `--limit` supports a pilot. Use current prices for the selected provider. The runner reserves conservative cost before each call and stops at the allowance. An append-only spending journal retains failed or uncertain reservations across restarts. `--resume` reuses completed case/mode pairs and rejects changed data, model, prices, allowance, production source or evaluation protocol. An interrupted memory pair is rebuilt within the remaining allowance; its earlier uncertain calls remain reserved. A stale `run.lock` requires checking that its PID has exited before removing it. The current runner retries transient service errors at most twice, journals every attempt, and stops new requests on provider cooldown/quota exhaustion or persistent service failure. It loads pi model configuration without agent extensions or tools. The four baselines are no history, latest two sessions, full history and Pix memory. The current protocol stably orders sessions by timestamp before learning or choosing the latest two; the stopped first run preserved file order and is archived as a different protocol. Each memory case uses an isolated database plus the production extraction and consolidation prompts. Golden answers and `has_answer` annotations never enter model inputs. Dataset session timestamps are prefixed to source messages; this methodology difference from desktop turns is recorded. Assistant-only evidence remains a known limitation of user-only extraction.

Each baseline writes official `{question_id, hypothesis}` JSONL. `report.json` records dataset/prompt/prediction hashes, model, supplied prices, reserved cost, observed tokens, latency, retrieval evidence recall, extraction failures and skipped sources. Run the [official judge](https://github.com/xiaowu0162/LongMemEval/blob/main/src/evaluation/evaluate_qa.py) separately; its model costs are additional to the runner allowance. Then aggregate its result files offline:

```sh
pnpm eval:memory:report --dataset /absolute/longmemeval_s_cleaned.json \
  --run /absolute/model-run-dir --out /absolute/new-score-report.json
```

The report validates IDs and exact hypothesis correspondence before calculating micro/macro accuracy, category and abstention results, evidence recall and p50/p95 latency. Partial coverage is labeled separately. Complete results include 95% Wilson intervals and paired accuracy differences. `--judge-report` binds judge configuration and source/protocol hashes to the answer run; `--judge-suffix` selects alternative-model result files. `full500AlternativeScored` indicates complete alternative-judge coverage without claiming official scoring. `full500Scored` requires the pinned public dataset, all four complete baselines and the official `gpt-4o-2024-08-06` judge configuration. No lexical or fake-model result is presented as an official score.

### Resumable real-model judging

`eval:memory:judge` loads only the `get_anscheck_prompt` function from a SHA-256-pinned official `evaluate_qa.py`, without executing upstream imports or its API runner. It validates prediction IDs and exact hypothesis correspondence, atomically writes official-format label files, and uses a separate durable model-call journal. `--resume` scores newly available or previously failed predictions without re-billing completed labels. A changed prediction, source, answer protocol, prompt function or judge configuration is rejected.

```sh
pnpm eval:memory:judge --dataset /absolute/longmemeval_s_cleaned.json \
  --run /absolute/answer-run --out /absolute/new-judge-run \
  --agent-dir /absolute/isolated-agent --provider PROVIDER --model JUDGE \
  --official-script /absolute/evaluate_qa.py \
  --official-script-sha256 ecce9c4c79dc89d99534ac17b383a5cbb5b9f0c69ee98adaf0684742e3d95251 \
  --unlimited-budget --concurrency 4 --max-tokens 128
```

Use unlimited mode only when authorized. The example's 128-token cap is an alternative configuration; the official setting is `gpt-4o-2024-08-06` with 10 tokens. After creating the initial judge run, `eval:memory:judge-live` accepts the same arguments and follows new answers until the answer run finishes. It retries failed labels and stops after three attempts without progress or immediately when the provider is unavailable. This is a process attached to the current evaluation, not a recurring scheduled job.

## Validation and release gates (2026-09-20)

The implementation has been exercised on macOS arm64 / Node 24.14.0. Desktop unit tests: **562 passed, 1 skipped**; runtime tests: **150 passed, 2 skipped**. The final `test:memory` pipeline passed 65 storage/archive/consolidation/transfer tests, the runtime hook test, production fake-model smoke, the four-baseline fixture, the offline judge-report test, and two browser tests. The earlier 12-test browser regression across memory, scaling and window chrome also passed. Build/type/lint checks, launcher regressions and earlier Rust checks passed. Reproducible commands are above; each local report records the specific target versions and zero paid calls, and none of them is committed.

Still required before claiming broad release acceptance:

- Complete the running public 500-case real-model evaluation and QA judging. The user authorized unlimited total budget. The original CPA / `gpt-5.6-sol` run stopped on provider cooldown after 247 valid answers and 243 judgments. At the user’s request to keep using CPA, a separate `gpt-6-astra` answer run and `gpt-5.6-terra` alternative judge run are now active. The official `gpt-4o-2024-08-06` judge is unavailable. Different-model results are not merged. No complete public accuracy result is claimed yet.
- Resolve the independent 80 + 40 + 40 corpus results: 152 passed, 5 failed, 3 blocked. The 80 memory cases ran against the real model (75 passed); three failures are project-folder identity defects and two require assertion/requirements review. Raw failures remain unchanged. Three installed-platform scenarios still await matching hosts. Native CLI picker evidence is observed separately, never inferred from protocol success.
- Installed migration/recovery validation on macOS Intel, Windows x64 and Linux x64; release signing/notarization. The local macOS ARM64 DMG passed all four installed-resource smoke checks with ad-hoc signing. A separate actual macOS native UI smoke has now verified four memory switch combinations, manual memory persistence across process restart, disabled writes, and forgetting while disabled. This does not cover other native platforms.
- Separate conformance for other Claude/Codex versions, desktop clients and IDE integrations.

## Independent acceptance and installer evidence

The authored corpus has stable IDs, separate expectations and an explicit 40/40 development/reserved split for the 80 memory cases. It is not a third-party benchmark or a blind external audit. Engineering cases run real archive/storage operations; native cases use installed Claude/Codex CLIs and localhost synthetic models. Missing model access or OS hosts are reported as blocked. Counts are independent scenarios, not a sum of unit tests.

```sh
pnpm eval:memory:preflight --dataset /absolute/longmemeval_s_cleaned.json --out /absolute/new-workload.json
pnpm eval:memory:acceptance --out /absolute/new-acceptance-directory \
  --claude-bin /absolute/claude --codex-bin /absolute/codex \
  --platform-evidence /absolute/platform-map.json \
  --native-ui-evidence /absolute/path/to/native-picker-acceptance.json
```

The acceptance command runs through `pnpm --filter @pix/desktop`; paths are interpreted from `apps/desktop`, so use absolute paths for external evidence. Its `--run-model` switch requires the same explicit model, provider, agent directory and spending policy as LongMemEval, including the explicit `--unlimited-budget` option. Normal runs make no paid calls. Platform evidence is a JSON object keyed by target triple. `--resume` refuses a changed corpus, selection, protocol or production fingerprint.

`.github/workflows/memory-acceptance.yml` builds actual DMG/NSIS/DEB assets on four native GitHub runners, copies/installs/extracts into Unicode paths, and exercises packaged memory, profile migration, Sidecar and bundled runtimes with isolated profiles. Windows also has a native WebView memory/settings check. The workflow uploads evidence artifacts and does not publish a release. It has not been dispatched for this uncommitted source snapshot.

Installed profile migration now relocates links only within the managed runtime tree, repairs Python venv and npm launcher paths, and preserves installed modules. External links still stop migration with the old source retained. The installed smoke test executes relocated Python and pip, imports a seeded module, checks remembered/forgotten records and copied sessions, and verifies that new writes leave the old database unchanged.

Detailed current evidence and required decisions: [MEMORY-VALIDATION.md](MEMORY-VALIDATION.md).
