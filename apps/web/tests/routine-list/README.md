# Routine list verification

Renders the production Settings > Routines list (`RoutineList`) across two fictional machines
with built application CSS, on the project-workspace in-memory host. Routines cover every
state: active, on request, failed, a one-time routine turned off after a failure, paused and
finished. Nothing runs; actions are recorded in `window.__projectCalls`.

Build apps/web first (Node 22.20). From the repository root:

```sh
node apps/web/tests/routine-list/serve.mjs
```

In another shell:

```sh
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never UI_EVIDENCE_DIR=/tmp/routine-list node apps/web/tests/routine-list/check.mjs
```

The browser is headless. `PLAYWRIGHT_MODULE` locates Playwright, `PLAYWRIGHT_EXECUTABLE_PATH`
picks a Chromium and `PROJECT_UI_PORT` changes the port (default 5797). The check covers
1280 px light and 390 px dark without horizontal scroll, grouping by machine, provider and
state, the machine, provider and state filters, search, the collapsed paused-and-finished tail,
Pause from the row menu, a dismissed and an accepted "Delete finished", and the single-machine
list without a machine heading.
