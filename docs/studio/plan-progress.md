# Plan and progress in threads

Every thread shows where its work stands: what is done, what runs now and what comes next. The thread itself shows a plan card. The sidebar, the project's thread list, the coordinator's worker cards and the Overview show the same answer as a compact `3/5`. The sidebar reads increments with one query per project for its newest 100 threads there; older rows use the todo list on the thread shell.

## Sources, in order

1. **The SpecWeave increment the thread is bound to.** Its tasks come from `spec.md` (or a legacy `tasks.md`), and their state comes from `ledger.jsonl`. Its acceptance criteria come from `spec.md`. An AC counts as met once every task citing it is done or skipped.
2. **The agent's own todo list.** Claude Code TodoWrite, Codex plan updates and the other providers' plan events already arrive as `todo_list` plan artifacts. The card uses the newest run's list.

When a thread is bound to an increment whose tasks or ledger cannot be read, the card falls back to the todo list. It keeps the increment's links and says the ledger could not be read. A ledger that exists but is unreadable never folds as "nothing done".

## How a thread binds to an increment

SpecWithCode derives the binding on every read, unless someone linked the thread by hand. Strongest first:

0. **Manual: linked in SpecWithCode.** **Link increment** on the plan card (or "Link SpecWeave increment to thread" in the command palette) picks an increment from the thread's checkout, **No increment**, or **Automatic**. **Unlink** on the card sets No increment. The choice lives in SpecWithCode's database (`thread_increment_links`, written by `projects.threadIncrementLink`), never in the repository. No row means automatic. A row with no increment hides the increment, and the card falls back to the todo list. The thread's own task still comes from its claim when the claim names the same increment.
1. **Claim: the thread wrote to the increment's ledger.** SpecWithCode starts every provider turn with `SPECWEAVE_STUDIO_THREAD_ID`. Every ledger append made in that turn, by `specweave task claim|done|block|skip|release`, an auto-claim, `pickup`, `note` or a handoff, also writes `~/.specweave/studio/threads/<thread>.json` with `{incrementId, root, taskId, event, at}`. This happens in SpecWeave's `appendEvent` (`src/core/tasks/studio-thread-binding.ts`). It needs no setting, and a failed write never fails the command. SpecWithCode accepts the file only when its root lies inside the thread's worktree or the project folder and the increment folder exists. The task it names, while claimed or blocked, is the thread's own task.
2. **Checkpoint: SpecWeave's session checkpoint names the increment.** This is `~/.specweave/checkpoints/studio/<thread>.json`, written by the auto-handoff hooks.
3. **Name: an increment number or folder appears in the thread's title or branch**, such as `feat/0930-plan-card`.

Checkpoint and name binding come from the report resolver (`resolveReportIncrement` in `apps/server/src/project/ThreadReports.ts`). In every case only folders that exist count, and a number shared by two folders never guesses. Without a claim, a thread with its own worktree reads the increment there, because the agent appends to the ledger in that checkout before anything is merged. The card says which binding it used.

## Why the ledger, and not the agent's todo list

Claude Code Desktop renders TodoWrite: one list per session, gone when the session ends, with no evidence behind a tick. SpecWithCode keeps that list but nests it under the increment task the thread holds. Without a held task, it goes under the first task in progress. No text matching is involved. The ledger stays the record:

- a task is done only when `specweave task done` gives evidence;
- claims stop two agents from taking the same task;
- every tool and machine sees the same state.

SpecWithCode never writes the ledger from todo events. A ticked todo isn't evidence, SpecWithCode would be writing under the agent's identity, and todo items rarely match spec tasks one to one.

## How SpecWeave feeds the UI

```
spec.md + ledger.jsonl + metadata.json + reports/verify.json   (the repository, owned by SpecWeave)
        │  read-only, bounded, symlinks kept inside the checkout
        ▼
projects.threadIncrementProgressRead { projectId, threadIds }  (server: ThreadIncrementProgressService)
        │  parseSpecweaveSpec + foldSpecweaveLedger (mods/SpecweaveProgress.ts mirrors the CLI's foldLedger)
        ▼
useThreadIncrementProgress (web)  → ThreadPlanCard, PlanProgressChip
```

- **The ledger is the only state.** The fold follows the CLI's 3.0.6 rules: claims lease for two hours, `done` needs evidence, `skip` needs a reason, and only the owner releases. SpecWithCode never writes checkboxes, board tables or any derived state back into markdown, and never appends to the ledger. Claiming and finishing stay with the agent and `specweave task`.
- **No CLI process, no Git, no network.** The reader parses files directly, just as the `specweave:read` mod summary does. `specweave pickup` and the task board compute the same fold for terminal users. SpecWithCode does not shell out to them on a timer.
- **Refresh.** The ledger changes outside SpecWithCode's event stream. The query refreshes whenever one of its threads moves (an agent turn is when tasks get claimed and done) and every 15 seconds while the page is visible. Each query lists at most 100 threads, the newest first.
- **Access.** Reading needs `filesystem:read`, like thread reports; `projects.incrementsList` lists the increments in the thread's checkout for the picker. Changing a link needs `orchestration:operate`. Threads from another project are ignored, so a caller cannot aim the reader at a folder the project does not own.

## The todo list on the shell

`OrchestrationV2ThreadShell.planProgress` carries `{ completed, total, current, next }` for the newest run's todo list. Rows get "3/5" without loading the thread. The SQL shell query and the in-memory projection pick the same list, and a test holds them together (`ProjectionStore.planProgress.test.ts`). Older servers omit the field, and clients treat it as no todo list.

## What the thread shows

- **Plan card** at the top of the thread, collapsed to one line by default. The line shows the increment number or "Plan", the current step (the thread's own task first), the next step and `2/5`. Expanded, it lists every task or step: filled check for done, ring for current, dashed circle for open, pause for blocked, slash for skipped. The thread's own task is marked "this thread", and the agent's live todo list is nested under it. For an increment it also shows status, the last verify result, acceptance criteria and **Open spec** / **Open increment**, which open in the preferred editor.
- **Pull request pills** under the card: number, branch and state for every PR the thread linked, newest first. Each opens its PR. Two show, and the rest sit behind "Show N more".
- **"Working in folder ~/…"** divider at the top of the timeline. Its button opens the folder in the preferred editor.

The composer's live tasks drawer is unchanged. It still follows the running turn's own todo list.

## Checks

- `node node_modules/vite-plus/bin/vp test run apps/server/src/project/ThreadIncrementProgress.test.ts apps/server/src/orchestration-v2/ProjectionStore.planProgress.test.ts apps/web/src/studio/threadPlanProgress.test.ts`
- Headless fixture: `node node_modules/vite-plus/bin/vp build --config apps/web/tests/plan-progress/vite.config.ts`, then `node scripts/studio-verify/plan-progress.mjs /absolute/report-dir`. It uses synthetic data and headless Chromium, and writes screenshots to the report directory.
