# Chat density fixture

This renders the production `ChatHeader`, the thread header line (`ThreadMetaRow` and `ThreadPlanCard` inside `ThreadProgressDock`) and `MessagesTimeline` with synthetic rows: a scratch chat where another agent asked for "ok", then a request the user typed. Callbacks are no-ops; nothing reaches a server or provider. `?plan=todo` swaps the empty plan for a todo list.

`verify.mjs` checks at 1280 px and 390 px, in light and dark, that the folder chip, the run chip and the empty "No plan" chip sit on one line, that the agent's request has one sender line above the bubble while the machine and model wait in the hover row under it, and that the page never scrolls sideways.

From the repository root, using Node 22.20:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/chat-density/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/chat-density/verify.mjs
```

If Playwright's matching Chromium is absent, set `STUDIO_CHROMIUM_EXECUTABLE`. The runner always uses `headless: true`, serves the build on an ephemeral loopback port, blocks every other request and writes `chat-<theme>-<width>.png` and `receipt.json` to `.artifacts/chat-density/evidence/`, or to `CHAT_DENSITY_UI_OUTPUT`.
