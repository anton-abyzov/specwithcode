# Project context delivery verification

T06, 2026-10-09. Node 22.20.0. No live provider requests or browser sessions.

## Runtime behavior

`ProviderTurnStartService` wraps the actual native dispatch after composing historical handoffs. `runtimeLayer.ts` supplies the durable delivery service. SQLite migration 060 stores a bounded pending snapshot before dispatch and accepts it only at a native acceptance boundary. Receipt identity includes project, app thread, provider driver/account and native continuation. Model/effort changes and runtime process restarts do not erase a retained continuation's receipt. Unknown native identities are conservative and cannot reuse receipts across runs.

Accepted unchanged sections add zero project-context characters to subsequent prompts. Changed sections supersede old values explicitly. Deletion produces removal text; the inventory digest includes revisions beyond the visible bounded list. Completed native compactions create a new delivery epoch; failed or unrelated compactions do not. Current snapshots are limited to 32,768 UTF-16 characters, with surrogate-safe truncation and instructions prioritized before memory. `MEMORY.md` keeps a 2,048-character floor so maximum goal, instructions and environment cannot hide it entirely, and it is wrapped in a `<project_memory>` fence that agent-written text cannot close. The memory inventory lists whole names and counts the files that did not fit.

Claude acknowledges only a matching native prompt UUID, not a running event or SDK queue acceptance. Codex acknowledges after a successful `turn/start` response. Native wake/continuation and `/compact` do not acknowledge a new user prompt. `/goal` retains exact command syntax: Codex uses native `additionalContext`; Claude uses supported SessionStart/UserPromptSubmit hook context and requires hook delivery before acknowledgement. Goal control paths that emit neither hook nor matching prompt echo remain pending. The next real prompt restores context conservatively.

Claude SessionStart(compact) and Codex compaction notifications read fresh project memory. Codex restoration injects project context as a user-role item; only Studio's own additional context keeps developer role, so agent-written memory never gains developer authority. Ordinary Claude startup does not inject a second copy of the prepared snapshot. Duplicate Codex compaction notifications are coalesced; failed restoration can retry. Hook restoration is not a durable acceptance receipt, so the next real prompt may restore the snapshot once more after compaction.

If a crash occurs between native acceptance and receipt persistence, the next real prompt carries current bounded context. Receipt recovery never executes an old user request. A late acknowledgement cannot overwrite a newer pending snapshot or recreate a deleted project's receipts. Permanent project deletion purges context receipts without touching another project's data. This is conservative recovery, not an exactly-once guarantee or a promise of shared provider KV caches.

## Verification receipt

Passed 344 tests across these seven files:

- `project/ProjectContextDelivery.test.ts`: durable service reconstruction, unchanged delivery, revision deltas, removals/recreation, ambiguous acceptance, provider/account/native separation, retained native identity, compaction epochs, fresh restoration and deletion isolation.
- `project/ProjectContextRuntime.test.ts`: actual dispatch boundary, no early acknowledgement, no native-wake prompt, first goal preservation, failed dispatch, receipt failure without user replay, model-independent native identity and Claude hooks.
- `project/ProjectContextAdapters.test.ts`: actual Claude adapter SDK queue/UUID protocol; actual Codex adapter success/rejection, native goal context and duplicate compaction replay.
- `project/ProjectWorkspaceService.test.ts`.
- `orchestration-v2/ProviderTurnStartService.test.ts`.
- `orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`.
- `orchestration-v2/Adapters/CodexAdapterV2.test.ts`.

Full server `tsc --noEmit -p apps/server/tsconfig.json` passed. Changed-file lint passed with three pre-existing unused-variable warnings in the large native adapters. `git diff --check` passed. New implementation/test files remain below the 1,500-line cap.

The full adapter run exposed two older replay fixtures that created threads without projects. The failure was reproduced in the integration checkout before this change. Fixture setup now creates projects through the normal persisted EventSink path; all original assertions remain.

These are local SQLite and native protocol replay proofs. They do not establish a paid live-provider cache-hit rate, production release, or external service availability.
