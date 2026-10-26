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
   - **Copy and transfer coordinator context**: files copy first. Once the source
     is idle and its copied snapshot is still current, its coordinator context
     and responsibility transfer to the destination. If work is active, the
     files remain copied and the dialog offers an explicit later retry.
6. Use **Measure the folder** in the dialog footer, check the sizes, then **Preview on
   &lt;destination&gt;**, and finally **Copy and apply on &lt;destination&gt;** (or
   **Copy and transfer context to &lt;destination&gt;**). These actions stay in the
   footer while the contents above them scroll.

The source keeps working while the copy runs. Unfinished tasks and uncommitted
edits are allowed. Active writers produce a warning because the copy is not an
atomic snapshot. Only the final coordinator-context transfer requires idle work;
it never silently stops an active provider session. If files have changed since
the copied snapshot, copy again before transferring context.

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

The destination pulls the files over your machines' private Tailscale addresses,
so for now copying a folder to another machine needs Tailscale on both. The source
only answers requests that carry a grant for this one copy, and the grant ends
when the copy ends. Every file is checked against the source's checksum before it
is used.

Files that change during transfer are retried. Files that keep changing or
disappear are listed and skipped during Apply. New files created after the scan
may be absent. Review the warnings and copy again after work settles when you
need a complete snapshot. An incomplete or stale copy cannot be used to transfer
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
