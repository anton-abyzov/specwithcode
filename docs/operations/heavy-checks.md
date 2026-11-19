# Heavy checks: one at a time, in one copy

Full lint, typecheck and test suites use every core. When four agent threads ran them at once, each in its own clone of the repository, a 16-core machine reached a load average of 54 and kept 27 clones (13 with their own `node_modules`) from one week. SpecWithCode now gives agents one gate and one copy per machine.

## Commands

| Command                                                                           | What it does                                                                                                          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `specweave-studio checks run [--label TEXT] [--wait-timeout 10m] -- <command...>` | Takes the machine-wide gate, runs the command with this terminal's input and output, releases the gate when it exits. |
| `specweave-studio checks status [--json]`                                         | Prints who holds the gate and who waits, in order.                                                                    |
| `specweave-studio checks copy <path-or-url> [--ref REF] [--base-dir DIR]`         | Prints the path of the repository's one verification copy, moved to `REF`.                                            |

A typical full run:

```sh
copy=$(specweave-studio checks copy . --ref HEAD)
cd "$copy" && specweave-studio checks run --label "server tests" -- pnpm test
```

Single-file and other focused checks do not need the gate.

## The gate

The lock is the file `~/.specwithcode/locks/heavy-checks.lock`. It sits in the default home's folder whatever `STUDIO_HOME` or `--base-dir` says, so every app instance and every project on the machine shares it. `STUDIO_HEAVY_CHECKS_DIR` moves it (tests).

The file records the holder: PID and process start time, the PID of the command it started, host, label, command, working folder, thread (from `SPECWEAVE_STUDIO_THREAD_ID`) and when it was taken. It is created by hard-linking a complete temporary file, which fails if the lock exists, so it is never taken by reading and then writing.

Callers that find it taken queue as ticket files in `heavy-checks.queue` beside it and are served in arrival order. A waiting caller prints who holds the gate and since when, then one line every 30 seconds, on stderr.

A holder is dead when neither its own process nor the command it started runs. A PID that now belongs to another process (its start time differs) counts as gone. The next caller in line takes a dead holder's lock over.

A `checks run` started from inside a command that already runs under the gate runs directly. The gate passes `STUDIO_HEAVY_CHECKS_LOCK_ID` to its command for this.

Signals (`SIGINT`, `SIGTERM`, `SIGHUP`) go to the command; the gate is released when it exits.

### Exit codes of `checks run`

| Code              | Meaning                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| the command's own | The command ran. A command ended by a signal gives 128 plus the signal number. |
| 75                | `--wait-timeout` passed before the gate was free. The command did not run.     |
| 127               | The command could not be started.                                              |
| 2                 | A flag was wrong. Nothing ran.                                                 |

## The verification copy

`checks copy` keeps one copy per repository in the app's home, at `<home>/verify/<repository name>` (`<home>` is `STUDIO_HOME`, which is already per machine). On first use it clones the given checkout locally, which hard-links its objects instead of copying history, and leaves out `.repos/` when the repository has one. Each call fetches the requested commit and checks it out detached. A local path is fetched through that path, so commits that were never pushed work.

Dependencies are installed only when the lockfile's hash differs from the one recorded at the last install. The command comes from `packageManager` in `package.json` (`pnpm install --frozen-lockfile` for pnpm); `STUDIO_CHECKS_INSTALL_COMMAND` replaces it.

The copy changes only under the gate: `checks copy` takes the gate itself for a checkout or an install, and refuses when someone else holds it, unless it runs inside that holder's command. It never discards work: a copy with uncommitted or untracked files is left as it is and the files are listed.

### Copies nobody uses

A copy with its install holds several gigabytes. The hourly storage sweep removes one that no `checks copy` or `checks run` used for 7 days (the newest of its `.git/specwithcode-last-used` marker, its last fetch, its last checkout and its last install). It keeps a copy while the gate is held from inside it, while a process has its working directory in it, when it has uncommitted or untracked files, a stash, or a commit made in it, and when any of that cannot be read. The next `checks copy` clones it again from the checkout, so nothing is lost but the install time. There is never more than one copy per repository: the folder is named after it.

### What the copy cleans by itself

One copy once held 440 files named `tmp_pack_*` of about 198 MB each, 79 GiB in all. Its refs pointed at objects it did not have, so the `git gc --auto` that every `git fetch` starts failed (`fatal: unable to read <sha>`, then `fatal: failed to run repack`) and left a full-size temporary pack behind on every call.

- The fetch passes `--no-auto-gc`, so Git's housekeeping never starts from `checks copy`.
- Before each fetch, `checks copy` removes Git's leftover download files from the copy's `.git`: `objects/pack/tmp_pack_*`, `tmp_obj_*` in `objects/pack` and in the two-letter loose-object folders, and `objects/pack/.tmp-<pid>-pack-*` from a repack that never finished. It prints one line on stderr with the count and size.
- Only files that nothing has written to for an hour go (the newer of the modification and change times counts). A fetch running at the same moment, which the gate does not cover, keeps its files.
- Packs, their `.idx`, `.rev`, `.keep`, `.bitmap` and `.mtimes` files, loose objects, links and folders are never touched. A file that cannot be removed is reported and left; the command goes on.

The storage sweep removes the same files from every `<home>/verify/*/.git` once they are six hours old, for copies nobody calls again.

### Exit codes of `checks copy`

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| 0    | The path is on stdout.                                         |
| 2    | The copy has uncommitted or untracked files. Nothing changed.  |
| 3    | The copy would have to change and someone else holds the gate. |
| 1    | Anything else, for example a failed fetch or install.          |
