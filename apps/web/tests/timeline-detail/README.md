# Timeline detail fixture

This renders the production `MessagesTimeline` under the production `ChatHeader` (which holds the `TimelineDetailMenu`), laid out as the browser build's thread header, and the app's compiled CSS, inside a one-route router and the real toast providers. The thread has one finished turn (a note, a failing test run, a thought, an edit, a passing run and the answer) and one running turn (a note, a finished command, a thought, a later note and a command still running). Callbacks are no-ops; nothing reaches a server or provider. The level is the real client setting, saved in the page's `localStorage`.

`verify.mjs` checks each level at 1280 px and 390 px, in light and dark:

- **Folded steps** (Normal): the finished turn folds to its answer; the running turn shows its notes.
- **Everything** (Verbose), chosen from the menu: the finished turn's notes, command output and thoughts are open, and so is the running turn's thought.
- **Results only** (Concise), reached with ⌥⌘O: a "Show: Results only" toast appears; the running turn keeps only its latest note and no thought; the finished turn's fold reads "Ran 2 commands and changed 1 file".

It also checks that the trigger's accessible name follows the level, that away from Normal the trigger shows the level's name, that it sits at the header's end after the thread title, that the level survives a reload, that the shortcut wraps back to Normal, and that the page never scrolls sideways. The rows near the start of the thread are checked at desktop width only, because the list renders just the end of the thread on a phone.

From the repository root, using Node 22.20:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/timeline-detail/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/timeline-detail/verify.mjs
```

If Playwright's matching Chromium is absent, set `STUDIO_CHROMIUM_EXECUTABLE` to an installed headless Chromium. The runner always uses `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`. It serves the build on an ephemeral loopback port, blocks every other request, and closes both the browser and the server when it finishes. Screenshots (`thread-<level>-<theme>-<width>.png`) and `receipt.json` go to `.artifacts/timeline-detail/evidence/`, or to `TIMELINE_DETAIL_UI_OUTPUT`.
