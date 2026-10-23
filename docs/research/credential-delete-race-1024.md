# Credential deletion race, 1024

PR #630 head `fadc5da6712a7fb018bb46cc24b33be40c0a0da7` failed run `39908820281`, job `120266883249` with `TimeoutError: Operation timed out after '10s'` in the unchanged disposal test. This is an independent secret-store race reproduced locally, rather than evidence of an infrastructure outage or browser lifecycle regression.

## Reproduction

The original test sequence plus trace points failed 5 of 100 local cases. Every failing trace received creation and removal and entered the late credential write. A controlled filesystem interleaving reproduced the same timeout: rename the late-write temporary file, delete the destination through removal, then let final-path chmod run. Chmod failed with NotFound; the test's success-only `lateWrite` Deferred was not completed. This establishes a failed write before that signal, not an indefinitely stuck filesystem operation.

The smaller committed regression deletes the destination inside real rename completion. Before repair it fails with `SecretStorePersistError: Failed to persist secret disposal.` caused by `NotFound: FileSystem.chmod`. It checks the actual inode's mode before deletion, observes the destination is absent and confirms no temporary file remains.

## Repair

Remove the redundant chmod of the destination after atomic rename. The temporary inode already has mode `0600` before rename and carries those permissions into the destination. This avoids both touching a deleted path and modifying a replacement inode after another concurrent writer wins. Error handling for writes, pre-rename permission changes and rename remains unchanged. Existing timeouts remain unchanged.

Production scope: `/Users/you/.specwithcode/m4/worktrees/browser-live-1018/apps/server/src/auth/ServerSecretStore.ts`.

Regression scope: `/Users/you/.specwithcode/m4/worktrees/browser-live-1018/apps/server/src/auth/ServerSecretStore.test.ts`.

No edits to the original settings test, browser lifecycle, native capture or preview Manager. No remote CI rerun, watcher, deployment or service restart. Release owner 1015 retains integration, merge and inclusion.

## Evidence

- Retained CI: `/Users/you/Projects/github/specweave-umb/.specweave/increments/1015-prepare-mac-and-mobile-release/evidence/pr630-gate-artifact-fadc5da67/server/server-1.log`.
- Unmodified focused baseline: `/Users/you/.specwithcode/m4/evidence/pr630-settings-race/baseline.log`.
- Instrumented original sequence, 95 pass and 5 fail: `/Users/you/.specwithcode/m4/evidence/pr630-settings-race/diagnostic.log`.
- Deterministic timeout with I/O ordering: `/Users/you/.specwithcode/m4/evidence/pr630-settings-race/controlled-interleaving.log`.
- Controlled diagnostic source: `/Users/you/.specwithcode/m4/evidence/pr630-settings-race/controlled-interleaving.ts`.
- Smaller regression before repair: `/Users/you/.specwithcode/m4/evidence/pr630-settings-race/regression-before.log`.
- Full secret-store and settings suites, 105 pass: `/Users/you/.specwithcode/m4/evidence/pr630-settings-race/suites-after.log`.
- Original disposal sequence after repair, 100 pass: `/Users/you/.specwithcode/m4/evidence/pr630-settings-race/disposal-100-after.log`.
- Focused lint: `/Users/you/.specwithcode/m4/evidence/pr630-settings-race/lint.log`.

The plain server typecheck found the project's existing Effect diagnostic baseline plus one new optional-directory assertion error. That error was fixed by using the configured secrets directory. The final baseline-aware server typecheck gate passes with zero new diagnostics and 79 existing diagnostics; its baseline was not modified. SpecWeave verification passes both acceptance criteria and both tasks, the 105 tests, focused lint and baseline comparison.

## Limits

These are local source and isolated-filesystem tests. They do not make the retained failed PR gate green and do not establish installed-app acceptance, native PiP z-order or Spaces behavior. No live application database was opened. The independent repair is prepared locally for the release owner.
