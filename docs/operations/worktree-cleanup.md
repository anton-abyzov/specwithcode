# Worktree cleanup

Threads work in folders under `~/.specwithcode/<id>/worktrees` (or the folder set in **Settings → Storage**). Many of those folders look idle: no process runs in them and nothing changed for days. That does not mean they are free.

## The rule

Never remove a folder that an open thread uses. An open thread is one that is not deleted, not archived and not resolved. The folder counts as used when the thread's recorded folder is that folder, sits inside it, or contains it.

This holds for every cleanup: by hand, from a script, or by the app. The app can put back a missing worktree when the thread resumes, but only from a branch it can still find in the project's own repository. A worktree of a nested or sibling repository, or one whose branch was deleted, cannot come back, and the thread stops with "Thread folder is missing".

## How to check

Ask the app before you remove anything:

```sh
specweave-studio worktree owners --path ~/.specwithcode/m4/worktrees/repo/feature-x
```

It prints the owners it finds and exits with:

- **0**: the folder is in use. An open thread uses it, sits inside it or contains it, or a registered project or a live agent session is inside it.
- **1**: nothing uses it. Only this code means the folder may be removed.
- **2**: the check failed, for example no database at `--base-dir` or a row it could not read. The reason goes to stderr. Keep the folder.

A script must remove a folder only on exit 1, and treat every other code as "keep". A mistyped command line also exits 1, so run the script's exact command by hand once on a folder you know is in use and check that it exits 0.

Add `--json` for one JSON line per owner. Thread lines have `kind: "thread"`, `path`, `threadId`, `title`, `state` and `projectId`; project and session lines have `kind: "project"` or `kind: "session"` and `path`. Without `--path` it lists every thread folder with its state: `open`, `settled`, `archived`, or `deleted` (deleted, cleanup still running). Paths are compared by real path, so a folder reached through a symlink matches too.

The command reads the live database through the same read-only connection as `db query` (see [the live database](live-database.md)). It cannot see terminals, which only the running service knows about, so also check that no terminal is open in the folder.

Without the CLI, the same data is in the thread projection:

```sh
specweave-studio db query "SELECT thread_id, archived_at, deleted_at, json_extract(payload_json, '$.worktreePath') AS path, json_extract(payload_json, '$.settledOverride') AS settled FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.worktreePath') IS NOT NULL"
```

A row with no `deleted_at`, no `archived_at` and `settled` other than `"settled"` is an open thread. Compare real paths (`realpath`), not spellings.

Never open `userdata/statev2.sqlite` yourself to answer this, not even read-only.

## What the app removes on its own

**Settings → Storage → Worktrees** has four rules, all off by default:

- **Delete worktrees with deleted threads** removes a folder once its last thread is deleted and that thread's cleanup has finished.
- **Delete inactive worktrees**, **Delete merged worktrees** and **Delete unchanged worktrees** remove the folders of resolved and archived threads. Folders of open threads are always kept, also when their pull request merged or they have been idle for a long time.

Before removing a folder the app also checks that no other thread shares it, no project lives in it, no agent session or terminal uses it, it has no local changes and no ignored files other than `node_modules`. It checks the open-thread rule again right before removal. It keeps the branch and the thread's recorded folder, so a reopened thread can get its checkout back from that branch.

Removing a worktree by hand from inside the app (deleting a thread and choosing to delete its worktree) refuses any folder that another thread still records, archived or not.
