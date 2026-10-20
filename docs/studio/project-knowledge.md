# Project knowledge and automatic search mode

Status: built in increment 0927. This reimplements the automatic retrieval mode of [Claude Projects](https://support.claude.com/en/articles/9517075-what-are-projects) for SpecWithCode project workspaces.

While a project's memory files and hub artifacts are small, every worker thread receives them in full with its project context. Once they grow past the inline allowance, the app switches the project to search mode on its own. Threads then receive a short catalog and search the knowledge with two read-only tools. Once the knowledge shrinks well below the allowance, the project switches back.

The Library folders (docs, reports and increments) are larger and change often, so they are always searched and never sent in full.

## What Claude Projects does

Anthropic publishes the behaviour, not the mechanism. Paid projects keep knowledge in the context window while it fits. As it approaches the window, they switch to retrieval through a project knowledge search tool. An indicator shows while that mode is on, and the project switches back once knowledge drops below the threshold. The help centre claims up to ten times the capacity, and there is no user toggle.

A read-only look at the Claude desktop client (cached web bundles of 16 October 2026) shows how the pieces fit:

- The server decides. A capable client fetches `GET /api/organizations/{org}/projects/{project}/kb/stats`, which returns `knowledge_size`, `max_knowledge_size`, `use_project_knowledge_search` and `project_knowledge_search_threshold`. The client holds no threshold of its own; search mode is on exactly when the server says so.
- In search mode both completion builders add a server-defined tool, `{type: "project_knowledge_search"}`, with no client-side schema. Chunking, ranking and the embedding model are invisible from the client. Outside search mode the server inlines every document.
- Capacity for clients without search is `round(0.9 × the largest chat model's hard limit)`, which is 171,000 tokens with the fallback. With search it is a remote config defaulting to 52,428,800. Sizes are token estimates:
  - text: characters / 4
  - PDF: pages × 2,000
  - images: `min(1600, ceil(w·h/700))`
  - GitHub syncs: bytes / 3.2
- The capacity bar fills to `ceil(size / max × 100)` percent. It turns to a warning above 80 percent and to danger at 100, and shows a marker at the threshold. A "Search mode" label explains the switch.

Two lessons carry over:

- One owner computes the mode and every surface reads it, so thresholds can change without touching clients.
- Search is a tool the model calls, not text pushed into every message.

## What is different here

Claude's chat model has the window almost to itself, so Claude inlines up to roughly 90 percent of it. A SpecWithCode thread is a coding agent. Its window also holds the provider's system prompt, tools, MCP schemas, the conversation and the code it reads. Measured first-request overhead is about 52,000 tokens for the app's Claude driver and 31,000 to 36,000 for Codex. Inlined knowledge is also re-sent after every compaction.

A fixed allowance far below the window is therefore right for agents. Agents already hold their own file tools, so search mode costs them little.

Before this change a thread received only `MEMORY.md` and the names of the other memory files. Memory details and the project Library (hub artifacts, reports, increments and docs) reached agents only if they went looking.

## Knowledge sources

A project's knowledge is the text the app can index without new permissions:

| Source          | What is indexed                                                                                                                            | Sent in full while it fits | Change signal                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ---------------------------------------- |
| Project memory  | Every memory file except `MEMORY.md`, which already travels as its own section                                                             | Yes                        | Name and revision from `project_memory`  |
| Hub artifacts   | File artifacts listed in `.specweave/project/hub.json` with a `.md`, `.mdx`, `.markdown` or `.txt` extension                               | Yes                        | Modification time and size, then SHA-256 |
| Library folders | `.md`, `.mdx`, `.markdown` and `.txt` files under `.specweave/docs`, `.specweave/memory`, `.specweave/reports` and `.specweave/increments` | No, always searched        | Modification time and size, then SHA-256 |

Memory files and hub artifacts are what people chose to keep, so they are the curated knowledge that may travel in full. Library folders hold hundreds of increments and reports, so they are searched in both modes.

### Confinement

Files are read under the Library's rules, and hub artifacts follow the same rules as folder files:

- The real path must stay inside the project folder.
- A symlinked `.specweave` or Library folder is refused, and so is a symlink anywhere in an artifact's path. Every segment is checked with `lstat`.
- Hidden folders and files are skipped, except the leading `.specweave`.
- `node_modules`, `dist`, `build` and `coverage` are skipped.
- Folder modification times are never trusted, because they miss nested edits.

The app's protected files are refused twice, as `projects.readFile` does:

- by path while scanning;
- again at read time, by the real path and by the device and inode of the opened file. The file opens with `O_NOFOLLOW` and `O_NONBLOCK`, and its identity must match the checked one.

Binary files are skipped. The working tree is not indexed, because agents search code with their own tools, as Claude Code and Cursor now do. Link artifacts are not fetched.

### Skipped by default

Some Library content is not knowledge:

- `.specweave/increments/_abandoned`;
- `.specweave/docs/internal/specs`, the living-docs copies of increment specs (each increment's own spec is indexed);
- `reports/task-*.txt` inside an increment, the raw command output that `specweave task done --run` saves.

### Limits

The index takes 2 MiB per file, 20,000 documents and 64 MiB per project. Sizes are measured on disk, because files are chosen before they are read. Past a limit, files are kept in this order:

1. memory files and hub artifacts;
2. docs, then SpecWeave memory, then reports, then increments;
3. archived increments, last.

Library files are newest first within each group. The status counts what was left out: too large, past capacity, or unreadable.

## When the project switches

Inline knowledge is measured exactly as it would be delivered: the characters of its rendered sections, headers and fences included.

- The project stays inline while the rendered memory files and hub artifacts fit **24,000 characters** (about 8,000 tokens).
- It switches to search mode above 24,000.
- It switches back to inline only at or below **19,200** (80 percent), so edits near the threshold do not flap.
- The mode belongs to the project, as in Claude Projects. Every thread sees the same mode and the app shows it.

The allowance comes from the budget rule `B = 0.15 × (E − O − P)`:

- `E` is the effective window before compaction;
- `O` is the measured overhead;
- `P` is up to 12,000 tokens for the prompt and project context.

For the smallest common window, Claude with 200,000 tokens, that gives about 15,000 tokens; Codex at 258,400 gives about 30,000. The allowance stays well under the smallest, because inline knowledge repeats in every thread and after every compaction. A per-thread allowance that follows each model's real window needs a session-free window lookup that the app does not have yet; it is listed under later work.

Token figures shown to people are estimates and are labelled "about". Recent Claude tokenizers produce about 2.5 bytes per token and older ones about 3.5, so the app divides characters by three rather than four, or one token per byte.

## Delivery to threads

Knowledge joins the project context snapshot that `ProjectContextDelivery` already sends as revision deltas. It has its own allowance on top of the shared 32,768 characters. So it never squeezes the goal, instructions or `MEMORY.md`, and those never change the project's mode.

What a thread receives depends on its role and its provider:

| Thread                                                                    | Inline mode                                                         | Search mode  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------ |
| Worker on Claude or Codex                                                 | A notice, then each memory file and hub artifact as its own section | Catalog only |
| Coordinator                                                               | Catalog only                                                        | Catalog only |
| Worker on any other provider, a native command such as `/goal`, a restore | Catalog only                                                        | Catalog only |

Only Claude and Codex threads record what they have received, so only they can take one document at a time as a delta. Other providers get the full snapshot on every turn, so they get the short catalog, not every document again. The coordinator briefs workers and does no research itself, so it is told to name the topic in a worker's brief instead of searching.

**Inline sections.** Each document is a section named `knowledge:` plus the first 16 hex characters of the SHA-256 of its id, so a file name cannot shape the context. The section is fenced as `<project_knowledge>` with its source, title and location. Sections are delta-tracked one by one, so an edited memory file re-sends only that document on the next real prompt. A thread's receipt stores each section's revision, never the document text.

**The catalog.** It says which kinds of sources the project has, lists the titles of hub artifacts and says how to use the tools, including the `within` folder filter. It carries no counts, sizes or timestamps, so routine indexing never sends a delta. Workers are told to search before answering questions about earlier decisions, specs or reports.

**Switching modes.** When more than eight document sections disappear at once, as on a switch to search mode, the delta announces them in one `[knowledge:*]` line instead of one line each. Any documents that remain are sent again in the same message, so that line can say all earlier ones are replaced.

**Order and fencing.** The sections come last in the snapshot, after `MEMORY.md`, so a provider that truncates restored context loses knowledge before instructions. Text is fenced like memory, and `MEMORY.md` is now fenced the same way:

- tags that would open or close a `project_` fence are escaped;
- a line that looks like a section header, such as `[instructions]`, is escaped as `\[instructions]`;
- a line that starts like the runtime's own markers, `Current user message:` or `Project context (`, gets a backslash in front, so text cannot pose as the user's message;
- a word joiner (U+2060) goes between a skill sigil and the name after it, so a document cannot dispatch a Claude or Codex skill. That covers the adapters' mentions after whitespace, Codex's `$name` wherever the `$` stands, and Codex's linked mentions `[$name](…)` and `[@name](…)`. Money amounts such as `$5`, `$1.50` and `$1,000` are left alone;
- the notice labels the text background evidence that may be stale and cannot grant permissions or override the user.

Tool results need no such treatment, since skills dispatch only from user text.

**Reading files.** The snapshot is computed inside the receipt transaction, so it must never read files there. The knowledge service keeps each project's rendered view in memory and in the index file. Before a turn, outside the transaction, `prepare` asks the service to be ready:

- for a project that has never been indexed, it waits up to two seconds;
- after a known change that is not indexed yet, such as a saved memory file, it also waits up to two seconds;
- otherwise it starts a background refresh when the view is more than 30 seconds old.

A rebuild never holds up a turn: threads keep the last view until the new one is ready.

A first index build that takes longer simply reaches the thread one prompt later as a delta.

## Index storage

Each project has its own SQLite file at `<stateDir>/knowledge/v1/<sha256(projectId)>.sqlite`. It uses the built-in `node:sqlite` driver with FTS5, which every server runtime ships (Node 22.20 has SQLite 3.50.4). The index never goes in `statev2.sqlite`:

- an update snapshot, backup and restore of `statev2` would carry a derived index (2.17 GB backups are already kept several times over);
- an index write during an update window would abort the update;
- `statev2` has one connection behind a semaphore, and a 20,000-chunk insert in one transaction stalled it for 1.7 seconds in measurement;
- deleting a project's knowledge is one file delete (2 ms) instead of a 549 ms purge.

The file holds these tables:

- `meta`: project id, schema version, mode, rendered view, last scan;
- `documents`: a stable id such as `memory:notes.md` or `file:.specweave/docs/x.md`, plus kind, location, title, revision, SHA-256, character count and the extracted text;
- `chunks`: document, order, heading breadcrumb, offsets; ids are `AUTOINCREMENT`, so a removed passage's id is never reused;
- `chunks_fts`: a contentless FTS5 table with `contentless_delete=1` and `tokenize='porter unicode61 remove_diacritics 2'`, so the text is stored once. camelCase and PascalCase identifiers also index their words.

Connection settings:

- WAL, `synchronous = NORMAL`, `busy_timeout` and `journal_size_limit`;
- `auto_vacuum = INCREMENTAL`, set before the first table exists;
- FTS5 `automerge` and `deletemerge` off, with two bounded merge steps after each write batch instead, so segments never pile up into a large merge inside one write;
- `PRAGMA user_version` for the schema;
- each connection is registered with the live-database guard while open.

The schema version is part of the path, so a rollback to an older release finds its own files untouched.

The file is derived data:

- A file that SQLite reports as corrupt or not a database, or that belongs to another project, is replaced and rebuilt.
- Any other error, such as a locked or busy file, leaves the file in place and is reported as a problem.

All index files together stay under a 2 GiB disk budget. Past it, the least recently used projects lose their files and rebuild on next use.

## Indexing

A refresh lists memory summaries (names and revisions, never content), reads the hub and walks the Library folders with one `stat` per file. Only new or changed documents are read, and a changed file whose SHA-256 is unchanged is not re-chunked. A file's revision is its modification time, its size and its placement (source, label and hub title), so pinning a file to the hub, unpinning it or retitling it indexes it again even when its bytes stay the same. Removed documents are deleted. One refresh runs per project at a time, and projects refresh one after another.

A scan that could not read the whole project removes nothing from the Library. That happens when the project folder is unreachable, a folder inside it cannot be listed, the walk stops at its entry limit or the hub file is invalid. The refresh keeps the Library documents it had, indexes what it could read, and the status reports the problem. Memory files and documents left half-written by a crash are still brought up to date.

Chunking is heading-aware:

- Markdown splits at headings outside fenced code, and each chunk carries its `Title > H1 > H2` breadcrumb. Headings read the same with CRLF line endings and with or without a closing run of `#`. The heading parser runs in linear time, so a long line of `#` or spaces cannot stall it.
- Sections aim at 1,600 characters with a maximum of 2,400.
- Short sections merge forward. Long ones split at paragraph, then line boundaries, never inside a code fence or a surrogate pair.
- There is no overlap.
- Plain text splits by paragraph.

Writes are batched, so a write never holds the event loop long:

- a batch costs one unit per passage written or removed, plus one per 20,000 characters of document text, up to 200 units per transaction, with a yield between batches;
- this measured 3.7 ms median and 13 ms worst case on the main thread;
- file reads are asynchronous;
- FTS5 indexed about 10,000 chunks per second in such batches.

A worker thread cut a 20,000-chunk stall from 1.74 s to 10 ms in measurement. It is the next step if profiling calls for it.

A document that spans several batches is safe from a crash part-way:

1. Its revision is first set to a pending marker.
2. Its old passages are removed and the new ones are written.
3. The real revision is set last.

A refresh after a crash sees the pending marker and indexes the document again. Each write batch is followed by two bounded merge steps. After writing, the refresh runs more bounded merge steps, then incremental vacuum and a WAL checkpoint.

Triggers are cheap:

- a memory write or delete marks the project dirty;
- a context snapshot, search or status read starts a refresh when the view is dirty or more than 30 seconds old;
- **Rebuild index** rebuilds from an empty file, and threads keep the last view until the new one is ready.

Archived projects keep the index they have, and Rebuild index still runs for them. When the disk is almost full, indexing pauses and the status says so. It continues once space is freed.

## Retrieval

The query builder never passes user text to `MATCH`:

- it extracts terms with `[\p{L}\p{M}\p{N}_]+`, so words in scripts written with combining marks, such as Hindi or Thai, stay whole;
- it keeps the first 16 terms, since every term widens the set of passages bm25 scores;
- it keeps hyphen, dot, slash and colon compounds such as `AC-01` or `docs/plan.md` as quoted phrases;
- it drops stopwords and one-character terms, counting characters without their combining marks;
- it joins the rest with `OR`.

Ranking uses `bm25(chunks_fts, 4.0, 2.0, 1.0)` for title, heading and body. Exact identifiers such as increment numbers and acceptance criteria match lexically, which is where embeddings are weakest. Passages from archived increments (`/_archive/`) count half, so current work ranks first.

A search can be limited to one folder with `within`, such as `.specweave/increments/0864`. The path is matched as a prefix of the project-relative location, with `%` and `_` escaped.

A search returns at most 8 results by default and 20 at most, with no more than two passages per document, so one long document that matches everywhere cannot crowd out the rest. Without `within`, FTS5 ranks the best 1,000 candidate passages first, and the archive weighting and the per-document cap apply to those, so a search on a full index stays fast. With `within`, every match in the folder is ranked. The result says when more passages matched than it returns. It stops adding full chunk text at 16,000 characters, and the remaining hits come back as title and location only. That keeps a result under Claude Code's 10,000-token MCP warning and well inside Codex's 60-second tool timeout. Each hit carries the document's last modification time, so an old passage reads as old. A search during the first build or a rebuild waits up to ten seconds, then answers from what is indexed and says so.

`studio_project_knowledge_read` returns one document by the id a search gave, 16,000 characters per page with `nextOffset`. A page never ends inside a surrogate pair and always moves forward, even through a page of one.

## Agent tools

A new `projectKnowledge` MCP toolkit adds `studio_project_knowledge_search` and `studio_project_knowledge_read`:

- Both are annotated read-only and non-destructive, and use `Access.readsAsCaller`.
- Both bind to the calling thread's project: a foreign `projectId` is refused with `capability_denied`, and a client outside any thread is refused with `thread_credential_required`.
- They clamp their inputs and map service failures to a generic error without echoing causes.
- They are on Claude's read-only allow list and in the shared tool presentation table, so cards and summaries read "Searched project knowledge".

The tools exist in both modes. In inline mode an agent uses them to search the Library folders; in search mode they are the way in, as `project_knowledge_search` is for Claude.

## In the app

Project settings, Memory tab, has a **Project knowledge** card:

- The mode, with what it means for the project's threads:
  - **Memory sent in full**: memory files and hub artifacts fit, and the Library is searched;
  - **Search mode**: memory files and hub artifacts are past the allowance, so threads search everything;
  - **Nothing to index yet**;
  - **Index not built**: the first build failed, with the reason.
- When the index was last brought up to date, that it is indexing or not indexed yet, and why the last refresh failed.
- A bar for how full the index is, by whichever limit is closer: 64 MiB on disk or 20,000 documents. The host reports both limits with its status. The bar turns amber at 80 percent and red once files are left out for capacity.
- A plain line for the inline allowance: how much the memory files and hub artifacts come to against the 24,000 characters, or how far below it they must fall to be sent in full again. Between the two marks it says threads keep searching until the lower one, so edits near the limit do not switch back and forth. It is not shown as a warning, because search mode is normal for a large project.
- A row per source with its documents and size in about-tokens, and a count of what was left out and why.
- A search field that runs the same search agents use, showing each passage with its document, location, heading and date, so anyone can check what threads will find. While the index is still being built, it says results may be incomplete and never that nothing matches. A screen reader hears one short line per search, not the passages.
- **Check again** and **Rebuild index**. Rebuild index needs permission to run work on the machine. It shows the rebuild at once and stays off until the host answers again, so a second click cannot start a second rebuild.

The card asks again every 1.5 seconds while the index builds, and after a memory file is saved. It sits in the settings search as "Project knowledge".

Scopes:

- `projects.knowledgeRead` and `projects.knowledgeSearch` need both orchestration read and filesystem read, since they quote Library files.
- `projects.knowledgeReindex` needs orchestration operate and is client-guarded.

A host that predates this change does not report the `projectKnowledge` capability, so the card says to update SpecWithCode on that machine instead of querying it. A connection without file read permission is told so, without a query.

## Lifecycle

- Deleting a project deletes its index file after the deletion commits.
- At startup, a sweep removes files whose project no longer exists, and folders two or more schema versions old.
- Moving a machine's project with the existing handoff needs nothing extra. Memory moves with the project and Library files move with the repository, and the index rebuilds where it lands.
- Rolling back a release leaves newer `vN` folders alone; the older release keeps using its own.

## Not in this version

- **Embeddings.** Hybrid search (brute-force vectors in the same file, reciprocal rank fusion with k = 60) stays opt-in for later. Remote embedding sends project text off the machine, and the app is private by default. Brute force measured 25 to 70 ms for 100,000 vectors of 384 to 1,024 dimensions, so no native vector extension is needed.
- **Text pushed into every prompt.** Per-turn excerpts would:
  - grow every transcript;
  - defeat prompt caching;
  - risk dispatching skills from document text;
  - add latency before the first token.

  Claude Projects also leaves retrieval to the model's tool call.

- **Ignore files.** `.gitignore` rules and a project `.specweave/knowledgeignore` are not read yet. The default skips above cover the known noise.
- **Chinese, Japanese and Korean text.** The `unicode61` tokenizer does not split words in these scripts, so a search matches whole runs of text only. A trigram or ICU tokenizer would fix it at a larger index.
- **Uploads, PDF, Office and Drive documents.** Library artifacts and memory cover text today. Uploads need their own storage, claim flow and extraction.
- **Library pane.** A search-mode chip on the Library pane, and opening a search hit in the file viewer, would follow this card.
- **Per-thread allowance** from each model's real window, once a session-free window lookup exists.
- **Knowledge across machines** through the fleet's remote tool allow list.

## Verification

Focused tests cover:

- the chunker and the query builder;
- incremental refresh, crash-safe re-indexing and replacing a damaged file;
- the switching rule with hysteresis;
- the disk budget and the full-disk pause;
- confinement and the protected-file checks;
- delivery sections by role and provider, their fencing against Claude and Codex skill dispatch, and the delta bound;
- the MCP binding and clamps, and the RPC scopes;
- the settings card, in jsdom and headless in the real settings dialog at 1440 and 390 px, light and dark (`apps/web/tests/project-workspace/knowledge-check.mjs`).

Run them from the package folder with `node ../../node_modules/vite-plus/bin/vp test run <files>`. Type-check with `TYPECHECK_TSC_ARGS="--checkers 2" bash scripts/studio-verify/typecheck-gate.sh --package apps/server --package apps/web`.
