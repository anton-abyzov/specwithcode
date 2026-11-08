# Thread resize fixture

This renders the production `MessagesTimeline` with a long finished thread (40 questions and answers) and the follow state `ChatView` keeps: an upward wheel pauses following (and cancels the list's kept "opened at the end" target, as `ChatView` does), and an end report resumes it only when the list itself moved down to the end. `?gate=0` drops that last check to show the snap it prevents. Callbacks are no-ops; nothing reaches a server or provider.

`verify.mjs` checks, headless:

- **Clamp**: a reader paused about 250 px above the end grows the window by 300 px, so the browser clamps the list to the end. They stay paused, and shrinking the window back leaves them off the end. A wheel notch down while clamped at the end follows again, as does wheeling on down to the end. With `?gate=0` the first two checks fail: the clamp re-arms following and the shrink pins the latest message.
- **Reading**: a reader wheeled up into the thread keeps the same top message, within 4 px, through stepped window resizes from 520 to 1600 px wide and 640 to 900 px tall.
- **At the end**: a reader at the latest message stays there through the same resizes.

From the repository root, using Node 22.20:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/thread-resize/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/thread-resize/verify.mjs
```

`THREAD_RESIZE_QUERY='?gate=0'` runs the clamp check without the fix. If Playwright's matching Chromium is absent, set `STUDIO_CHROMIUM_EXECUTABLE`. The runner always uses `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`, serves the build on an ephemeral loopback port, and closes the browser and server when it finishes. Screenshots and `receipt.json` go to `.artifacts/thread-resize/evidence/`, or to `THREAD_RESIZE_OUTPUT`.
