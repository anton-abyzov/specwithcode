# Settings presentation verification

Renders the production ProjectWorkspaceSettings, ProjectEnvironment, ProjectConnections,
SettingsRow and ProjectLocation with built application CSS. Reuses the project-workspace
in-memory host fixture. It does not read a live store or invoke a coding provider.

Build apps/web first using Node 22.20 and the repository pnpm 11 toolchain. From repository root:

```sh
node apps/web/tests/settings-presentation/serve.mjs
```

In another shell (Node 22.20):

```sh
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never node scripts/studio-verify/settings-presentation.mjs
```

The browser is explicitly headless. PLAYWRIGHT_MODULE can locate Playwright and
STUDIO_TEST_CHROMIUM can select an installed Chrome executable. SETTINGS_UI_ORIGIN
overrides http://127.0.0.1:5796; PROJECT_UI_PORT sets the fixture port.

The matrix covers five widths/heights in light and dark, every settings tab,
expanded paths, keyboard disclosure, dirty-state footer visibility, long connection
names, repository URLs and shared settings rows. Screenshots and receipt.json go to
.artifacts/settings-presentation, or the first argument supplied to the runner.
Native app acceptance and real backend operations are outside this fixture.

`routines-check.mjs` opens Settings > Routines rows (`?routines`) at 1280, 760 and 390 px, light
and dark: title and state first, cadence, the next run as a short local date with how soon,
project and destination, a one-line prompt, and Run beside the switch. Run and the title (which
opens the editor) are checked against recorded calls; nothing runs. `ROUTINES_MEASURE_ONLY=1`
saves screenshots only, for a before capture. Set `UI_EVIDENCE_DIR` and `PROJECT_UI_PORT`.
