# Storage and retained history

SpecWithCode keeps its application bundle, private data home, project folders and task worktrees separately. The private home contains runtime versions, settings, history, attachments, caches and update recovery. A worktree folder contains source checkouts and their local dependencies and build outputs; it is not the application installation.

## Folder settings

Project folder selects the logical workspace and default repository context. Worktree location, under Settings > Storage, selects where newly created checkouts are stored on that machine. An empty location uses `<app home>/worktrees`. Existing worktrees stay in place when that setting changes. Each code worktree belongs to a selected Git repository, even when the project encompasses several repositories.

Git worktrees share repository objects and history but have separate checked-out files and indexes. Dependency installations and build outputs can be repeated in each checkout. A linked worktree's `.git` file refers back to repository metadata; moving or copying the folder alone does not make it portable.

## Database growth

The event log retains history alongside current projections. A large database is not evidence of corruption, and reusable free pages are different from redundant retained events. SQLite can reuse free pages without reducing the file's apparent size.

Growth controls skip unchanged nodes and timestamp-only updates, coalesce streamed tool output, avoid duplicate edit patches and store repeated subagent prompts once. Prompt-reference events are expanded on replay, command reads and replay-size accounting. Their anchors remain in the event log. Command-associated turn-item snapshots and all subagent snapshots are retained. Other self-contained turn-item snapshots retain their first and latest events to preserve insertion positions and final output.

Background maintenance retains its six-hour cadence across restarts. It reads at most 50 event or receipt rows per background page and rests after work slices to limit maintenance duty to approximately ten percent. Every delete still checks update holds and snapshot/install markers inside its transaction. This pacing is not a hard latency guarantee for an individual SQL statement. Offline reclaim does not add the background rest periods.

Prepared statements with more than 64 KiB of text or blob parameters are not cached, so native SQLite bindings cannot pin those payloads for the cache lifetime. Named getters are evaluated only by SQLite. This reduces retained memory, not the file size.

## Returning space to disk

`specweave-studio db query` is the supported live read path. Never open a live database or its sidecars directly with SQLite libraries or file tools.

`specweave-studio db reclaim` is an offline maintenance operation. It requires the service stopped, refuses active updates or other holders, verifies the rewritten copy and preserves the original. Compaction makes pages reusable; rewriting is what returns them to disk. Reclaim is a separate maintenance action, not part of a worktree cleanup or a source-code update. Do not stop active work just to run it.

New prompt-reference events require a reader that understands those references. Rollback to an older reader must restore its corresponding pre-update snapshot; it must not run against a newer database and silently display empty prompts. No release or downgrade compatibility is implied by synthetic persistence tests.
