# Inline media fixture

This renders the production `ChatMarkdown` for six agent messages that name media by absolute path, with no host. The thread's server is replaced by a `/media` route in the runner: a request for the thumb variant gets a 640 px picture labelled "thumb 640", a plain one the 1600 px file labelled "full 1600", so each screenshot shows which of the two the page loaded. `?before` renders the same messages without the fallback, as they looked before it existed; `?theme=dark` switches the theme.

`verify.mjs` opens the page at 1280 px and 390 px, in light and dark, and checks that:

- before, every message is a chip (or the author's own image) with no thumbnail;
- a message that names a screenshot in a chip shows exactly one thumbnail under it, loaded as the thumb variant, and keeps its chips;
- a message that names several files shows only the first;
- a message that embeds its own image shows that image and no fallback;
- a file the server cannot sign leaves the chip alone;
- a recording named by path shows one player;
- a reply still streaming shows nothing yet;
- a click on the thumbnail opens the full file, not the thumb, in the expanded viewer;
- nothing spills sideways and the page raises no error.

From the repository root, using Node 22.20:

```sh
node node_modules/vite-plus/bin/vp build --config apps/web/tests/inline-media/vite.config.ts
UI_EVIDENCE_DIR=/absolute/new/directory PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs node apps/web/tests/inline-media/verify.mjs
```

`PLAYWRIGHT_EXECUTABLE` names an installed headless Chromium when Playwright's own is absent. The runner always uses `headless: true`, `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`, serves the build on an ephemeral loopback port, blocks every other request, and closes the browser and server when it finishes. Screenshots (`before-<theme>-<width>.png`, `after-<theme>-<width>.png`, `viewer-<theme>-<width>.png`) and `inline-media-check.json` go to `UI_EVIDENCE_DIR`; without it, to a timestamped directory under `.artifacts/inline-media`.
