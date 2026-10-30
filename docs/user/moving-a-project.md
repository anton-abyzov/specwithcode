# Move a project to another machine

SpecWithCode can copy a project folder from one of your machines to another and,
if you want, transfer its coordinator context and responsibility there. The copy carries the folder as
it is on disk: uncommitted edits, stashes, branches that were never pushed, new
files and ignored project data such as reports. Nothing has to be pushed to a Git
remote first.

Both machines must be in your private fleet. If they are not yet, follow
[Add a machine](./add-a-machine.md) first.

## Start a handoff

1. Open the project on the machine that has it now (the **source**).
2. Choose **Handoff** in the project header, then pick the other machine (the
   **destination**).
3. Under the file method, pick one:

| Method                                 | What happens                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Copy from &lt;source&gt;** (default) | The destination pulls the folder from the source, with uncommitted and ignored files.                         |
| **Use the folder as it is**            | The older path: committed work is pushed to Git remotes and an existing checkout on the destination advances. |
| **Clone from origin per repository**   | Like a copy, but clean repositories are cloned from their remotes instead of being copied byte for byte.      |

4. Check the source scope. When this repository belongs to a configured
   SpecWeave umbrella, the dialog offers the containing workspace and shows its
   path. You can copy that workspace or just the current project folder without
   leaving the dialog. Under **Folder on
   &lt;destination&gt;**, choose where the copy goes. The suggested path uses the
   destination machine’s home; a saved destination takes precedence. An empty
   or missing folder gets a plain copy. A folder that already holds the project
   gets a preview first; see [Copying into an existing folder](#copying-into-an-existing-folder).
5. Under **After the copy**, choose:
   - **Copy files only**: the destination gets a copy and the coordinator stays
     on the source. The copy is then linked as a member that runs workers, as in
     [Shared projects](shared-projects.md#link-two-copies). If
     the link needs a choice (project notes that differ, or a refusal), the
     dialog says why and **Link…** opens the link review.
   - **Copy and transfer coordinator context**: files copy first. The copy is
     captured the same way as **Copy files only**, so it needs temporary space
     on the source for the selected bytes. Once the source is idle, its
     coordinator context and responsibility transfer to the destination. If
     files changed on the source after the copy, the dialog lists them first;
     see [Files that change while moving](#files-that-change-while-moving). If
     work is active, the files remain copied and the dialog offers an explicit
     later retry.
6. Use **Measure the folder** in the dialog footer, check the sizes, then **Preview on
   &lt;destination&gt;**, and finally **Copy and apply on &lt;destination&gt;** (or
   **Copy and transfer context to &lt;destination&gt;**). These actions stay in the
   footer while the contents above them scroll.

The source keeps working while the copy runs. Unfinished tasks and uncommitted
edits are allowed. Active writers produce a warning because the copy is not an
atomic snapshot. Only the final coordinator-context transfer requires idle work;
it never silently stops an active provider session. If files have changed since
the copy, the dialog shows exactly which ones before the coordinator moves.

When work holds the coordinator on a machine, the dialog lists the threads that
hold it (up to 10, then a count of the rest) and why: running work, waiting for
your answer, waiting for you to sign in again, waiting for your approval, an
agent session still running, or a step still pending. Each title opens that
thread. Both the folder copy and the Git method list them, for the source and
for the destination. Answer or close each question, or stop the work, then try
again. A question still waiting for you blocks the move even when nothing runs,
because moving would drop it, so the copy step already names those threads
instead of saying work is running. Older machines name no threads and only say
that work is still running.

## When a saved comparison is out of date

For **Copy files only**, a new comparison captures the selected non-secret files
on the source before it becomes ready. Review the captured-file timestamp and
approve the comparison explicitly. Active agents can keep working: later edits,
new files and changing project logs do not invalidate these captured bytes, even
when the destination already has files. This is a per-file capture, not an atomic
snapshot of every file at one instant. If a file keeps changing while it is being
captured, the comparison fails without changing the source or destination.

**Measure again** checks the live source. Its current sizes and worktree notices
do not change the captured comparison or add newer files to it. Choose **Measure
and compare again** to capture newer work. The machine, folder and file types stay
selected; review the new comparison and choose what to keep again. Earlier
conflict choices and secret approvals are not reused against different files.
Destination edits after review still stop Apply until you review them again.

Older saved jobs, and moves from volumes the source cannot capture (network,
unknown or coarse-timestamp, or crossing a filesystem boundary), retain strict
live freshness checks. If those files changed, or
captured files are missing or damaged, the copy stops and offers **Measure and
compare again**. Reopening the dialog keeps that recovery step rather than
retrying a refused copy. Updating the source enables new captured copies; older
destination servers can consume them through the same validated transfer
protocol. Both apps should be updated to show the capture wording.

Capturing needs temporary space on the source for the selected bytes and metadata.
If space runs out, source files stay untouched; a move falls back to the live checks
above. Captured files survive an app restart
and are removed when the copy finishes or is cancelled. A paused review keeps them
until you finish or stop that copy. Secret-like files remain outside this capture
and still need their separate explicit approval.

Captured copies require a verified local filesystem: APFS, ext4, XFS, Btrfs, tmpfs,
or a local NTFS drive. The app refuses unknown, network and coarse-timestamp
filesystems instead of promising a stable capture. A folder mounted from another
filesystem must be copied separately. These checks do not create a globally atomic
filesystem snapshot.

If **Measure again** has not replied after two minutes, the dialog unlocks and keeps
your saved copy and choices. A timeout never marks the scan current or approves a
copy. After a refresh, worktree notices describe the new scan rather than combining
it with the saved list. Counts include worktrees whose names were shortened from
the preview; the list says when additional names were not included.

## Files that change while moving

Agents and logs can keep writing while a move copies. The copy uses the files as
they were when they were captured. A file that never stops changing is copied from
its last read, which may mix two versions. If it differs on the source later, the
list marks it **Copied mid-write**: the copy of it on the destination may be
incomplete.

Before the coordinator moves, the source compares its folder with the copy. When
nothing differs, the move goes ahead. When something differs, the coordinator
stays on the source and the dialog lists every path that changed: edited, new,
removed and unreadable files, approved secret files that changed after the
destination received them, folders holding a new file whose name cannot be
copied, and repositories whose commit, branches, stashes, staged changes, tags and
other refs, or Git settings and hooks moved. A file and a repository at the same
path are listed apart. You then choose one of three things:

- **Copy again**: a fresh copy brings the changes over. It compares first and
  copies only what changed.
- **Move without these N paths**: the coordinator moves now. Changed and new
  paths keep their newer version only on the source. A removed path is gone from
  the source but still in the copy on the destination; delete it there if the
  coordinator should not see it. If another path changes before the move, the
  dialog shows a new list and asks again. Closing and reopening the dialog keeps
  your choice; **Copy again** clears it. If the source is busy when you choose
  it, the list and the three choices stay for the next try.
- **Keep the coordinator on &lt;source&gt;**: the move ends and the coordinator
  stays where it is. The copied files stay on the destination.

After the move, the done screen names the paths that differ on the source from
the copy.
When it can, it splits them into the ones you chose to leave and the ones that
changed after the handoff, for example a file that a program outside SpecWithCode
wrote after the pause. Copy those paths yourself if the coordinator needs them.

Moving without the listed paths needs a captured copy. On network, unknown or
coarse-timestamp volumes the source cannot capture, and when the source has too
little temporary space to capture, the move falls back to the older live checks.
Older saved jobs work the same way, and any file the source could not read or
copy refuses them. The dialog still lists the changes, but only **Copy again**
and **Keep the coordinator on &lt;source&gt;** are offered.

The comparison skips reading a file whose size, inode and change time match the
capture. A file changed within a moment of being captured is always read again,
because some filesystems stamp changes from a coarse clock.

## Which folder moves

Copy preserves the selected source folder and its relative layout. A single
Git repository, a SpecWeave umbrella such as `repositories/<org>/<repo>`, and
custom nested repositories all use the same recursive discovery. For example,
copying `specweave-umb` includes its child repositories and root `.specweave`
context; copying only `specweave-umb/repositories/anton-abyzov/specweave` includes
only that subtree. The app never silently includes parent folders or siblings.

The umbrella choice is discovered from workspace configuration and verified
containment, even when the umbrella is not an active project in the sidebar.
Selecting it does not change the source project's registration. Its coordinator
still uses the same child repository, at the corresponding relative path inside
the destination workspace. The destination must support workspace-scoped copies.

Additional working folders outside the selected root are not silently included.
They are listed so you can copy them separately. External symbolic links stay
links, so their targets must exist separately on the destination. A selected
linked worktree whose main repository is outside the copied root becomes an
independent Git repository, preserving its branch, history, stashes and staged
changes. You can commit its unfinished work on the destination without reaching
back to the source machine.

An external worktree in the middle of a Git merge, rebase, cherry-pick or revert
must finish or abort that Git operation before it can be copied independently.
Ordinary staged and unstaged changes do not require a commit first. Worktrees
outside a copied main repository keep their branches in its history, but their
working folders must be copied separately.

## Coordinators on different machines

Each linked machine can have its own coordinator, conversation and local
execution. Viewing another machine’s coordinator just changes what you see.
Copying files does not migrate running threads or provider sessions.

Transferring coordinator context is a deliberate continuation of one coordinator
assignment: the destination receives project goal, instructions, memory and
retained conversation context, and creates a new local coordinator. The source
binding becomes read-only so that assignment does not continue in two places.
Provider credentials and running processes stay on their original machines.
Moving individual running threads is the separate thread-handoff workflow.

### What a coordinator handoff carries

A coordinator handoff carries the project goal, instructions and memory notes,
and the conversation up to 2 MB. When every chat of the project fits, the
coordinator and each worker chat move with their full message history, as
before.

A larger project, such as an umbrella with more than 100 chats, carries less:

- **The coordinator's newest history.** Messages are kept from the newest back
  until the 2 MB limit, at most 2,000 per chat. Older messages stay on the
  source machine. If the newest message is too large by itself, it is shortened
  and its full text stays on the source.
- **A summary of the worker chats.** Their transcripts stay on the source. Up to
  200 of the most recent workers are listed, active ones first. Each entry gives
  the title, branch, status, last activity and the start of the last message.
  The others are counted.
- **A count of what stayed.** The context file the new coordinator reads says
  how many older messages and worker chats stayed behind, so it can tell you
  where to look. Open the project on the source machine to read a worker's
  full history.

The review says so before anything moves, for example _the latest 412 of
9,830 coordinator messages and a summary of 200 of 1,628 worker chats_. When
the move is done, the copy screen names what stayed on the source.

After an earlier summarized handoff, some older messages and worker chats are
on the machine they were written on, which can be the destination. The review
and the copy screen then say they stay on the machines they were written on,
and each machine's chats are counted once.

A worker's branch or worktree exists on the destination only if the copy or
the published commits include it. Over Git, the review lists each worker whose
branch or worktree has commits or changes the push does not include; that work
stays only on the source until you merge it. A worktree that cannot be checked,
such as one past the first 100 still on disk or one too large to scan, is listed
too. The move does not wait for them, but a worker
that gains such commits after the review stops the move as a changed source. Workers still have to be idle before the
coordinator moves: running work on the source holds the move until it
finishes.

Only an up-to-date destination can read this summary. When the destination
runs an older SpecWithCode, a large project's move stops with _Update the
other machine to move the coordinator of a project this large_. Nothing moves
and the coordinator stays on the source. A small project still moves to an
older destination. Update both machines and the app you drive the move from.
An older app cannot confirm that the destination reads the summary, so the
source refuses its move before anything moves.

## What is copied

| Class                    | Default | Notes                                                                     |
| ------------------------ | ------- | ------------------------------------------------------------------------- |
| **Repository data**      | Yes     | History, branches, stashes, linked worktrees and nested repositories.     |
| **Tracked files**        | Yes     | Including edits you have not committed.                                   |
| **New files**            | Yes     | Files Git does not track yet.                                             |
| **Ignored project data** | Yes     | Ignored files that are not rebuilt, such as reports and evidence.         |
| **Rebuildable folders**  | No      | `node_modules`, build output and caches. Rebuild them on the destination. |
| **Secret-like files**    | Never   | `.env*`, keys and similar files. You can send chosen ones, see below.     |

Symbolic links stay links, file modes are kept, and linked worktrees keep their
branch when their main repository is also copied. A link that points outside
the project folder is shown in the preview.

The destination pulls the files from the source's private Tailscale address
first, and falls back to its SpecWithCode Connect address, so either route is
enough. It uses the Connect address only after it answers as the source
machine. The source
only answers requests that carry a grant for this one copy, and the grant ends
when the copy ends. Every file is checked against the source's checksum before it
is used.

For older saved jobs, and for moves from volumes the source cannot capture,
files that change during transfer are retried. Files that
keep changing or disappear are listed and skipped during Apply. New files created
after the scan may be absent. Review the warnings and copy again after work
settles when you need a complete snapshot. An incomplete or stale copy cannot be used to transfer
coordinator responsibility.

## Copying into an existing folder

When the destination folder already has files, nothing is changed until you
approve the preview. Each repository and folder gets a status:

| Status            | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| **Same on both**  | Nothing to do.                                                      |
| **Fast-forwards** | The destination is behind and moves forward to the source.          |
| **Ahead here**    | The destination has newer commits. They are kept.                   |
| **Diverged**      | Both sides have commits the other lacks.                            |
| **Changed here**  | The destination has uncommitted edits that the copy does not touch. |
| **Conflicts**     | The same file was edited on both sides. You choose what happens.    |
| **New here**      | The repository or folder exists only on the source and is added.    |
| **Only here**     | It exists only on the destination and is left alone.                |

Branches that cannot fast-forward are never overwritten. They arrive next to
yours as `swc/from-<machine>/<branch>`, so you can merge them when you are ready.

For each conflict, pick one:

- **Keep this machine's version**
- **Take the source version (back up this one)**
- **Leave both untouched**
- **Keep both (source copy beside it)**: the source file is written next to
  yours as `<name>.from-<machine>`.

## Undo a copy

After **Copy files only** finishes, choose **Undo…** to see what Undo would
restore. Files and branches go back to how they were before Apply. If you edited
a file after the copy, Undo lists it and keeps your edit aside unless you confirm.
Undo restores the folder only; the link stays until you unlink the copy in
**Settings > Machines**.

Undo works for 14 days. The backups it uses live in
`<state folder>/machine-handoffs/folder-copies/<operation>/backups` on the
destination and are removed after 14 days; after that the copy can no longer be
undone. Branch backups under `refs/swc-backup/<operation>/` stay in the
repositories until you delete them.

## Secret files

Secret-like files (`.env*`, private keys, credential files) are left out of the
copy. When the folder has some, the preview lists them under **Secret files**,
none ticked. Tick the ones the destination needs and confirm that you want them
sent. On **Apply** they travel over the same private channel as the copy and are
written readable only by you (mode `0600`). If the destination already has a
different file at that path, the received one is saved beside it with a
`.from-<machine>` name, and the done screen says which.

The source keeps a list of which files went to which machine, with names and
sizes only, never their contents. **Undo** removes the secret files the copy
wrote.

When you take a machine off the list with `specwithcode fleet remove <name>`,
the command lists the secret files sent to it and reminds you to rotate those
credentials.

## Sign in on the destination

Provider sign-ins (Claude, Codex, Copilot and others) are never copied. They are
stored by each provider's own tool and tied to the machine, and copying them
would put long-lived tokens on a second disk without you choosing it.

After a copy finishes, the done screen shows the destination's readiness
checklist: whether the project folder is there, whether Git and each enabled
provider work, and whether each provider is signed in. **Sign in on <machine>**
opens the provider sign-in for that machine. You can open the same checklist any
time from **Settings > Connections**, with **Check readiness** on a machine card.
A machine that runs an older SpecWithCode shows as not checkable; update it
first.

## Interruptions and refusals

- **Active work.** Measurement and copying continue with a warning. A busy
  coordinator-context transfer waits for an explicit retry; copied files stay
  in place.

- **Network drops or a restart.** The copy resumes where it stopped when the
  destination starts again. Files already checked are not sent again.
- **Not enough disk space.** Before anything is written, the destination
  compares the space it needs with the space it has, and refuses with both
  numbers, for example _The copy needs 18.2 GB free here and 9.4 GB is
  available._
- **Cancel before Apply.** **Cancel copy** removes the partial copy and releases
  the source. Nothing in the destination folder changes.
- **An older SpecWithCode on the source.** The copy stops with _The source
  machine runs an older SpecWithCode without folder copy. Update it first._
  Update the source, or use **Use the folder as it is**.
- **File names that differ only by case.** macOS folders usually treat
  `Readme.md` and `README.md` as the same file. The preview warns about each
  pair and the destination keeps the first one.

### Refresh a saved copy scan

Closing and reopening the dialog resumes its saved copy, including its selections and conflict choices. The scan time is shown above the counts; older scans without a timestamp say that their age is unknown. **Refresh scan** checks the current source without cancelling or applying the job. Missing worktree registrations are labelled separately and are not counted as current folders. Refresh never prunes Git registrations or deletes folders.

If the source changed, choose **Measure and compare again** to explicitly replace the old comparison. The machine, folder and file classes stay selected; review conflicts again and confirm any secret files separately. Copy approval validates the current source inventory and destination comparison before transferring. A changed or unverifiable old scan is refused.
