# Installed follow and project return checks

These checks drive the installed SpecWithCode app's own server and web client, not a fixture. Each one starts the bundled server (`ELECTRON_RUN_AS_NODE`) on a private base dir, a private `HOME` and a free loopback port, so the live app and its state are never touched. They always run headless and never open a report.

Run them with Node 22.20 from `apps/web`. Set `PLAYWRIGHT_MODULE` (absolute path to a `playwright-core` `index.mjs`) and `PLAYWRIGHT_EXECUTABLE_PATH` when the default runtime is missing. `SPECWITHCODE_APP` picks another app bundle (default `/Applications/SpecWithCode.app`); `SPECWITHCODE_SOURCE_ENTRY` runs a checkout's `apps/server/src/bin.ts` instead. `INSTALLED_CHECK_ROOT` moves the private state, which lives under `~/.local/share/specwithcode/verification/` by default. Each server is stopped when its check ends, and a check exits 1 when any step fails. Neither the pairing token, the pairing URL nor its QR code is written to the evidence folder, and the fake binary logs only flag names.

```sh
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never node tests/installed-follow/coordinator-follow-check.mjs /path/to/new/evidence-dir
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never node tests/installed-follow/thread-follow-check.mjs /path/to/new/evidence-dir
```

`coordinator-follow-check.mjs` covers coordinator follow (0960) and project return (0946). Only Claude is enabled, and its binary is `fake-claude.mjs`: a scripted stand-in with no model and no network that answers the Agent SDK control protocol, so every coordinator reply is a real orchestration turn rendered by the installed client. Each stream is tagged (`Reply stream S3 paragraph 8.`), so a wait can never match an earlier stream. A loaded host that answers "busy, your draft is kept" gets the message again until the composer empties. A message carrying `[[stream:N:MS]]` gets N paragraphs, one assistant event every MS milliseconds, the way Claude Code delivers content blocks. The check builds 14 exchanges through the composer, then records 52 steps in `receipt.json`:

- A, at the end: streaming, the end of a turn, a late image, a row above growing, scroll the browser makes on its own, a click then growth, and a narrowed and widened window all keep the reader at the end with no jump control.
- B, reading: an upward wheel during streaming pauses following, and the top message keeps its offset while rows arrive, the turn ends (the control turns into "new messages below"), an image loads and the window resizes.
- C, resume: wheeling back to the end, PageUp then End, and one "Jump to latest" each resume following.
- D, find: Cmd+F to an older match stays on it through growth.
- E, selection: a selection dragged above the conversation pauses following.
- F, project return: a reply that arrives while another project is open shows on return, a reader further up returns to the same message through single and rapid A-B-A switches, and a return after a jump lands on the latest.

`thread-follow-check.mjs` imports a synthetic 80-message Claude transcript as a thread (Claude points at a missing binary, so nothing runs) and opens it in the project's right pane. A click on a message must not stop following, an upward wheel must show "Jump to latest", and wheeling back to the end must hide it. Under heavy machine load the 150 ms jump debounce can miss the sample; rerun before reading a failure as a regression.
