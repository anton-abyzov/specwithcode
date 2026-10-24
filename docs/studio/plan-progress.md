# Plan and progress in threads

Every thread shows where its work stands: what is done, what runs now and what comes next. The thread itself shows a plan card. The sidebar, the project's thread list, the coordinator's worker cards and the Overview show the same answer as a compact `3/5`. The sidebar reads increments with one query per project for its newest 100 threads there; older rows use the todo list on the thread shell.

## Sources, in order

1. **The SpecWeave increment the thread is bound to.** Its tasks come from `spec.md` (or a legacy `tasks.md`), and their state comes from `ledger.jsonl`. Its acceptance criteria come from `spec.md`. An AC counts as met once every task citing it is done or skipped.
2. **The agent's own todo list.** Claude Code TodoWrite, Codex plan updates and the other providers' plan events already arrive as `todo_list` plan artifacts. The card uses the newest run's list.

When a thread is bound to an increment whose tasks or ledger cannot be read, the card falls back to the todo list. It keeps the increment's links and says the ledger could not be read. A ledger that exists but is unreadable never folds as "nothing done".

## How a thread binds to an increment

SpecWithCode derives the binding on every read, unless someone linked the thread by hand. Strongest first:

0. **Manual: linked in SpecWithCode.** **Link increment** on the plan card (or "Link SpecWeave increment to thread" in the command palette) picks an increment from the thread's checkout, **No increment**, or **Automatic**. **Unlink** on the card sets No increment. The choice lives in SpecWithCode's database (`thread_increment_links`, written by `projects.threadIncrementLink`), never in the repository. No row means automatic. A row with no increment hides the increment, and the card falls back to the todo list. The thread's own task still comes from its claim when the claim names the same increment.
1. **Claim: the thread wrote to the increment's ledger.** SpecWithCode starts every provider turn with `SPECWEAVE_STUDIO_THREAD_ID`. Every ledger append made in that turn, by `specweave task claim|done|block|skip|release`, an auto-claim, `pickup`, `note` or a handoff, also writes `~/.specweave/studio/threads/<thread>.json` with `{incrementId, root, taskId, event, at}`. This happens in SpecWeave's `appendEvent` (`src/core/tasks/studio-thread-binding.ts`). It needs no setting, and a failed write never fails the command. SpecWithCode accepts the file only when its root lies inside the thread's worktree or the project folder, or is exactly the umbrella workspace that plans for them (see below), and the increment folder exists. The task it names, while claimed or blocked, is the thread's own task.
2. **Checkpoint: SpecWeave's session checkpoint names the increment.** This is `~/.specweave/checkpoints/studio/<thread>.json`, written by the auto-handoff hooks.
3. **Name: an increment number or folder appears in the thread's title or branch**, such as `feat/0930-plan-card`.

Checkpoint and name binding come from the report resolver (`resolveReportIncrement` in `apps/server/src/project/ThreadReports.ts`). In every case only folders that exist count, and a number shared by two folders never guesses. Without a claim, a thread with its own worktree reads the increment there, because the agent appends to the ledger in that checkout before anything is merged. The card says which binding it used.

The increments are read from the thread's worktree when it has `.specweave/increments`, else from the project folder. A project that is a member repository of a SpecWeave umbrella has no `.specweave` of its own; the CLI walks up to the nearest folder with `.specweave/config.json` and writes there, so SpecWithCode does the same: the nearest folder at or above the worktree, then the project folder, with `.specweave/config.json`, used only when it also has `.specweave/increments`. Claims, branch and name binding and the Link picker all use that root. A sibling repository's `.specweave` under the same umbrella is not accepted.

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
useThreadIncrementProgress / useThreadIncrementState (web)  → ThreadPlanCard, PlanProgressChip, Threads pane
```

- **The ledger is the only state.** The fold follows the CLI's 3.0.6 rules: claims lease for two hours, `done` needs evidence, `skip` needs a reason, and only the owner releases. SpecWithCode never writes checkboxes, board tables or any derived state back into markdown, and never appends to the ledger. Claiming and finishing stay with the agent and `specweave task`.
- **No CLI process, no Git, no network.** The reader parses files directly, just as the `specweave:read` mod summary does. `specweave pickup` and the task board compute the same fold for terminal users. SpecWithCode does not shell out to them on a timer.
- **Refresh.** The ledger changes outside SpecWithCode's event stream. The query refreshes whenever one of its threads moves (an agent turn is when tasks get claimed and done) and every 15 seconds while the page is visible. Each query lists at most 100 threads, the newest first.
- **Access.** Reading needs `filesystem:read`, like thread reports; `projects.incrementsList` lists the increments in the thread's checkout for the picker. Changing a link needs `orchestration:operate`. Threads from another project are ignored, so a caller cannot aim the reader at a folder the project does not own.

## The todo list on the shell

`OrchestrationV2ThreadShell.planProgress` carries `{ completed, total, current, next }` for the newest run's todo list. Rows get "3/5" without loading the thread. The SQL shell query and the in-memory projection pick the same list, and a test holds them together (`ProjectionStore.planProgress.test.ts`). Older servers omit the field, and clients treat it as no todo list.

## What the thread shows

- **Plan card** at the top of the thread, collapsed to one line by default. The line shows the increment number or "Plan", the current step (the thread's own task first), the next step and `2/5`. Expanded, it lists every task or step: filled check for done, ring for current, dashed circle for open, pause for blocked, slash for skipped. The thread's own task is marked "this thread", and the agent's live todo list is nested under it. For an increment it also shows status, the last verify result and acceptance criteria. **Open spec** always shows when the spec exists and opens it in the app's viewer (in front of the viewer overlay when that is open); a small **editor** link beside it and **Open increment** use the preferred editor and show only when one is installed. A step that links to a file in the increment opens in the viewer too; a step that links to a folder opens in the editor. A bound increment with no tasks yet still shows, as "No tasks yet".
- **Compact progress** in lists: `0996 · 3/5` for an increment, `3/5` for a todo list, and `0996` alone for a bound increment with no tasks yet. It is never a button, because it sits inside row buttons.
- **Pull request pills** under the card: number, branch and state for every PR the thread linked, newest first. Each opens its PR. Two show, and the rest sit behind "Show N more".
- **"Working in folder ~/…"** divider at the top of the timeline. Its button opens the folder in the preferred editor.

The composer's live tasks drawer is unchanged. It still follows the running turn's own todo list.

## Unplanned work

In a SpecWeave project (one with `.specweave/increments`, or a member repository under an umbrella that has them), `projects.threadIncrementProgressRead` also returns `specweave: true` and `unplanned`: the listed threads that changed code with no plan behind them. A thread counts when one of its turns has a completed `file_change` item and none of these applies:

- it is bound to an increment, by any of the bindings above;
- it has a hand-made link, including **No increment needed** (a `none` row);
- its SpecWeave work-session marker `~/.specweave/sessions/studio-<thread>.json` (the thread id sanitized as the CLI's `workSessionFile` does) has `kind: "small-fix"`, written by `specweave small-fix` in that thread;
- it is a provider-native subagent (`lineage.relationshipToParent: "subagent"` with `creationSource: "provider"`); its parent owns that work.

The server answers from its own projection tables through the SQL client it already uses (the file-change lookup is covered by the `thread_id, type, status, run_id` index) and caches the answer per thread by its newest run: a yes is kept, a no is kept until that run moves on and never while it still runs. A failed lookup lists no unplanned threads rather than failing the progress read. Older servers omit both fields; clients then show nothing unplanned.

In the app:

- The thread's plan card shows even without a plan, headed "Changed code without an increment", with **Link increment** (the picker) and **No increment needed** (the same `none` link as **Unlink**). A thread with a todo list keeps it and gets a "No increment" tag.
- The Threads pane header says "N threads changed code without an increment" in muted text: increments are recommended, never required, so this is information, not a warning. The button filters the list to them and **Show all** clears it. Each such row carries a muted **No increment** chip.
- **Hide** (the × beside the notice) turns it off for that project on this device, saved in `localStorage` under `studio:unplanned-notice-hidden:v1` like the pane's sort order. Hidden, the notice, its filter and the row chips go away and the plan card no longer opens itself for those threads; the per-thread data is still computed. **Note threads without an increment** in the Threads sort menu turns it back on.

## Checks

- `node node_modules/vite-plus/bin/vp test run apps/server/src/project/ThreadIncrementProgress.test.ts apps/server/src/orchestration-v2/ProjectionStore.planProgress.test.ts apps/web/src/studio/threadPlanProgress.test.ts`
- `node node_modules/vite-plus/bin/vp test run apps/server/src/project/ThreadIncrementProgressService.test.ts` covers the unplanned rules: bound, `none`, small fix, provider child, unplanned and a project without SpecWeave.
- Headless fixture: `node node_modules/vite-plus/bin/vp build --config apps/web/tests/plan-progress/vite.config.ts`, then `node scripts/studio-verify/plan-progress.mjs /absolute/report-dir`. It uses synthetic data and headless Chromium, checks that **Open spec** goes to the viewer with the absolute spec path, the card without an editor, the zero-task chip, the unplanned card, the header filter and the row chip, that the notice is muted, that **Hide** survives a reload and the sort-menu switch brings it back (also across a reload), and writes light and dark screenshots to the report directory.
