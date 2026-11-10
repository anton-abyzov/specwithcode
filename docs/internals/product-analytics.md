# Product analytics

The server owns PostHog delivery, opt-out, and identity for every connected client.
[Identity selection](../../apps/server/src/telemetry/Identify.ts) hashes an available
provider account ID, falling back to an installation-scoped ID. This identity can
span several clients; it does not identify a browser session. Clients do not load
the PostHog browser SDK. Client-use events require an authenticated connection, so
visiting the hosted app without connecting does not count as product use.

## Attribution boundaries

Client dimensions belong to the event's WebSocket connection. A server-global
"current client" would misattribute simultaneous web, desktop, and mobile use.
Provider execution has its own events because a turn can outlive the requesting
connection.

Keep client and server dimensions separate. A desktop host can serve a phone or a
remote browser, and a direct connection can cross a network. Older clients omit
metadata. Missing client values must stay unknown rather than being backfilled
from server properties. The legacy `clientType` property describes how the server
runs; use `surface` for the connected client.

## Interpreting events

Use `client.turn.requested` for active-use reports. `client.connected` counts
reconnects, so network behavior can inflate it. One identity can appear in several
client groups during a period; adding those groups double-counts users.

Provider send and completion counts need not match. Providers can emit synthetic
turns without a send request. Collection is best effort, with no scan or backfill
of provider history.

Token totals cover the main agent. Child agents and model rerouting prevent a turn
from representing one provider/model combination's full cost. For provider
comparisons, require complete usage, no observed subagents, and no mixed models;
compare matching model, effort, interaction mode, and terminal status. Aggregate
output/input ratios should divide the summed totals. Averaging per-turn ratios
lets small-input turns dominate.

Unknown counts stay absent. Partial usage contains valid observed counts but
cannot establish a whole-turn total. Keep these distinctions when changing token
normalization or building reports.

## Delivery

A send can fail after PostHog has stored the batch, so every retry is a copy.
[Delivery](../../apps/server/src/telemetry/AnalyticsService.ts) gives each event a
uuid when it is recorded, backs off after a failed send, and drops a batch after a
few tries. Without these limits, one stuck batch was sent every second for days.

## Collection boundary

Keep analytics payloads to product metadata and normalized measurements. Do not
send prompts, authentication material, raw provider payloads, user-assigned device
names, or conversation identifiers. Client metadata is best effort; invalid values
must not reject a connection. PostHog person profiles remain disabled.

## Crash reports

Crash reports are separate from PostHog analytics and on by default. The payload,
sanitizing, the 16 KiB cap and relay validation live in
[crashReport.ts](../../packages/shared/src/crashReport.ts): every sender calls
`buildCrashReport` and `encodeCrashReport`, and the relay calls `parseCrashReport`
again before writing one Workers Logs line. Never add a field there that can hold
prompts, responses, file contents, tokens, account, conversation, thread or project
ids, or raw paths. Free text goes through the sanitizer, which turns home paths into
`~`, other paths in messages into `<path>`, and redacts secrets, emails, uuids and IPs.

Senders:

- Server: `CrashReporter` reports uncaught errors, fatal exits and failed turns, with
  provider and model. It is active when the `crashReportsEnabled` server setting is on
  and `STUDIO_CRASH_REPORTS` is not false. `ServerObservability.crashReportsActive` and
  `crashReportsForcedOff` tell the settings page the startup state.
- Desktop: `DesktopCrashReporter` in the main process reports uncaught exceptions,
  rejections, renderer and child process exits, and server exits.
- Mobile: [crashReporting.ts](../../apps/mobile/src/features/diagnostics/crashReporting.ts)
  writes fatal reports to disk first and sends them on the next launch.

All of them post to `POST /v1/crash-reports` on `relay.spec-weave.com`. The install id is
a random UUID kept in a file, never an account id, and `crashReportMachineLabel` sends
only OS, arch and a short hostname hash.

Clients fold repeats with `crashReportFingerprint` and send one report with a `count`,
cap reports per session, use timeouts of 5 seconds or less, never retry in a loop and
never block startup or shutdown. The relay answers 400, 413, 415 or 429 for bad, large,
wrong-type or rate-limited bodies.

`STUDIO_CRASH_REPORT_URL` overrides the relay origin (https only), for example a staging
relay. `STUDIO_CRASH_REPORT_SELF_TEST` sends one `test` report at startup so you can check
delivery end to end in Workers Logs. Tests must stub sending; no test may reach the network.
When reports are off, senders make no requests and write no files.
