# Workspaces, branches and storage

Worktrees are optional. Choose **Settings → General → New threads → Workspace → Current checkout** to run new threads in the existing project folder. Set it for the environment or override it for one project. The workspace menu on a new thread also offers **Current checkout**, **New worktree**, and **Previous worktree**.

**Automatic** uses a new worktree for Git projects and the current folder for non-Git projects. An explicit per-project setting takes precedence over `specweave-studio.json`, which takes precedence over the environment default. To share a repository preference, use:

```json
{ "defaultThreadEnvMode": "local" }
```

Use the current checkout for one writer working sequentially. Use separate worktrees for simultaneous code-writing threads on different branches. Two local threads see the same files, index and checked-out branch; selecting Local does not isolate their edits. Reusing an existing worktree avoids another checkout but also shares its files with any thread still using it.

## What consumes space

A linked Git worktree shares the repository's Git object database. It is not another full clone of Git history. Each worktree still has its own checked-out files, dependencies, build output and caches. Dependencies can be much larger than the source tree. Git branches themselves are small references; deleting a branch usually saves little disk space.

**Settings → Storage** lets you choose another worktree location, including a mounted external drive, and enable cleanup rules. Existing checkouts are not automatically moved. Studio does not currently display a complete per-worktree byte inventory or impose a disk budget.

## Getting the latest changes

Background refresh fetches remote refs; it never updates the checkout or index. **Refresh upstreams at startup** controls the optional startup fetch. Its saved configuration key remains `defaultAutoPull` for compatibility. Regular source-control polling also refreshes remote information.

Use **Pull** to update the current branch. Studio uses fast-forward-only pull: it does not create an implicit merge commit, reset local work or resolve divergence automatically. If the branch has diverged, inspect the commits and explicitly merge or rebase with the coding agent or Git, then run the relevant tests before publishing or merging a PR. A clean working tree does not prove another agent has stopped using it.

New worktrees normally fetch and start from the selected remote base when **Start from origin** is enabled. Local-only repositories can start from a local ref. The chosen ref matters: Studio does not merge every branch or decide that unrelated work belongs together.

Remote status is a periodically cached view. An unavailable remote can leave old divergence counts visible; those counts are not proof that the latest fetch succeeded. This release's background fetch-only policy prevents those cached counts from automatically changing checkout files. Refresh and confirm the remote before an integration decision.

## Consolidating completed work

Finish and commit the branch's intended changes, review the diff, run its checks, and merge the intended PR or branch into its target. Confirm the result on the remote. Update the target checkout explicitly when its writers are stopped. Reclaim the completed worktree only after its work is retained and no session still needs the folder.

Studio's PR controls perform explicit merge/update operations and check the host's merge result. They do not act as a universal cross-provider branch merger or resolve conflicts without review. External Claude Code/Codex worktrees remain outside Studio's automatic cleanup unless they are managed and linked to Studio threads.

## Cleanup safeguards

Worktree cleanup is opt-in. Scheduled cleanup considers only linked worktrees under managed storage locations. It preserves project roots, shared checkouts, live or queued work, retained native sessions, terminals, dirty or untracked changes, and valuable ignored data. Reproducible `node_modules` folders are the only ignored-content exception in scheduled cleanup. Build output or ignored local data can therefore keep a worktree on disk.

Merged-worktree cleanup fetches the default branch before checking integration. Ordinary merges use commit ancestry. For squash/rebase merges it additionally requires a merged PR and proves that merging the exact feature HEAD would add no content to the fetched default commit. Conflicts, missing commits, unsupported Git operations and additional work keep the checkout. The branch reference is retained when the checkout is removed, so its commit history remains available.

Explicit worktree removal also checks authoritative server records and filesystem state. A client request to force deletion does not bypass these checks. If another active or archived thread, native session, terminal, or project still refers to the folder, preserve it and resolve that ownership first. Studio cannot lock arbitrary external processes or editors; stop their use before requesting removal.

Deleting or archiving a chat, merging a PR, removing its checkout and deleting a branch are separate operations. Studio does not assume that one authorizes all the others.
