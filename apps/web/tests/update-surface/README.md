# Update surface visual fixtures

This harness renders the production sidebar update controls, `SidebarRestartToUpdate` and
`SidebarServerUpdate`, in a 260px sidebar-footer column, with the real `ConfirmDialogHost`
mounted. The desktop bridge, desktop and service update state, server configs, session and
`prepareServiceUpdate` command are explicit in-memory fakes (`mocks.tsx`). Nothing installs,
restarts or reaches a server; the fake bridge records install calls so the receipt can prove
that none were made. These receipts prove UI behaviour and layout; the real desktop update
path remains a separate gate.

Build the web application in this checkout first. The fixture reads its production
stylesheet from `apps/web/dist/assets` and does not overwrite a shared build. Install
Playwright in an isolated Python runtime, then run from the repository root:

```sh
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never /absolute/path/to/playwright/python \
  apps/web/tests/update-surface/verify.py --output /absolute/owned/evidence-directory
```

`--node` overrides the default isolated Node 24 path used for the Vite source fixture.
`--chromium` overrides the default cached headless Chromium executable. The runner starts
one Node process on an ephemeral loopback port, blocks non-fixture HTTP and WebSocket
requests, and terminates only that owned process in `finally`. The fixture client reports
itself as 1.0.25 so the 1.0.20 fake server is behind it.

Scenes (`?scene=`), each at 1440x900 in light and dark:

- `restart`: desktop update 1.0.25 downloaded with release notes. Captures the idle
  "Restart to update" button with the "What's new" sparkle button, the hover tooltip with
  release notes ("and 1 more" for the fifth item), the three-choice dialog shown when
  `prepareServiceUpdate` reports 3 running jobs and 1 queued message ("Restart when idle",
  "Restart now", "Cancel"), and the button reading "Restarts when idle" after that choice.
  It asserts no install call was made.
- `server`: one remote server on 1.0.20 with `serverSelfUpdate: "boot-service"`; captures
  the compact "Server update" row with its one-click Update button and version tooltip.
- `server-none`: the same server with `serverSelfUpdate: null`; asserts the row renders
  nothing.

Screenshots (full viewport plus `-footer` crops of the bottom-left), `server.log`, and
`receipt.json` are saved only to the requested evidence folder. Inspect the screenshots
before treating a successful runner as visual acceptance.
