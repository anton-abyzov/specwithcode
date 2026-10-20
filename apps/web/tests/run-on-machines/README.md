# Run on machines fixture

Renders the production Run on menu (`DraftMachinePicker`), `RenameMachineDialog`, `AddToMachineDialog` with its consolidation review, and the composer clone strip against mocked machines, projects and RPC handlers, with no host. `mocks.tsx` stands in for the stores and commands only for the files `vite.config.ts` names; the draft store and UI kit are real.

`verify.mjs` checks each view at 1280×900 and 390×844, light and dark:

- `menu`: the trigger names the machine the thread runs on, and the machines that have the project are listed together.
- `add`: a machine with an existing copy offers to link it, a machine without one offers "Clone it there", and a disconnected machine links to Settings.
- `rename`: a rename is limited to 16 characters, and the new name appears in the menu.
- `dialog`: the clone dialog shows the SSH URL and the secret files it will not copy.
- `consolidate`: an existing folder is linked and its diverged repository never offers "take theirs".
- `strip`: the clone progress strip shows the summary, and Cancel works.

From the repository root, using Node 22:

```sh
cd apps/web && node ../../node_modules/vite-plus/bin/vp build --config tests/run-on-machines/vite.config.ts && cd ../..
STUDIO_PLAYWRIGHT_MODULE=/absolute/path/to/playwright node apps/web/tests/run-on-machines/verify.mjs /absolute/owned/report-dir
```

The runner always uses `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`, and serves the build on an ephemeral loopback port. A page error fails the run. Screenshots and `receipt.json` go to the report directory (default `.artifacts/run-on-machines/evidence/`).
