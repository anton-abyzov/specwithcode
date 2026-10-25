# Activity diffs and compact output

A thread's activity shows what each tool did without making the reader open a panel to find out. Edit rows name the file and its +/- counts, Open diff goes to the exact turn and file in the existing DiffPanel, failures stay counted inside every fold, and long output is paged instead of cut. There is one diff viewer, the DiffPanel; inline patches use the same Pierre renderer.

## What a person sees

- **Edit rows** show the workspace-relative path (absolute only outside the workspace), "+N more" for extra files and +/- counts. Counts come from the provider when it sends them, otherwise from the full patch on the server; an unknown count is left out, never shown as 0.
- **Open diff** from an edit row, the inspector, the changed-files card or one of its rows opens the DiffPanel at that run, scrolls to the file and expands it. A path matched only by its file name says "Matched by file name". Inherited rows open their source thread; a provider-native subagent's edits open the parent's turn with "Edited by subagent <title> in turn N"; an app-owned delegate opens its own thread.
- **States without a diff** each have their own text instead of another turn's diff: "Diff available when the turn ends" (running, the action is disabled), a failed, missing or out-of-date snapshot, a folder that is not a Git repository, an unknown run, a snapshot taken on another machine, and a failed turn, which has no snapshot. A requested file missing from the patch is named with its reason.
- **The DiffPanel header** shows the turn number, repository, checkpoint folder, branch@HEAD and the capturing machine when the checkpoint records them.
- **The changed-files card** lists files that changed in the folder during the turn but that no successful edit item names, under "Changed in this folder during the turn, not reported by an edit tool". Files edited by a loaded subagent are listed under "Edited by subagent <title>". Card links name the file by its absolute path under the stamped repository root.
- **Failure counts** on every group header and "Worked for" fold: "N failed" at full strength (status, nonzero exit code, provider error), and faint "N possible failures" (text heuristic only) and "N declined". Interrupted commands say "stopped" and count nowhere.
- **Inline patches** render on expand with a "From <provider>" caption. Labels say when the patch is not the provider's exact edit: "Edit snippet" (built from the tool input), "Git diff of the file; may include changes this edit did not make", "Line numbers not reported by the provider", "Provider diff too large to compute", "No diff from the provider for this overwrite". Above 5,000 lines or 1 MiB a patch shows "Too large to show here" with Open diff and Copy full.
- **Long text** is paged at 256 KiB. Command output opens on its last page with Load earlier; inputs (a long command too), edit bodies and tool output open on the first page with Load more. A failed edit shows its error, not its proposed patch. Copy full joins every page at one revision and never includes the transport marker. The display strips ANSI sequences and indents structured input; Raw shows the sequences; Copy, including a row's Copy command or Copy path, keeps the exact stored bytes.
- **Live output** of a running command refetches every 2 seconds for providers that stream tool output (ACP, Cursor, OpenCode, Pi). Claude, Codex and OpenCode2 rows say "Output appears when the command ends".
- **Concise, Normal and Verbose** change only density and default expansion. Open diff, failure counts, attribution and provenance stay in every level.

## Durable constraints

- New wire fields are optional, and new reasons are strings rather than closed literal lists, so older clients keep decoding: `declined` is a flag on a `cancelled` item, `diffNote` is a string whose known values are `FILE_CHANGE_DIFF_NOTES`.
- The timeline stream never carries edit bodies. `changes[].diffStr` stays on the wire, bounded to 32 KiB per change, because the approval preview reads it. Everything else comes from `getTurnItem`, which pages one field with `field`, `offset` or `before`, `anchor` and `limit`, and, without a field, returns a bounded item plus `truncated[]` naming every cut field.
- Pages are UTF-16 offsets within a 256 KiB UTF-8 budget and never split a surrogate pair (`sliceTextPage` in `packages/shared/src/toolOutput.ts`).
- The turn diff is filtered to the checkpoint's persisted `files`, so the DiffPanel file list equals the card's. A patch cut by the server size cap reports `truncated`.
- Capture stamps `cwd`, `repoRoot`, `branch`, `headOid`, `capturedOnEnvironmentId` and `notGitRepository` on the checkpoint. Checkpoint patch paths are repository-relative, so links are relativized against `repoRoot`, falling back to the workspace root for old checkpoints.
- Edit paths are attributed against the checkpoint's stamped `cwd`, so a thread that moved folders still matches its earlier edits.
- Known limits: a failed turn has no snapshot, so its changes appear in no turn diff; a cut `oldStr`/`newStr` cannot be paged; files beyond the diff size cap have no per-file diff; SpecWithCode still keeps only the last 8,000 characters of ACP and Antigravity output, and says so on the row. The live parent card does not load provider-native subagent threads, so their files stay under "not reported by an edit tool" with a note naming the subagents. Page reads bound a command's input to 32 KiB, and the inspector shows it from the timeline item, which carries it whole. A read tool's path is copied trimmed, as the shared path extractor returns it.

## Where it lives

| Part                                 | File                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract fields and paging schema    | `packages/contracts/src/orchestrationV2.ts`, `packages/contracts/src/checkpointDiff.ts`                                                                                      |
| Text pages, patch converter, counter | `packages/shared/src/toolOutput.ts`, `packages/shared/src/structuredPatch.ts`                                                                                                |
| Codex exploration actions            | `packages/shared/src/toolActivity.ts`, `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`                                                                         |
| Wire and detail projection           | `apps/server/src/orchestration-v2/WireProjection.ts`, `apps/server/src/orchestration-v2/ThreadManagementService.ts`                                                          |
| Provider patches                     | `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`, `codexFileChanges.ts`, `AcpAdapterV2.ts`; ingestion cut in `apps/server/src/provider/acp/AcpRuntimeModel.ts` |
| Turn diff and capture stamp          | `apps/server/src/checkpointing/CheckpointDiffQuery.ts`, `apps/server/src/orchestration-v2/CheckpointService.ts`, `apps/server/src/vcs/GitVcsDriver.ts`                       |
| Paths, counts, states, paging loop   | `packages/client-runtime/src/work-log/presentation.ts`, `packages/client-runtime/src/work-log/itemDetail.ts`                                                                 |
| Links and DiffPanel                  | `apps/web/src/diffPanelStore.ts`, `apps/web/src/components/DiffPanel.tsx`, `apps/web/src/components/ChatView.tsx`                                                            |
| Rows, inspector and card             | `apps/web/src/components/chat/MessagesTimeline.tsx`, `V2ItemInspector.tsx`, `toolOutputPresentation.tsx`, `ChangedFilesTree.tsx`                                             |
| Headless fixture                     | `apps/web/tests/activity-diffs/`                                                                                                                                             |
| Pre-merge gate                       | `scripts/studio-verify/activity-diffs-verify.sh`                                                                                                                             |
| Installed capture harness            | `scripts/studio-verify/activity-diffs-capture.mjs`                                                                                                                           |

Run the gate with `bash scripts/studio-verify/activity-diffs-verify.sh [--out DIR] [--fixture-out DIR]`. It runs every focused test, the headless fixture, the web and server production builds and the typecheck gate for the five packages, and names each failed step.
