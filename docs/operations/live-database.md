# The live database

SpecWithCode keeps its state in `userdata/statev2.sqlite` with two sidecar files, `statev2.sqlite-wal` (the log of recent commits) and `statev2.sqlite-shm` (the index into that log, which every connection maps into memory). While the service runs, treat all three as live.

## The rule

Never open, copy, move or delete those files with sqlite3, Python, Node, a file manager or any other tool while the service runs. That includes read-only opens such as `sqlite3 -readonly`, Python `sqlite3.connect('file:…?mode=ro')` and `new DatabaseSync(path, { readOnly: true })`.

To read the database, use one of these instead:

| Need                                         | Command                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run a query                                  | `specweave-studio db query "SELECT count(*) FROM projection_threads"` (one JSON line per row)                                                        |
| Get a copy to inspect, share or back up      | `specweave-studio db snapshot /tmp/statev2-copy.sqlite`, then open the copy                                                                          |
| From a Python script                         | `import live_database; live_database.connect(path)` or `python3 scripts/studio-fleet/live_database.py snapshot --identity m4 --out /tmp/copy.sqlite` |
| From a Node script                           | `openLiveDatabaseReadOnly(path)` from `scripts/lib/live-database.mjs`                                                                                |
| Check that the service still holds its locks | `python3 scripts/studio-fleet/live_database.py locks --identity m4`                                                                                  |

The CLI commands use `STUDIO_HOME`, or take `--base-dir <home>` (the folder that holds `userdata/`, for example `~/.specwithcode/m4`, or `~/.specweave-studio/m4` on a Mac that has not moved yet).

The SpecWithCode CLI follows the same rule. While the service runs, no CLI command opens the database read-write: `pair`, `auth pairing create|list|revoke`, `auth session list|revoke`, `fleet invite`, `project`, `connect unlink` and `service prepare-update` ask the running service over HTTP or its WebSocket instead, with a token the service publishes for this machine's CLI at every start (`userdata/secrets/local-cli-credential.bin`). That session lives in the service's memory only: a start writes no `auth_sessions` row, it is not listed under Connections, "Sign out other devices" does not revoke it, and its token stops working when that service exits. The CLI sends it only to the service's loopback address, after the service there answers with this home's environment id. Commands with no way through the service (`auth session issue`, a `pair --ttl` over five minutes) refuse and say what to do in the app. With the service stopped they open the database as before. "Running" also covers starting and stopping: the service writes `userdata/database-owner.json` before it opens the database and removes it after the database closes, so the minutes of migrations before `server-runtime.json` exists are covered too, and a second `serve` or `start` on the same home is refused before it opens the database. A service older than this CLI publishes no token; the CLI then says to restart or update it, and does not fall back to opening the database.

The same rule covers the project knowledge indexes under `userdata/knowledge/` (one SQLite file per project, with its own `-wal` and `-shm`). The service registers each one with the live-database guard while it is open. They are derived data: to start one over, use **Rebuild index** in the project's Memory settings instead of deleting the file. See [project knowledge](../studio/project-knowledge.md).

## Why

SQLite coordinates processes with POSIX advisory locks on the database file and on `-shm`. Those locks belong to a process, not to a file descriptor: when a process closes any descriptor it has for one of those files, the kernel drops every lock that process holds on it, including the ones SQLite took for its own connection. Nothing reports the loss.

Once the service has lost its locks, every other process sees a database nobody uses:

- A reader that opens it, even read-only, decides it is the first user. It truncates `-shm` and rebuilds it under the service's memory map, and the service dies with `SIGBUS` (`FS pagein error`) in `walFindFrame`. This crashed the M4 service on October 16 2026.
- A read-write opener decides, when it closes, that it is the last user. It checkpoints, then deletes `-wal` and `-shm` while the service still writes to them. The service's later commits go to a deleted file and are lost when it restarts, and snapshots fail with `database disk image is malformed`. This happened on M4 on October 15 2026, and again on October 26 2026: the desktop ran `specweave-studio pair` 11 times while it attached to the service, and each run opened the live database read-write to insert its own session row before calling the service. That CLI path is gone (see the rule above).

With the locks intact the same readers are harmless, so both failures need two things: a lost lock and an outside open. The app now prevents the first and makes the supported readers immune to the second:

- The service refuses, with `EACCES` and a stack trace on stderr, every node:fs call in its own process that would open, copy, rename, truncate or delete one of its database files (`apps/server/src/persistence/liveDatabaseGuard.ts`). Look for `[live-database-guard]` in the service's stderr log to find the caller.
- The supported readers open the database with `?mode=ro&readonly_shm=1`. `readonly_shm` opens `-shm` read-only, so the reader can never truncate or rebuild it, and `mode=ro` keeps it from checkpointing or deleting `-wal`. In the reproduction, plain read-only readers crashed a service whose `-shm` lock was gone in 45 of 45 runs; these flags crashed it in 0 of 192 runs, and all 144 copies taken that way passed `PRAGMA integrity_check`.
- `scripts/studio-fleet/update.py` refuses to snapshot a service when no process holds the database's lock or the `-shm` lock (`The SpecWithCode service lost its SQLite locks on its database`).

## If it already happened

A service that lost its locks, or whose `-wal` was deleted, needs a restart; nothing outside the service can repair it. Stop opening the database from outside, then restart the service (on a fleet Mac: `launchctl kickstart -k gui/$(id -u)/com.specweave.studio.<identity>`). Commits that went only to a deleted `-wal` cannot be recovered.
