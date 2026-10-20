# Move a project to another machine

SpecWithCode can copy a project folder from one of your machines to another and,
if you want, move the project's coordinator there. The copy carries the folder as
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

4. Under **Folder on &lt;destination&gt;**, choose where the copy goes. An empty
   or missing folder gets a plain copy. A folder that already holds the project
   gets a preview first; see [Copying into an existing folder](#copying-into-an-existing-folder).
5. Under **After the copy**, choose:
   - **Copy files only**: the destination gets a copy and the coordinator stays
     on the source. The copy is then linked as a member that runs workers, as in
     [Shared projects](shared-projects.md#link-two-copies). If
     the link needs a choice (project notes that differ, or a refusal), the
     dialog says why and **Link…** opens the link review.
   - **Copy and move the coordinator here**: once the files are in place, the
     coordinator stops on the source and continues on the destination.
6. Choose **Measure the folder**, check the sizes, then **Preview on
   &lt;destination&gt;**, and finally **Copy and apply on &lt;destination&gt;** (or
   **Copy, apply and move to &lt;destination&gt;**).

The source keeps working while the copy runs. Its coordinator is only paused for
the short final step of a move.

## What is copied

| Class                    | Default | Notes                                                                     |
| ------------------------ | ------- | ------------------------------------------------------------------------- |
| **Repository data**      | Yes     | History, branches, stashes, linked worktrees and nested repositories.     |
| **Tracked files**        | Yes     | Including edits you have not committed.                                   |
| **New files**            | Yes     | Files Git does not track yet.                                             |
| **Ignored project data** | Yes     | Ignored files that are not rebuilt, such as reports and evidence.         |
| **Rebuildable folders**  | No      | `node_modules`, build output and caches. Rebuild them on the destination. |
| **Secret-like files**    | Never   | `.env*`, keys and similar files. They are handled in a separate step.     |

Symbolic links stay links, file modes are kept, and linked worktrees keep their
branch. A link that points outside the project folder is shown in the preview.

The destination pulls the files over your private Tailscale addresses. The source
only answers requests that carry a grant for this one copy, and the grant ends
when the copy ends. Every file is checked against the source's checksum before it
is used.

If a file keeps changing while it is read (a log being written, for example),
the copy takes the last version it read and lists the file in the preview, so you
can decide whether that matters.

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

## Interruptions and refusals

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
