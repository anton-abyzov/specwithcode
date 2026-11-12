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

## Running it

```sh
specweave-studio clones sweep            # prints the plan, removes nothing
specweave-studio clones sweep --apply    # removes what the plan lists
```

Flags: `--grace 2h` (at least `10m`), `--root DIR` (look only there), `--no-pull-requests` (do not ask `gh`), `--json`, `--base-dir DIR`.

Exit codes: 0 done, 1 some clone could not be removed, 2 refused (no readable database, bad flag). Nothing is removed on 2.

The running service does the same sweep at most once an hour, starting five minutes after it starts, and logs one line per clone: `merged clone sweep removed`, `skipped`, `failed` or `kept`, with the path and the reason. It skips the sweep while another instance shares the app's home. Turn it off per machine with `"storageCleanup": { "removeMergedClones": false }` in `settings.json`; it is on by default.
