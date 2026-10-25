# Plan and progress in threads

Every thread shows where its work stands: what is done, what runs now and what comes next. The thread itself shows a plan card. The sidebar, the project's thread list, the coordinator's worker cards and the Overview show the same answer as a compact `3/5`. The sidebar reads increments with one query per project for its newest 100 threads there; older rows use the todo list on the thread shell.

## Sources, in order

1. **The SpecWeave increment the thread is bound to.** Its tasks come from `spec.md` (or a legacy `tasks.md`), and their state comes from `ledger.jsonl`. Its acceptance criteria come from `spec.md`. An AC counts as met once every task citing it is done or skipped.
2. **The agent's own todo list.** Claude Code TodoWrite, Codex plan updates and the other providers' plan events already arrive as `todo_list` plan artifacts. The card uses the newest run's list.

When a thread is bound to an increment whose tasks or ledger cannot be read, the card falls back to the todo list. It keeps the increment's links and says the ledger could not be read. A ledger that exists but is unreadable never folds as "nothing done".

## How a thread binds to an increment

SpecWithCode derives the binding on every read, unless someone linked the thread by hand. Strongest first:

0. **Manual: linked in SpecWithCode.** **Link increment** on the plan card (or "Link SpecWeave increment to thread" in the command palette) picks an increment from the thread's checkout, **No increment**, or **Automatic**. **Unlink** on the card sets No increment. The choice lives in SpecWithCode's database (`thread_increment_links`, written by `projects.threadIncrementLink`), never in the repository. No row means automatic. A row with no increment hides the increment, and the card falls back to the todo list. The thread's own task still comes from its claim when the claim names the same increment.
1. **Claim: the thread wrote to the increment's ledger.** SpecWithCode starts every provider turn with `SPECWEAVE_STUDIO_THREAD_ID`. Codex builds each shell command's environment from the user's `shell_environment_policy`, which under `inherit = "core"` drops the app-server's own variables, so its app-server also gets `-c shell_environment_policy.set.SPECWEAVE_*` overrides; they merge into the user's table and keep `inherit` and their other entries. A user `include_only` list still applies after them, so it must allow `SPECWEAVE_*` for the identity to reach the shell (`apps/server/src/orchestration-v2/Adapters/CodexShellEnvironment.test.ts` runs a real Codex shell to prove it). Every ledger append made in that turn, by `specweave task claim|done|block|skip|release`, an auto-claim, `pickup`, `note` or a handoff, also writes `~/.specweave/studio/threads/<thread>.json` with `{incrementId, root, taskId, event, at}`. This happens in SpecWeave's `appendEvent` (`src/core/tasks/studio-thread-binding.ts`). It needs no setting, and a failed write never fails the command. SpecWithCode accepts the file only when its root lies inside the thread's worktree or the project folder, is exactly the umbrella workspace that plans for them (see below), or is another checkout Git registered for one of their repositories, and the increment folder exists. The task it names, while claimed or blocked, is the thread's own task.
2. **Checkpoint: SpecWeave's session checkpoint names the increment.** This is `~/.specweave/checkpoints/studio/<thread>.json`, written by the auto-handoff hooks.
3. **Name: an increment number or folder appears in the thread's title or branch**, such as `feat/0930-plan-card`.

Checkpoint and name binding come from the report resolver (`resolveReportIncrement` in `apps/server/src/project/ThreadReports.ts`). In every case only folders that exist count, and a number shared by two folders never guesses. Without a claim, a thread with its own worktree reads the increment there, because the agent appends to the ledger in that checkout before anything is merged. The card says which binding it used.

The increments are read from the thread's worktree when it has `.specweave/increments`, else from the project folder. A project that is a member repository of a SpecWeave umbrella has no `.specweave` of its own; the CLI walks up to the nearest folder with `.specweave/config.json` and writes there, so SpecWithCode does the same: the nearest folder at or above the worktree, then the project folder, with `.specweave/config.json`, used only when it also has `.specweave/increments`. Claims, branch and name binding and the Link picker all use that root. A sibling repository's `.specweave` under the same umbrella is not accepted.

A thread can also work in a linked worktree made elsewhere with `git worktree add`, which SpecWithCode never registered for it. Its claim, a link made by hand and an explicit launch ref resolve there only when Git registered that folder both ways, checked offline without the Git CLI (`apps/server/src/project/registeredCheckout.ts`): the folder's `.git` is a regular file whose `gitdir:` names `<common>/worktrees/<name>` inside the project's own Git directory (or the thread's worktree's; never the umbrella's above a member repository), that admin folder's `gitdir` names the folder's `.git` back, and its `commondir`, when present, agrees. Paths are compared after resolving links. Each folder check gets two seconds, so a sleeping network volume answers no instead of stalling the plan card, and a repository's worktree list is reused for at most five seconds. An unrelated sibling folder, a forged `.git` file, a symlinked `.git` and a submodule stay refused. When several checkouts hold the same increment, a hand-made link and a launch ref read the copy with the newest ledger write; a launch ref whose number names different folders in different checkouts is ambiguous and launches nothing. SpecWeave resolves increments from the current directory, so a worker launched on an increment that only another checkout holds is told to try `specweave pickup <id>` in its own checkout first (a new worktree made from a branch that holds the increment has it) and otherwise to run `cd <that checkout> && specweave pickup <id>` and its other SpecWeave commands there. A thread keeps one current increment; there is no additive history of past ones.

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

- **Plan card** at the top of the thread, collapsed to one line by default. The line shows "Increment 0996" or, for the agent's own todo list, "Checklist", the current step (the thread's own task first), the next step and `2/5`. Expanded, it lists every task or step: filled check for done, ring for current, dashed circle for open, pause for blocked, slash for skipped. The thread's own task is marked "this thread", and the agent's live todo list is nested under it. For an increment it also shows status, the last verify result and acceptance criteria; for a checklist it says the list comes from the agent's provider and is not a SpecWeave increment. **Open spec** always shows when the spec exists and opens it in the app's viewer (in front of the viewer overlay when that is open); a small **editor** link beside it and **Open increment** use the preferred editor and show only when one is installed. A step that links to a file in the increment opens in the viewer too; a step that links to a folder opens in the editor. A bound increment with no tasks yet still shows, as "No tasks yet".
- **Compact progress** in lists: `0996 · 3/5` for an increment, `Checklist 3/5` for the agent's todo list, and `0996` alone for a bound increment with no tasks yet. A checklist beside the **No increment** glyph never reads as an increment's tasks. It is never a button, because it sits inside row buttons.
- **Pull request pills** under the card: number, branch and state for every PR the thread linked, newest first. Each opens its PR. Two show, and the rest sit behind "Show N more".
- **"Working in folder ~/…"** divider at the top of the timeline. Its button opens the folder in the preferred editor.

The composer's live tasks drawer is unchanged. It still follows the running turn's own todo list.

## Unplanned work

In a SpecWeave project (one with `.specweave/increments`, or a member repository under an umbrella that has them), `projects.threadIncrementProgressRead` also returns `specweave: true` and `unplanned`: the listed threads that changed code with no plan behind them. A thread counts when one of its turns has a completed `file_change` item and none of these applies:

- it is bound to an increment, by any of the bindings above;
- it has a hand-made link, including **No increment needed** (a `none` row);
- its SpecWeave work-session marker `~/.specweave/sessions/studio-<thread>.json` (the thread id sanitized as the CLI's `workSessionFile` does) has `kind: "small-fix"`, written by `specweave small-fix` in that thread;
- it is a provider-native subagent (`lineage.relationshipToParent: "subagent"` with `creationSource: "provider"`); its parent owns that work.

Only runs that were not rolled back count, for the thread and for its provider-native children: a child's edits count for its parent unless the parent run that spawned it was rolled back. A thread whose changed files are all reports, specifications or other documents (anything under `.specweave/`, Markdown, reStructuredText and AsciiDoc files, and pages, data, text files or captures inside a `reports` or `evidence` folder, judged relative to the thread's checkout) is returned in `documentation` instead of `unplanned`. Plain `.txt` elsewhere counts as code (`requirements.txt`, `CMakeLists.txt`). The server finds threads with any change from the index, then reads their edits newest first, a page at a time, and stops at the first code change. "Code" is cached for the thread's newest run; "documentation" and "nothing" only once that run settled and the thread has no native subagent, so a later code edit is never hidden. A provider checklist without an increment stays legitimate and never makes a thread unplanned.

The server answers from its own projection tables through the SQL client it already uses (the file-change lookup is covered by the `thread_id, type, status, run_id` index) and caches the answer per thread by its newest run: a yes is kept, a no is kept until that run moves on and never while it still runs. A failed lookup lists no unplanned threads rather than failing the progress read. Older servers omit both fields; clients then show nothing unplanned.

In the app:

- The thread's plan card shows even without a plan, headed "Changed code without an increment", with **Link increment** (the picker) and **No increment needed** (the same `none` link as **Unlink**). A thread with a todo list keeps it and gets a "No increment" tag.
- The Threads pane header says "N threads changed code without an increment" in muted text: increments are recommended, never required, so this is information, not a warning. The button filters the list to them and **Show all** clears it. Each such row carries the same muted code glyph (`</>`) the notice shows; hover or focus names it "No increment", a screen reader hears "No increment: changed code without an increment", and the thread's plan card says it in full.
- **Dismiss** (the × beside the notice) acknowledges the threads it counts at that moment, for that project on this device, saved in `localStorage` under `studio:unplanned-acknowledged:v1` (thread ids per `environment:project`, newest 1,000 kept). The notice then counts and filters only threads it has not counted before, so it comes back only when another thread changes code without an increment. Acknowledged threads keep their row glyph and their plan card with **Link increment** and **No increment needed**; nothing on the server changes, and they are never marked planned. A thread that was already acknowledged and changes more code does not bring the notice back: link an increment or choose **No increment needed** for a durable per-thread answer. Acknowledgments do not sync to other devices.
- **Note threads without an increment** in the Threads sort menu turns the notice off for good for that project on this device (`studio:unplanned-notice-hidden:v1`, like the pane's sort order). Off, the notice, its filter and the row glyphs go away and the plan card no longer opens itself for those threads; the per-thread data is still computed. Turning it back on clears that project's acknowledgments, so the full count shows again.

## Checks

- `node node_modules/vite-plus/bin/vp test run apps/server/src/project/ThreadIncrementProgress.test.ts apps/server/src/orchestration-v2/ProjectionStore.planProgress.test.ts apps/web/src/studio/threadPlanProgress.test.ts`
- `node node_modules/vite-plus/bin/vp test run apps/web/src/studio/unplannedNotice.test.ts` covers Dismiss: only threads not acknowledged count, a new thread brings the notice back, other projects stay untouched, the 1,000 limit, and turning the notice back on clears the acknowledgments.
- `node node_modules/vite-plus/bin/vp test run apps/server/src/project/ThreadIncrementProgressService.test.ts` covers the unplanned rules: bound, `none`, small fix, provider child, a rolled-back parent run, documentation-only changes, unplanned and a project without SpecWeave.
- `node node_modules/vite-plus/bin/vp test run apps/server/src/project/registeredCheckout.test.ts apps/server/src/project/ThreadIncrementProgress.test.ts apps/server/src/project/launchIncrement.test.ts` covers registered worktrees with real `git worktree add` fixtures and the refused forged, symlinked, submodule and sibling folders.
- `node node_modules/vite-plus/bin/vp test run apps/server/src/orchestration-v2/Adapters/CodexShellEnvironment.test.ts` runs a real Codex sandbox shell under `inherit = "core"` (no account, network or model turn; set `STUDIO_CODEX_BINARY`, skipped when Codex is absent) and checks that a `specweave task claim` from it binds the thread.
- Headless fixture: `node node_modules/vite-plus/bin/vp build --config apps/web/tests/plan-progress/vite.config.ts`, then `node scripts/studio-verify/plan-progress.mjs /absolute/report-dir`. It uses synthetic data and headless Chromium, checks that **Open spec** goes to the viewer with the absolute spec path, the card without an editor, the zero-task chip, "Increment 0930" against "Checklist" on cards and chips, a checklist row beside the muted **No increment** glyph, the unplanned card, the header filter and the row glyph, that the notice is muted, that **Dismiss** keeps the row glyphs and survives a reload, that a thread the notice had not counted brings it back counted alone, and that the sort-menu switch turns everything off and back on with the full count (each across a reload), and writes light and dark screenshots to the report directory.
