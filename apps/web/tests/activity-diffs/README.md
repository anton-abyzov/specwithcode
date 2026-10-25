# Activity and diff fixture

This renders the production `MessagesTimeline` under the production `ChatHeader`, and the production `DiffPanel` beside it (a sheet under 1024 px), with the app's compiled CSS, inside a one-route router and the real toast providers. Every thread is synthetic. `mocks.tsx` builds the stored items and runs them through the server's own wire and detail projection (`WireProjection.ts`) and Codex patch conversion (`codexFileChanges.ts`), so the timeline sees exactly what a server would send, and the inspector's paging, Load more, Load earlier and Copy full read real pages from a fake `getTurnItem`. The turn-diff RPC answers from canned patches. `vite.config.ts` swaps in `mocks.tsx` only for the stores, queries and editor bridge that the timeline, the inspector, the checkpoint diff hook and DiffPanel import; nothing reaches a server, provider or credential.

Threads (`?thread=`):

- `thread-activity`: a read-only Claude turn; a Codex turn with a four-file headed patch (update, add, move, delete), a `sed -i` shell edit the card lists as not reported by an edit tool, a 4,000-line patch over one 256 KiB page, a 6,000-line lockfile patch, a failed test (exit 1), a heuristic-only "No files found", and a declined push; a stopped Claude turn with 533,769 characters of output whose page cuts fall beside 🚀 and 🌊, a structured-hunk edit on a long path, a provider-native subagent, and an interrupted command.
- `thread-flush-timer`: that subagent's own thread, with runless rows and an edit.
- `thread-fork`: a fork whose first turns are inherited from `thread-activity`.
- `thread-states`: one turn per diff state, ending in a running turn.
- `thread-ref-sed`, `thread-ref-read`, `thread-ref-brief`, `thread-ref-group`, `thread-ref-thinking`: the AC-14 reference rows, each the last row of its thread.

Other switches: `?theme=dark`, `?detail=concise|normal|verbose` (the real client setting) and `?subagents=unloaded` (the subagent thread's parent, and the parent's subagent activity, are not loaded). The page records Open diff calls in `window.__fixture.diffOpens`, copies in `copies`, toasts in `toasts`, files the diff opens in `fileOpens` and detail page reads in `turnItemPageReads`.

`verify.mjs` checks, at 1280, 720 and 390 px in light and dark:

- **AC-14**, at each level after unfolding every turn and group: no sideways page or row scroll outside code and diff panels; no label cut without an ellipsis (hidden overflow or paint containment), and no ellipsis without the full text on hover; row actions on screen, opaque and focusable, and Tab from each visible row reaching that row's actions in order. Each reference row renders on one line inside the list. A thought's cut preview is reported but not counted, and the thinking row is not expected in Concise.
- **AC-15**, at each level: full-strength "1 failed" with faint "1 possible failure" and "1 declined" on the fold and the group header; the exit, declined and stopped chips; Open diff on every edit row and both cards (none on the read-only turn); the Concise card counts; the subagent's file under "Edited by subagent". Open diff from the edit row, pressed with the keyboard, opens turn 2 with the provenance header (turn, repository, folder, branch@HEAD, machine) and only the linked file expanded and in view.
- **AC-04**: the card header, a card row, a not-reported row, the inspector and an inherited row each open the exact run and file; the file title opens the latest turn at its first changed line, and an older turn's current file with "Showing the current file; it may differ from this turn".
- **AC-19**: the subagent's edit opens the parent's turn 3 with "Edited by subagent Explore the flush timer in turn 3" and its file expanded; with the parent not loaded the row offers "Open parent thread", and the parent's card names the subagent in the not-reported label.
- **AC-11**: the output opens on its last page, Load earlier reaches its start, Copy full is SHA-256 equal to the source and no page cut splits an emoji; the large patch opens on its first page with Load more and copies byte-equal; the lockfile patch shows "Too large to show here" with Open diff and Copy full and no Load more (AC-06).
- **AC-05** and **AC-09**: each state's text, the other machine's header and notice, the turn after a failed turn listing the card's files, each missing-path reason with the whitespace toggle, the 10 MB cut, "Matched by file name", and a moved worktree's notice naming both folders. A running turn's Open diff is disabled with "Diff available when the turn ends".

From the repository root, using Node 22.20:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/activity-diffs/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/activity-diffs/verify.mjs /absolute/owned/report-dir
```

If Playwright's matching Chromium is absent, set `STUDIO_CHROMIUM_EXECUTABLE` to an installed headless Chromium. The runner always uses `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`. It serves the build on an ephemeral loopback port, blocks every other request, and closes the browser and that server when it finishes. Screenshots (`<scenario>-<level>-<theme>-<width>.png`) and `receipt.json`, which lists every check with its result, go to the report directory. The run exits non-zero when any check fails. This fixture does not prove installed acceptance.
