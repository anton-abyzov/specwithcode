# Live activity fixture

Renders the production `MessagesTimeline` in each live state of a working thread, with synthetic entries and turn items and no host: `running` (a command in flight after four finished calls), `thinking` (between calls, last event 6 s ago), `quiet` (last event 3 min ago), `offline` (the host is not connected) and `settled` (the finished turn).

`verify.mjs` checks each state at 720 px and 390 px, light and dark: the live row names the call and times it from its own start; between calls it says "Thinking" only while events arrive and "No new events for N" after a quiet minute; the Working header names the machine and its dot is fresh, quiet or offline; offline rows show no clock or shine; group headers carry a count and chevron, open by keyboard, and their calls sit inside an indented, ruled group.

From the repository root, using Node 22.20:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/live-activity/vite.config.ts
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/live-activity/verify.mjs /absolute/owned/report-dir
```

The runner always uses `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`, serves the build on an ephemeral loopback port and blocks every other request. Screenshots and `receipt.json` go to the report directory (default `.artifacts/live-activity/evidence/`).
