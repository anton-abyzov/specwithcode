# Bounded native acceptance review

This is test tooling, not a product approval default. Inspection and smoke keep providers disabled. The execution owner must obtain a fresh review for each explicitly authorized native window; an earlier failed receipt or schema1 review authorizes no new turn or tool approval.

The review is a closed schema2 object. Keep the existing provider entries (`binaryPath`, `binarySha256`, `version`, `model`) and exact clean runtime `sourceCommit` plus whole `buildSha256`. Add `toolingSha256` from `toolingIdentity().sha256`; it covers all six executable tooling dependencies, including `native-approval.mjs`. Set `maxRuns` to6 and `expiresAt` within the next hour. The exact authorization and plan are:

```json
{
  "schemaVersion": 2,
  "authorization": "six-native-project-runs-with-exact-single-use-approvals",
  "approvalPlan": {
    "schemaVersion": 1,
    "decision": "accept",
    "maxResponses": 4,
    "operations": [
      "delegate_task",
      "studio_thread_send",
      "studio_thread_wait",
      "studio_thread_read"
    ],
    "eachOperation": "at-most-once",
    "binding": "owned-project-dispatch-run-attempt-turn-session-exact-input",
    "retry": false,
    "persistentGrants": false
  }
}
```

This fragment is not an executable review: runtime/build/tooling/binary hashes, models and expiry must be independently verified and supplied. Neither it nor passing offline tests authorizes native execution.

Only an exact pending Studio MCP request in the owned coordinator can receive one `accept`. The harness binds its recorded user dispatch, source project, provider/model, active run, initial attempt, unique live provider turn, live session, execution nodes and one in-flight tool input. The optional attempt-to-turn backreference may be NULL; the unique turn-to-attempt relationship remains mandatory. Turn-item ownership comes from the owned projection and run/turn linkage; execution-node ownership is explicit.

The initial delegate input contains the exact context-only worker prompt and reviewed Claude model. The selected-thread send is armed only after the sole owned worker completes; its text and clientRequestId are exact. A wait binds the direct completed send result to that worker's second run, once with120000ms. The optional read uses exactly that thread's messages view after the exact wait completes. No alternate tool, extra input, extra worker, persistent grant, account/model fallback, retry or ordinary shell approval is allowed. The unchanged ceiling is six observed runs, attempts and provider turns.

Separate provider events can expose a node before its item or a request before its approval item. Otherwise eligible owned records can wait at most two monotonic seconds for missing links. The harness reserves no response during this interval; unknown tools, conflicting owners, changed linkage, disappearing records and expired waits fail. Every owner projection is fetched again before reservation. The response token is consumed before ticket exchange, so a failed transport cannot be retried. Cleanup never approves.

Polling cannot prevent a provider from issuing an extra action between observations. Excess is recorded and fails the receipt; this harness is not a replacement for runtime permission enforcement. Actual native success still requires the execution owner's new receipt with worker results, retained identity, updated memory markers and observed usage.

Offline verification uses Node22.20.0 with `--test scripts/studio-projects/native-acceptance.test.mjs scripts/studio-projects/native-approval.test.mjs`. Browser smoke, when assigned separately, must remain headless with `PWDEBUG=0` and `PLAYWRIGHT_HTML_OPEN=never`. Failure receipts contain only closed known assertion reasons, never arbitrary provider errors, actual/expected values, causes or stacks.
