# Agent messages fixture

This renders the production `MessagesTimeline` with the app's compiled CSS, inside a one-route router and the real toast providers. The thread holds three messages other agents sent (`createdBy: "agent"`), in the shape of the October 25, 2026 screenshot: a 1,400-character receipt with run-together words, long paths and an ENOSPC error; an 830-character handover; and a 390-character merge receipt that sits between Concise's fold and Normal's. The texts are in `payloads.ts`, shared with the coordinator fixture (`../project-workspace`, `?agent-messages`). `?detail=concise|normal|verbose` sets the thread's level through the real client setting; `?theme=dark` switches the theme. Nothing reaches a server or provider.

`check.mjs` opens each level at 1280 px and 360 px, in light and dark, and checks that:

- "Sent by another agent" stays above each message, and none uses the person's clamp;
- in Concise and Normal the long receipt folds to its verbatim opening, names its hidden size ("Show full message, 1,297 more characters"), and opens whole;
- Concise also folds the mid-length receipt, which Normal shows whole;
- Verbose opens every message;
- "Copy original" copies the stored text byte for byte;
- nothing spills out of a bubble and the page never scrolls sideways.

From the repository root, using Node 22.20:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/agent-messages/vite.config.ts
UI_EVIDENCE_DIR=/absolute/new/directory PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/agent-messages/check.mjs
```

`PLAYWRIGHT_EXECUTABLE` names an installed headless Chromium when Playwright's own is absent. The runner always uses `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`, serves the build on an ephemeral loopback port, blocks every other request, and closes the browser and server when it finishes. For a before capture, build another copy with `AGENT_MESSAGES_SITE=/absolute/site/directory` and run the check with the same variable and `MEASURE_ONLY=1`, which records what that build shows without asserting. Screenshots (`thread-<level>-<theme>-<width>.png`) and `agent-messages-check.json` go to `UI_EVIDENCE_DIR`.
