# A missing thread folder

A thread that works in its own worktree records two things: the folder path and the branch. If the folder disappears, the thread can't run until the folder is back or the thread moves.

## Symptom

Sending a message fails at once and the queue is held. The banner reads **Thread folder is missing**, with a message like:

> This thread's workspace folder no longer exists or is not a directory: /Users/me/.specwithcode/m4/worktrees/specweave-studio/fix-1041-design-create-reuse. Restore the folder at this path before retrying; switching models will fail the same way.

The timeline row is titled **Thread folder is missing**, or **Thread folder was deleted** when the branch is gone too. Versions before this change titled the banner "Provider error" and offered Switch model, which can't help: every model runs in the same folder.

## Why it happens

The folder was removed outside the app. Typical causes are a manual `rm -rf` or `git worktree remove`, a disk cleanup, or a script that cleans up merged worktrees. The thread still points at the old path.

## What the app does on its own

Before every turn, when the thread has a folder path and a branch and the folder is missing, the app recreates it:

1. It finds the repository that owns the folder. It tries, in order:
   - the repository of the other checkouts in the same parent folder, when they all belong to one repository;
   - the project's main folder;
   - the other repositories in that parent folder, when it holds checkouts of several;
   - a folder next to the project's main folder named like the parent folder (the `<worktrees>/<repo>/<branch>` layout).
     A repository that was moved or deleted since, or a folder that holds no repository, is skipped.
2. In each repository it runs `git worktree prune`, then `git worktree add <path> <branch>`. It moves to the next repository only when that one does not have the branch.
3. It never recreates the folder from another branch.

A folder whose branch exists in none of those repositories can't be recreated. When the folder sits in one of those repositories' own worktrees folder, the run settles as **Thread folder was deleted** and explains how to restore the branch. Otherwise it settles as **Thread folder is missing**. A git failure for another reason (a lock, a branch checked out elsewhere) keeps the normal start retries.

## The banner actions

The banner and the failed timeline row offer these instead of Continue and Switch model:

| Action                                  | What it does                                                                                                                                             | Use it when                                                                                                                                        |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Recreate folder from &lt;branch&gt;** | Runs the same restore as above, on demand, then releases the held queue. Shown only when the branch may still exist and you can write to source control. | The folder was deleted but the branch is still there, for example after a cleanup.                                                                 |
| **Use the project folder**              | Points the thread at the project's main folder (its name is in the button's tooltip) and releases the held queue. The branch setting stays as it was.    | The branch is gone, or you want to continue in the main checkout. The thread then edits the main folder, so check which branch it has checked out. |
| **Resolve thread**                      | Resolves the thread, as Resolve does elsewhere.                                                                                                          | The work is finished or no longer needed.                                                                                                          |

If a file sits at the folder's path, **Recreate folder** says so instead: move the file, then try again. For a coordinator thread, releasing the queue keeps queued requests on their own model, as **Resume** does.

The failed message never reached a model. After a repair, send it again.

## Manual recovery from a shell

Use this when the app is not running, or to repair many threads at once.

1. List which folders open threads use. Never open `statev2.sqlite` yourself, not even read-only; see [The live database](./live-database.md).

   ```sh
   specweave-studio db query "SELECT thread_id, title, json_extract(payload_json,'$.worktreePath') AS path, json_extract(payload_json,'$.branch') AS branch FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL AND archived_at IS NULL"
   ```

2. Find the repository that owns a missing folder. A surviving checkout in the same parent folder names it in its `.git` file:

   ```sh
   cat <parent>/<other-checkout>/.git          # gitdir: <repo>/.git/worktrees/<name>
   git -C <repo> branch --list <branch>        # the branch must exist here
   ```

   For the `<worktrees>/<repo>/<branch>` layout, `<repo>` is usually a checkout with that name next to the project's main folder.

3. Recreate the folder at the exact recorded path:

   ```sh
   git -C <repo> worktree prune
   git -C <repo> worktree add <path> <branch>
   ```

4. If the branch is gone too, recreate it at the commit it was on first (from `git -C <repo> reflog`, the pull request, or a remote), then add the worktree:

   ```sh
   git -C <repo> branch <branch> <commit>
   ```

Then open the thread and send the message again. If the queue stays held, use **Resume** on the queue.

## Rule for any cleanup

Any cleanup of worktrees, by hand or by script, must skip folders bound to open threads. Run the query above first and leave every listed path in place. Keep their branches too: the app rebuilds a missing folder only from its own branch.
