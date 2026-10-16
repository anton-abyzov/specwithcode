# File links in reports

Workers rarely run in the thread's workspace. A delegated worker usually builds in a sibling worktree (`../specweave-wt-code-captures`, `~/Projects/github/studio-machine-label`) or a scratch folder (`/tmp/studio-machine-label`). Its report names files relative to wherever it was working, while the chat used to resolve every path against the thread's workspace. Two reports show what went wrong:

- **specweave-wt-code-captures.** `../specweave-wt-code-captures` was joined to the workspace without collapsing the `..`, so it read as a folder inside the workspace. The Files panel then refused it with "outside the workspace". The provenance file `docs-site/static/img/studio/coordinator-capture-source.md` lives in that worktree, not in the workspace.
- **Machine name in thread list.** Three chips failed:
  - `CoordinatorConversation.tsx:615` is a bare file name. The worker meant `~/Projects/github/studio-machine-label/apps/web/src/components/studio/CoordinatorConversation.tsx`, but the chip opened `<workspace>/CoordinatorConversation.tsx`, and the reader showed only "Failed to read workspace file".
  - `machine-label-1440-dark.png` follows an absolute `/tmp/studio-machine-label/...png` "in the same folder", and also failed.
  - `apps/web/tests/project-workspace/machine-label-check.mjs` is relative to the worktree the report named.

## Options

| Option                                                                                   | Fixes old messages                  | Works for every provider                          | Cost                                           | Weakness                                                                             |
| ---------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| A. Workers write absolute paths (prompt and skill)                                       | No                                  | Mostly; models drift                              | Low                                            | Old reports stay broken, and nothing checks it                                       |
| B. The app records each run's cwd, worktree and touched files, and resolves against them | Only runs recorded after the change | Only where the harness reports cwd and file edits | High: provider events, storage, migration      | Delegated workers `cd` into worktrees themselves, so the thread's cwd is still wrong |
| C. Per-message base folders inferred from the report itself                              | Yes                                 | Yes                                               | Low, all client-side                           | Needs the report to name the folder once (most do)                                   |
| D. Search fallback in the known roots by file name                                       | Yes                                 | Yes                                               | Medium: one indexed search per unresolved chip | Slower, and a common name can match many files                                       |
| E. Check on the host which candidate exists                                              | Yes                                 | Yes                                               | Low: one cached directory listing per chip     | None alone, but it needs candidates to check                                         |

## Decision

Use C + E + D, and add A as a prompt rule. Leave B for later.

1. **C: candidates from the message.** Every path that is not absolute resolves against these bases, most likely first:
   - a base matched by first segment (`png/...` where an absolute path contains `/png/`);
   - folders the message names outside the workspace (`../specweave-wt-code-captures`, `~/Projects/github/studio-machine-label`);
   - the folders of absolute files it names (`/tmp/studio-machine-label`);
   - the workspace, last.

   A `..` is folded when joining, so a sibling worktree never reads as inside the workspace.

2. **E: the host decides.** The chip lists each candidate's parent folder on the host and takes the first that exists. The same listing says whether an extensionless path is a folder.
3. **D: search when nothing exists.** The chip searches the same roots' file index for the file name and takes the match whose path ends with what the report wrote. `CoordinatorConversation.tsx:615` becomes `<worktree>/apps/web/src/components/studio/CoordinatorConversation.tsx` at line 615.
4. **A: prompt rule.** The worker report instructions now ask for absolute paths (`~/...` is fine), so a report needs none of this.
5. **B, later.** Recording each run's cwd from provider events would cover a report that names no folder at all. It needs provider support and storage, so it is out of this change.

## What each target opens

| Target                                                            | Opens in                                                                                                                  | When it cannot be found                                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Text or code, with or without `:line`                             | The read-only viewer at that line (in the report reader, its file pane), with **Open in editor** and **Reveal in Finder** | The viewer lists every path it tried, with **Open in editor** and **Reveal in Finder** on the most likely one |
| Folder (trailing `/`, or extensionless and confirmed by the host) | Finder, through the host's file manager. Without shell access, its path is copied                                         | Finder, on the authored path                                                                                  |
| Image or video                                                    | The media gallery, with the full path and a copy button                                                                   | The gallery shows that the image failed to load and gives its path                                            |
| Markdown                                                          | The docked reader, with outline and toolbar, reading the file by its host path                                            | The reader says why and offers **Open with the default app**                                                  |

No chip leads to a dead end: if a path can't be resolved, the viewer shows the candidates and gives a way out.
