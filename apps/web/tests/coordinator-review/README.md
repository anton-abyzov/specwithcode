# Coordinator review visual fixtures

This harness renders the production project workspace, named requests/activity dialogs,
Button controls, native approval/question panels, scoped answer attachments, tool output,
and proposed-plan Markdown. The main transcript and native ChatView runtime are stand-ins.
Every approval, answer, plan action, host query, upload, and output read is an explicit
in-memory fixture. No credentials, live store, native provider, or paid turn is used.
These receipts prove UI behavior and layout; native integration remains a separate gate.

Build the web application in this checkout first. The fixture reads its production
stylesheet from `apps/web/dist/assets` and does not overwrite a shared build. Install
Playwright in an isolated Python runtime, then run from the repository root:

```sh
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never /absolute/path/to/playwright/python \
  apps/web/tests/coordinator-review/verify.py --output /absolute/owned/evidence-directory
```

`--node` overrides the default isolated Node 24 path used for the Vite source fixture.
`--chromium` overrides the default cached headless Chromium executable. The runner starts
one Node process on an ephemeral loopback port, blocks non-fixture HTTP and WebSocket
requests, and terminates only that owned process in `finally`.

The matrix covers 1440px light and 390px touch/dark layouts for approval, question, plan,
and activity scenarios. It verifies named dialogs; Close/Escape focus restoration; one
message composer remaining behind the overlay; preserved coordinator drafts; viewport
bounds; styled action controls; exact synthetic request decisions; scoped file selection,
removal and answer submission; and lazy full output fetching for the selected turn.
Screenshots, `server.log`, and `receipt.json` are saved only to the requested evidence
folder. Inspect the screenshots before treating a successful runner as visual acceptance.
