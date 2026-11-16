# Worktree cleanup

Threads work in folders under `~/.specwithcode/<id>/worktrees` (or the folder set in **Settings → Storage**). Many of those folders look idle: no process runs in them and nothing changed for days. That does not mean they are free.

## The rule

For people and scripts: never remove a folder that an open chat uses. An open chat is one that is not deleted, not archived and not resolved. The folder counts as used when the chat's recorded folder is that folder, sits inside it, or contains it. A sub-chat (a review, a worker's helper) records its parent's folder and follows its parent: while it has no run in progress or queued it counts as open exactly when its parent does, and while it runs it keeps the folder whatever its parent's state.

Leave finished folders to the app. It removes them with the checks below and keeps the branch, so a chat that resumes gets its folder back. A folder removed any other way can only come back from a branch the app can still find in the project's own repository. A worktree of a nested or sibling repository, or one whose branch was deleted, cannot come back, and the chat stops with "Thread folder is missing".

**Never run `git worktree remove` on a repository folder inside a chat's folder.** A chat that works on several repositories records the outer folder (for example `worktrees/umbrella/feature-x`), and the repositories sit inside it (`.../repositories/<owner>/<repo>`). No chat records the inner path, so a check by that path finds no owner. In November 2026 a job that ran every 30 minutes did exactly this to 11 folders that open chats were using. Git dropped each registration but left the files ("Directory not empty"). When Git later reused a registration name, five of those folders pointed at another chat's registration, so Git commands run there acted on another chat's branch. Check the outer folder with `worktree owners`, and let the app remove members.

## How to check

Ask the app before you remove anything:

```sh
specweave-studio worktree owners --path ~/.specwithcode/<id>/worktrees/repo/feature-x
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

A row with no `deleted_at`, no `archived_at` and `settled` other than `"settled"` is an open thread, with one exception the query cannot show: a sub-chat with no run in progress takes its parent's state (see the rule above). `worktree owners` applies that; prefer it. Compare real paths (`realpath`), not spellings.

Never open `userdata/statev2.sqlite` yourself to answer this, not even read-only.

## What the app removes on its own

**Settings → Storage → Worktrees** has five rules. **Delete merged worktrees** and **Delete worktrees of resolved chats** are on by default; the other three are off. A project whose **Automatic worktree cleanup** is Off keeps all its folders.

- **Delete merged worktrees** removes a folder whose pull request merged (its commits are on the default branch) or closed with every commit pushed. When every chat using the folder is resolved or archived it goes at the next sweep. When a chat is still open, it goes once that chat has been quiet for 6 hours. A chat that is running or waiting always keeps it.
- **Delete worktrees of resolved chats** removes a folder once every chat using it is resolved or archived and every repository in it is clean, with nothing unpushed. No merge is needed and the Git host is not asked. This is a machine setting; a project cannot change it.
- **Delete worktrees with deleted threads** removes a folder once its last chat is deleted and that chat's cleanup has finished.
- **Delete inactive worktrees** and **Delete unchanged worktrees** remove the folders of resolved and archived chats after the days you set, or when the branch has no commits of its own.

Unpushed commits keep a folder under every rule, the deleted and inactive rules included, unless their content is already on the default branch. The branch would survive the removal, but those commits exist only on this machine.

Archived chats are swept like resolved ones. A fork shares its parent's folder but decides for itself, because a person works in it. A sub-chat its parent started follows that parent, as in the rule above.

A chat counts as quiet when its last run is idle, completed, failed, cancelled, interrupted or rolled back. A run that is waiting, queued, preparing, starting or running, a pending question, a background task or a queued message keeps the folder. Every age the rules use fails closed: a time the app cannot read never counts as old, so the folder stays.

The pull-request answer from the Git host is reused for up to 50 minutes for the same branch head; a merged answer is final for that head. Before a removal that rests on a closed pull request, the host is asked again, since a closed pull request can be reopened. A host that gives no answer keeps the folder as unknown, and that non-answer is never reused.

Before removing a folder the app checks, for every repository in it:

- **The registration.** A worktree's `.git` file names a registration in its repository, and that registration's `gitdir` must point back at the same folder. If it does not, the folder is kept as "broken registration" and the app runs no Git command in it, because Git would act on whatever the registration now points to. To check one by hand, read the folder's `.git` file (`gitdir: <repo>/.git/worktrees/<name>`), then read `<repo>/.git/worktrees/<name>/gitdir`: it must name `<folder>/.git`. If it names another folder, or the registration is missing, the files in the folder are not tracked by the branch you expect. Copy what you need out of it, then remove the folder by hand. A member of a set that is reached through a symbolic link or lies outside the folder also keeps the folder, since it may be another chat's worktree.
- **Nothing exists only here.** No uncommitted changes, no untracked files, no unpushed commits (unless the content is already on the default branch), no stash made on its branch, no commit only its reflog reaches, and no hidden tracked changes (assume-unchanged or skip-worktree). A checked-out submodule or any other repository found inside keeps the folder, because its commits may be nowhere else.
- **Ignored files.** Rebuildable ones (`node_modules`, build caches) go with the folder. Ignored media (screenshots, recordings), at most 2,000 files and 1 GiB per folder, is copied to `<baseDir>/evidence/removed-worktrees/<folder>-<time>/` (for example under `~/.specwithcode/<id>/`) and checked by size first. Any other ignored file, more media than that, an ignored folder with more than 20,000 entries, or a failed copy keeps the folder; those files can be secrets or data. When a removal is abandoned after the copy, the copies made for it are deleted.
- **Nothing is working in it.** No chat using it is running, and no agent session, terminal or process has its working directory in it.

All of these are read again right before removal, under the workspace lease; any change keeps the folder. A folder with several repositories is removed member by member, deepest first. Right before each member goes, the folder's use and that member's own files, branch and registration are read again, and the sweep stops at that folder if anything changed. A member on another volume than its folder keeps it. Each removal is plain `git worktree remove` without `--force`, and the sweep runs no `git worktree prune`, which would also drop the registrations of worktrees on a drive that is not mounted. The branches and the folder's list of repositories stay, so a chat that resumes gets every repository back.

Removing a worktree by hand from inside the app (deleting a chat and choosing to delete its worktree) refuses any folder that another chat still records, archived or not.

Git can give up halfway through a removal, for example when a build is still writing into the folder: it forgets the worktree but leaves some files. The sweep leaves those files in place, since nothing checked them, and reports the folder as kept. A removal you ask for by hand deletes what is left instead.

The sweep also removes leftover files of stopped downloads: `tmp_pack_*`, `tmp_obj_*` and `.tmp-<pid>-pack-*` files older than six hours in `<baseDir>/verify/*/.git`. A failed Git download or housekeeping run leaves one there each time, and nothing else removes them (see [heavy checks](heavy-checks.md)).

A sweep runs every hour, and shortly after a chat is resolved or archived, its pull request merges, or the disk runs low. Requests that arrive together run as one sweep, and these extra sweeps run at most once every 2 minutes. Only one sweep runs at a time. Besides chat worktrees and leftover downloads, the periodic sweep also removes worktrees agents left without a chat, merged review clones, old browser artifacts and rotated logs.

### What would go, and why a folder stays

**Settings → Storage → What cleanup would remove** shows the plan before anything goes. Press **Check**: it lists every chat folder and every set of leftover download files under **Would be removed** or **Kept**, each with the chat, its size and one sentence for the reason (for example "It has commits that are not pushed."). Nothing is checked until you press it, because the check asks the Git host about finished folders. The plan changes nothing: it fetches nothing and compares against the default branch as last fetched. It waits for a running sweep to finish first. The total reads "at least": sizes leave out dependency installs, whose files are shared with the package store, and ignored media, which is copied to evidence rather than freed.

**Clean up now** runs one sweep of the chat worktree pass and the leftover downloads only, with the same rules, and shows what it removed; the other passes run only in the periodic sweep. The list and the sweep share one decision, so the list shows what a sweep would do at that moment; a chat that starts work or a new commit after the check changes it.

## The scratch folder

`<baseDir>/scratch` (for example `~/.specwithcode/<id>/scratch`) is the Scratch project, shown as "No project". Each chat there has a folder of its own, named `YYYY-MM-DD-<words>-<id>`, holding whatever the chat made. Those folders cannot be recreated: nothing else has a copy. Agents also leave probes and run logs beside them. Never clear this folder by age or by script; on 2026-10-27 a script that removed every folder idle for a day took 147 of them, chats included.

The app also clears old scratch folders on its own (**Settings → Storage → App folder → Delete old scratch folders**, off by default; when turned on it starts at 14 days, at least 7). It applies the same decision as `scratch prune`, deletes without copying, and keeps a folder when any thread (deleted ones included), project, agent session or terminal records it, inside it or around it, when a running process has its working directory in it (`lsof -d cwd` on macOS, `/proc` on Linux; on Windows, or when that list cannot be read, it removes nothing), or when its age is unknown. Ages come from the app folder check below; right before removal it measures the folder again, reads the processes again and checks its owners again. Each removal is logged with its size. To archive instead, turn the setting off and use `scratch prune`.

Use `scratch prune` instead:

```sh
specweave-studio scratch prune                                        # dry run, 14 days
specweave-studio scratch prune --older-than 30d --json                # dry run, one JSON line per folder
specweave-studio scratch prune --apply --archive-to /Volumes/Archive/scratch
```

It looks only at the direct children of `<baseDir>/scratch` and keeps a folder when any of these holds:

- a project, any thread (open, settled, archived, or deleted at any time), or a live agent session records a folder that is it, inside it, or around it. The Scratch project's own root and projects around the scratch folder do not count, since they would hold every folder;
- it is a file or a symlink, not a folder;
- its age is unknown: a file in it could not be read, or it holds more than 20,000 entries;
- anything in it, at any depth, changed within `--older-than` (default `14d`, at least `7d`; also `2w` or `336h`). "Changed" is the newer of a file's mtime and ctime, so a folder restored with `tar x`, `rsync -a`, `cp -p` or a move back from the archive counts as new: those keep old mtimes, but ctime records when the file arrived.

Without `--apply` it changes nothing and prints each folder with what it would do and why. `--apply` moves the folders it would remove into `--archive-to` (copying across volumes); it deletes them only with `--delete` instead, and refuses `--apply` with neither. Right before acting it reads the database again, and right before each move it reads the folder's age again; it skips a folder that something now uses or that changed. A thread bound to an old folder in the moment between that read and the move is not seen. An archive folder is never replaced, even an empty one. If a copy across volumes finishes but the source cannot be fully removed, the folder is reported as `partial`: the archive holds a full copy and the rest of the source stays. Each action is printed; with `--json`, one line per folder (`kind: "folder"`, `name`, `path`, `action`, `reason`, `newest`, and `result` after `--apply`) and a `kind: "summary"` line.

It reads the database read-only, like `worktree owners`, and refuses to run (exit 2, nothing removed) when `<baseDir>/userdata/statev2.sqlite` is missing or cannot be read. It exits 1 when a folder could not be moved or deleted, or when the run stopped after it had acted on a folder, and 0 otherwise. `--archive-to` inside the scratch folder is refused before anything is created.

## App folder size

Every six hours, starting five minutes after the app starts (never during startup catch-up), the app measures its home folder (`~/.specwithcode`, or the base folder alone when it is set elsewhere) in a worker thread: worktrees (with the number of checkouts), the database files, logs, scratch, evidence, update backups and release builds, plus everything else. The home folder and each part's own folder are resolved first, so a folder moved to another volume and linked back is measured where it lives (never a link that points to a folder holding the home folder); inside them the walk never follows a symlink, never enters a volume mounted there, counts a hard-linked file once, never reaches the user's home folder or `~/Library`, sleeps 10 ms every 1024 entries so it does not saturate the disk, and stops after 10 minutes or 5 million entries, reporting what it counted. The small parts and scratch are measured first and worktrees last, so a huge worktrees folder cannot use up the limit before them. It never opens the database. Like `du` and Finder, it counts APFS clones in full, so the disk may use less.

The result is kept in `<baseDir>/userdata/home-usage.json`, shown in **Settings → Storage → App folder**, and raises a notice when the folder passes **Warn when the app folder is large** (50 GB by default) or a part grows by at least 10 GB and by half since the check before. The notice links to Storage settings. Evidence folders are reported, never removed.

## Working copies for a thread

Read the canonical SpecWeave increment, claim only the assigned task under your own identity and edit its files. Work in the existing checkout your thread was given, on your own branch: no `git worktree add` unless the project's Use worktrees switch is on, and no extra clones unless it is on or the user asks (owner's rule, 2026-11-02). While it is off, the `git` SpecWithCode puts on the PATH of a thread in the project's own checkout refuses `git worktree add`; do not work around it. If the user asks for a separate worktree, tell them to turn on Use worktrees in the project's settings first: while it is off, a thread launch asking for one gets the project's checkout. When the switch is on, put the worktree under SpecWithCode's configured worktree root (never a sibling of the checkout in ~/Projects/github) and create it without the vendored `.repos` tree: `git worktree add --no-checkout -b <branch> <path> origin/main`, then in it `git sparse-checkout set --no-cone '/*' '!/.repos/'` and `git checkout <branch>`. Run a normal `pnpm install` there, and never symlink another checkout's node_modules, because workspace packages would resolve to that checkout's source. Remove it (`git worktree remove`) once its PR merges or closes. Before removing any worktree, check no SpecWithCode thread still uses it. A copy of the repository you made in the scratch folder is yours to clean up the same way: remove it, or at least its `node_modules`, once its PR merges or closes, and keep only the evidence. The hourly cleanup removes the installs of a copy that sat unused for a day (docs/operations/merged-clones.md), but each one holds several gigabytes until then.
