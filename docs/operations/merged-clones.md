# Merged review and scratch clones

With worktrees off, agents clone a project's repository to review or verify a pull request. Those clones used to stay after the pull request merged: 16 were removed by hand on one machine (9.7 GiB), one of them inside a project root where the search index walked it. SpecWithCode now removes them itself.

## What is looked at

Git clones at most three folders below these roots, whose `origin` is a registered project's repository (remote spellings are compared normalized):

- `<home>/scratch`
- the system temp folders
- `<project root>/scratch` and `<project root>/.artifacts` of every registered project

Symlinks are not entered, `node_modules` is skipped and a clone's inside is not searched.

## When a clone is removed

Only when all of these hold. Anything else, and anything that cannot be read, keeps the clone, and the reason is listed.

| Check                     | How                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Its work is merged        | `HEAD` is contained in the remote default branch, or `gh pr list --state merged` finds a pull request for its branch with the same head commit. Without `gh` only the first rule counts. |
| The working tree is clean | `git status --porcelain` is empty. Untracked files count as dirty; ignored files do not.                                                                                                 |
| Nothing is unpushed       | `git log --branches --not --remotes` is empty, and so is `git stash list`.                                                                                                               |
| Nobody is bound to it     | No project, non-archived thread, live agent session or live terminal uses the folder or a folder inside it. The projects' own checkouts are never candidates.                            |
| No process uses it        | No process has its working folder inside it (`lsof -d cwd`, `/proc` on Linux) or a file open in it. If that cannot be read, every clone is kept.                                         |
| It has been idle          | `.git/HEAD`, the index and the fetch and reflog files are older than the grace period, 2 hours by default.                                                                               |

Every check runs again right before each removal. Only the clone's folder goes, plus its dated parent folder (`2026-11-01-review`) when the clone was the only entry. Symlinks inside the clone are unlinked, never followed.

A linked worktree (`.git` is a file) is kept. A source tree without `.git` whose `package.json` name matches a registered repository is reported and never removed.

## Dependency installs of copies that stay

A copy the sweep leaves in place can still hold several gigabytes of dependency installs. Builds made outside the checkout leave source trees without `.git`, which are never removed, and a clone with untracked notes is kept for good. On one machine 30 such copies of one repository were most of a 173 GB app folder.

So a kept clone of a registered repository, a clone with no origin or another one whose `package.json` name is a registered repository's, and a source tree without `.git`, loses its `node_modules` folders once it sat unused for a day. Every other file stays exactly as it was, and `pnpm install` brings the installs back.

| Check                 | How                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| It is an install      | A real folder named `node_modules` beside a `package.json`, at most four folders below the copy, that a package manager wrote and can write again: the copy has a lockfile, and the folder holds the manager's state file (`.modules.yaml`, `.package-lock.json`, `.yarn-integrity`) or only links into a root install that has one. A symlinked `node_modules`, one made by hand and, in a clone, one with a tracked file in it are left. |
| Nobody is bound to it | No project, non-archived thread, live agent session or live terminal uses the copy, a folder inside it, or a folder around it below the scan root (a thread working in the dated folder uses the copy in it too).                                                                                                                                                                                                                          |
| No process uses it    | As for clones: no working folder inside it and no file open in it. If that cannot be read, the installs stay.                                                                                                                                                                                                                                                                                                                              |
| Nothing changed in it | No file or folder outside the installs changed for 24 hours, by the newer of its modification and status-change times, and no install finished in that time (`.modules.yaml`, `.package-lock.json`, `.yarn-integrity`).                                                                                                                                                                                                                    |

The checks run again right before the installs go. A copy with more than 200,000 entries outside its installs, or with anything that cannot be read, keeps them. A clone whose origin and `package.json` name are no registered repository's is not looked at, and neither is a linked worktree.

The plan lists these under the copy's own line, as `would go`, `prune` or `keep` with the number of installs and the reason. The running service logs `merged clone sweep dependencies pruned`, `skipped` or `failed`. The same setting turns both off.

When you finish with a copy you made yourself, do not wait for this: remove the copy, or at least its `node_modules`, once its pull request merged.

## Running it

```sh
specweave-studio clones sweep            # prints the plan, removes nothing
specweave-studio clones sweep --apply    # removes what the plan lists
```

Flags: `--grace 2h` (at least `10m`), `--root DIR` (look only there), `--no-pull-requests` (do not ask `gh`), `--json`, `--base-dir DIR`.

Exit codes: 0 done, 1 some clone could not be removed, 2 refused (no readable database, bad flag). Nothing is removed on 2.

The running service does the same sweep at most once an hour, starting five minutes after it starts, and logs one line per clone: `merged clone sweep removed`, `skipped`, `failed` or `kept`, with the path and the reason. It skips the sweep while another instance shares the app's home. Turn it off per machine with `"storageCleanup": { "removeMergedClones": false }` in `settings.json`; it is on by default.
