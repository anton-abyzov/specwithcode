# Chaos rigs

Model-free fault runs against one scratch SpecWithCode server. Fake ACP agents (`chaos-agent.mjs`) read a control file at every prompt, so the rig can flip a usage limit on or off while the server keeps running. A checker (`check.mjs`) reads the server's own thread projections and the agents' own turn logs. No model tokens are spent, and no live home, database or credential folder is read.

## Run

```sh
node scripts/studio-chaos/fallback-storm.mjs --scenario ping-pong --seed 1
node scripts/studio-chaos/fallback-storm.mjs --scenario storm --seed 7 --workers 8
```

The server starts from `apps/server/dist/bin.mjs` when it is built, else from `apps/server/src/bin.ts`. `--server-root <checkout>` runs another checkout's server against this rig, which is how a fix is checked before it merges. `--keep` leaves the scratch home in place, and `--out <dir>` chooses where the receipt goes.

| Exit | Verdict    | Meaning                                                                         |
| ---- | ---------- | ------------------------------------------------------------------------------- |
| 0    | `pass`     | The run went quiet and no rule was broken.                                      |
| 1    | `violated` | A rule was broken; `receipt.json` lists each violation with its thread and run. |
| 3    | `stalled`  | The run was still busy at the time cap (`--cap-ms`).                            |
| 2    | `error`    | The rig itself failed (startup, RPC); see `receipt.error`.                      |

The receipt records the seed, the applied fault schedule and the replay command. The same seed gives the same schedule, but timing on a loaded machine can still move a race, so replay a red seed more than once.

## Scenarios

- **`ping-pong`:** sources a and b answer with a limit notice, c has room, and the fallback order is a, b, c. The thread must reach c without going back to a. This is the November 24, 2026 Copilot and Cursor loop (1460).
- **`storm`:** a coordinator on a fans out workers to source w through `delegate_task`, and follow-up messages queue. Meanwhile limits switch on a, b and c, some in the middle of a turn after real work, and the workers' delays change.

## Rules

| Rule                     | Broken when                                                                                                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runs-once`              | A message completes twice, ends with no answer and nothing in the timeline saying why, or runs out of dispatch order. Also broken when the agents answered a different number of turns than the server completed. |
| `result-delivered`       | A worker ended but its delivery is not `delivered`, `acknowledged` or `disposed`. Also broken when its stored result lost its agent's answer, or the launcher's agent was never told the task ended.              |
| `no-return-before-reset` | An automatic fallback goes back to a source before that source's limit resets (60 minutes when the stop names no reset), or one limit stop starts two fallbacks.                                                  |

A message that the person's next message overtook after a visible limit stop is a note, not a violation.

## Limits

- A fake models only what it emits. It reports no background work, so refusals such as 1306 are out of reach.
- Its limit notice names no reset, so a return after a real reset is not exercised.
- The usage readings come from `STUDIO_SIMULATE_PROVIDER_USAGE` and are fixed when the server starts.

`check.test.mjs` covers each rule on synthetic fixtures and runs in the scripts suite. `.github/workflows/chaos-nightly.yml` runs both scenarios nightly as report-only.
