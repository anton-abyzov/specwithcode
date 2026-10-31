# Workspaces, branches and storage

## Projects, repositories and folders

A project is the identity of the work — a product, an initiative, a body of intent. It spans repositories and machines; it is not a folder. A repository is where code is versioned: work lands as a branch and a pull request into that repository's own trunk. There is no branch that spans repositories and no lockstep merging across them. The increment and its threads coordinate the work; each repository merges on its own evidence.

How checkouts sit on disk is a local arrangement, never a structure SpecWithCode imposes. All of these work:

- **One checkout.** The project folder is a single Git repository.
- **Several checkouts, wherever they live.** Sibling folders, service clones in different places, checkouts other tools made. The project lists its repositories by path or URL, and existing checkouts are matched where they are.
- **An umbrella folder.** One folder holding clones of several repositories, for example under `repositories/<owner>/<repo>`. This is the layout SpecWithCode uses when it prepares a new checkout for you, and how multi-repository products such as EasyChamp (its service repositories behind one product) and SpecWeave itself (the framework and this app) sit on our machines. It is a working example, not a requirement: renaming the folder, nesting differently, or not nesting at all changes nothing about how threads run.

SpecWithCode only *detects* the layout, to give advice. What matters to behavior is whether the folder holds clones of other repositories — anywhere inside it, not only under a `repositories/` folder — because a worktree of such a folder would hold none of their code.

## Where new threads start

Worktrees are optional, and the choice belongs to each project. New threads start in the project's current checkout. Turn on **Settings → Project → New threads → Use worktrees** for a project to give its new threads their own worktree instead. There is no machine-wide workspace default above the project. A repository can check the same preference in for everyone who opens it:

```json
{ "defaultThreadEnvMode": "worktree" }
```

The project's own setting wins over `specweave-studio.json`. An explicit choice for one thread — the composer's **Use worktree** tick, starting from a branch, a launch's `workspaceStrategy`, a scheduled task's stored strategy — wins over both. An agent that needs an isolated copy of another repository can clone it into a sibling folder itself; the platform does not pre-create worktrees for every repository a project touches.

Use the current checkout for one writer working sequentially. Use separate worktrees for simultaneous code-writing threads on different branches. Two local threads see the same files, index and checked-out branch; selecting Local does not isolate their edits. Reusing an existing worktree avoids another checkout but also shares its files with any thread still using it.

## What consumes space

A linked Git worktree shares the repository's Git object database. It is not another full clone of Git history. Each worktree still has its own checked-out files, dependencies, build output and caches. Dependencies can be much larger than the source tree. Git branches themselves are small references; deleting a branch usually saves little disk space.

**Settings → Storage** lets you choose another worktree location, including a mounted external drive, and enable cleanup rules. Existing checkouts are not automatically moved. SpecWithCode does not currently display a complete per-worktree byte inventory or impose a disk budget.

## Getting the latest changes

Background refresh fetches remote refs; it never updates the checkout or index. **Refresh upstreams at startup** controls the optional startup fetch. Its saved configuration key remains `defaultAutoPull` for compatibility. Regular source-control polling also refreshes remote information.

Use **Pull** to update the current branch. SpecWithCode uses fast-forward-only pull: it does not create an implicit merge commit, reset local work or resolve divergence automatically. If the branch has diverged, inspect the commits and explicitly merge or rebase with the coding agent or Git, then run the relevant tests before publishing or merging a PR. A clean working tree does not prove another agent has stopped using it.

New worktrees normally fetch and start from the selected remote base when **Start from origin** is enabled. Local-only repositories can start from a local ref. The chosen ref matters: SpecWithCode does not merge every branch or decide that unrelated work belongs together.

Remote status is a periodically cached view. An unavailable remote can leave old divergence counts visible; those counts are not proof that the latest fetch succeeded. This release's background fetch-only policy prevents those cached counts from automatically changing checkout files. Refresh and confirm the remote before an integration decision.

## Consolidating completed work

Finish and commit the branch's intended changes, review the diff, run its checks, and merge the intended PR or branch into its target. Confirm the result on the remote. Update the target checkout explicitly when its writers are stopped. Reclaim the completed worktree only after its work is retained and no session still needs the folder.

SpecWithCode's PR controls perform explicit merge/update operations and check the host's merge result. They do not act as a universal cross-provider branch merger or resolve conflicts without review. External Claude Code/Codex worktrees remain outside SpecWithCode's automatic cleanup unless they are managed and linked to SpecWithCode threads.

## Cleanup safeguards

Worktree cleanup is opt-in. Scheduled cleanup considers only linked worktrees under managed storage locations. It preserves project roots, shared checkouts, live or queued work, retained native sessions, terminals, dirty or untracked changes, and valuable ignored data. Reproducible `node_modules` folders are the only ignored-content exception in scheduled cleanup. Build output or ignored local data can therefore keep a worktree on disk.

Merged-worktree cleanup fetches the default branch before checking integration. Ordinary merges use commit ancestry. For squash/rebase merges it additionally requires a merged PR and proves that merging the exact feature HEAD would add no content to the fetched default commit. Conflicts, missing commits, unsupported Git operations and additional work keep the checkout. The branch reference is retained when the checkout is removed, so its commit history remains available.

Explicit worktree removal also checks authoritative server records and filesystem state. A client request to force deletion does not bypass these checks. If another active or archived thread, native session, terminal, or project still refers to the folder, preserve it and resolve that ownership first. SpecWithCode cannot lock arbitrary external processes or editors; stop their use before requesting removal.

Deleting or archiving a chat, merging a PR, removing its checkout and deleting a branch are separate operations. SpecWithCode does not assume that one authorizes all the others.
