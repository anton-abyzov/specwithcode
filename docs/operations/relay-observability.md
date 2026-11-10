# Relay observability

> For maintainers. Using SpecWithCode? See [docs/user](../user/).

The relay Worker sends its logs to Cloudflare Workers Logs. The Worker sets
`observability: { enabled: true, logs: { enabled: true, invocationLogs: true } }` in
[`infra/relay/src/worker.ts`](../../infra/relay/src/worker.ts), so every invocation (fetch, queue,
cron, `HookInboxObject` calls and alarms) and every Effect log line is recorded. Nothing else is
provisioned and no telemetry credential exists.

Read them in the Cloudflare dashboard under Workers & Pages > the relay Worker (the stack's
`workerName` output) > Logs, or stream live with `npx wrangler tail <workerName>`. Filter on the
message or on `$workers.event` fields. For example, the five-minute cron logs
`Finished managed tunnel cleanup` with the sweep result (`mode`, `scanned`, `wouldDelete`,
`deleted`, `wouldDeleteLegacy`, `legacyOver7Days` and so on) when it found
inactive tunnels, and `Failed to clean up inactive managed tunnels` or
`Failed to prune expired relay state` with the cause when a sweep fails.

The relay still opens Effect spans (`relay.*`, `HookInboxStore.*`) and annotates them, but they have
no exporter, so span names and attributes below are not stored anywhere. They cost a few
allocations per request. To export them, provide `Cloudflare.Telemetry()` from Alchemy, which
mirrors Effect spans into Workers Traces (it needs a compatibility date of 2026-08-25 or later).

DPoP proof failures include the stable `relay.dpop.failure_code` span attribute. A `time_window`
failure means that a signed proof was too old or too far in the future for the relay's allowed
window. It can point to a date or time problem on either device, but it can also result from a
delayed request. The client uses this category, and the absence of a category from an older relay,
to decide whether clock skew is confirmed or only one possible cause.

## Webhooks

A public webhook request is one `relay.hooks.forward` span. Its `relay.hook.outcome` says what
happened: `forwarded`, `held`, `rate_limited`, `inbox_full`, `not_found`, `payload_too_large`,
`environment_unavailable`, or `environment_timeout`. `relay.hook.endpoint_key` identifies the
managed endpoint, and with it the environment. On a forward, `relay.hook.upstream_status` or
`relay.hook.upstream_error` records the environment's answer, and
`relay.hook.upstream_outcome` what it did with the request (`accepted`, `duplicate`,
`prompt_too_long`, `queue_full`, `rejected_signature`, `expired`, `disabled`, ...), from its
`x-studio-hook-outcome` response header. A held request's delivery records the same on its
`relay.inbox.deliver` span. The relay sends its own `traceparent` with each forward and drops any a
sender supplied, and signs each forward (`x-studio-relay-delivery`) so the environment trusts the
relay's delivery id, receive time and trace context only from the relay, so on environments that export to SpecWithCode Connect, the environment's
`ScheduledTaskService.triggerWebhook` span lands in the same trace. `relay.hook.rate_limit` says which
budget ran out: `endpoint` or `hook`. `relay.hook.rate_limiter_failed_open` is set when the
Cloudflare rate limiter was unavailable and the request went through unlimited.

Held requests are handled in the endpoint's `HookInboxObject`, and each call into it is its own
trace, not a child of the forward span: `relay.inbox.hold`, `relay.inbox.wake`, and
`relay.inbox.deliver` for each alarm run. Each carries `relay.hook.endpoint_key`, so they join to
forwards. The details are on the child spans: `HookInboxStore.hold` carries
`relay.inbox.refused` when the inbox refused a request (`max_per_hook`, `max_requests`,
`max_bytes`, or `already_held`). `HookInboxStore.deliverDue` carries `relay.inbox.run_result`
(`drained`, `more_pending`, `busy`, or `unreachable`), how many requests it sent and delivered,
the consecutive failures behind the retry delay, the longest time a delivered request waited, and
the backlog left. A run that errored outright has `relay.inbox.run_result = failed` on the root
`relay.inbox.deliver` span instead.

## Crash reports and site events

Two unauthenticated endpoints take anonymous reports. Neither stores anything: each accepted
request writes one Effect log line to Workers Logs and answers 202 `{ "ok": true }`. Both accept
`application/json` and `text/plain` (what `navigator.sendBeacon` sends) and get the relay's normal
CORS headers, so the marketing sites (`https://specwithcode.com`, `https://spec-weave.com`) can
post to them. Rejections answer `{ "error": "<code>" }`: 400 `invalid_body`, 413
`payload_too_large`, 415 `unsupported_media_type`, or 429 `rate_limited` with `retry-after: 60`.
The code is in [`infra/relay/src/reports/Reports.ts`](../../infra/relay/src/reports/Reports.ts);
the payload format and sanitizing rules are in
[`packages/shared/src/crashReport.ts`](../../packages/shared/src/crashReport.ts).

`POST /v1/crash-reports` takes a body of at most 16 KiB (`CRASH_REPORT_MAX_BYTES`, checked on
`content-length` and again while the body streams in). The relay validates and re-sanitizes it
with `parseCrashReport`, then logs a warning with the message `crash_report` and these fields:
`log` (always `crash_report`), `surface`, `kind`, `category`, `appVersion`, `os`, `osVersion`,
`arch`, `provider`, `model`, `errorName`, `message`, `stack`, `detail`, `count`, `machine`,
`installIdHash`, `country` and `bytes`. Optional fields are left out when the report has none.
`installIdHash` is the first 16 hex characters of the install id's SHA-256 digest, so repeats from
one installation group together without the raw id being logged. Reports never carry prompts,
responses, file contents, tokens, account, thread or project ids, or raw paths.

`POST /v1/site-events` takes a body of at most 1 KiB (`SITE_EVENT_MAX_BYTES`) parsed with
`parseSiteEvent`, and logs an info line with the message `site_event` and the fields `log` (always
`site_event`), `event` (`download_click` or `install_copy`), `platform`, `asset`, `page` and
`country`. The client IP is used only, hashed, as a rate limit key.

Limits use Cloudflare Rate Limiting bindings, keyed with the stage prepended:

| Binding                          | Namespace | Key                       | Limit       |
| -------------------------------- | --------- | ------------------------- | ----------- |
| `CRASH_REPORT_RATE_LIMIT`        | 1003      | SHA-256 of the install id | 10 per 60s  |
| `CRASH_REPORT_GLOBAL_RATE_LIMIT` | 1004      | one shared key            | 600 per 60s |
| `SITE_EVENT_RATE_LIMIT`          | 1005      | SHA-256 of the client IP  | 30 per 60s  |

The shared crash report budget is checked first, so minting fresh install ids cannot flood the
logs. The edge per-IP rule from `infra/relay/scripts/edge-rules.mjs` also covers both paths. If a
limiter errors, the request goes through, the relay logs `Report rate limiter unavailable`, and
the span carries `relay.crash.rate_limiter_failed_open` or
`relay.site_event.rate_limiter_failed_open`.

Spans: `relay.reports.crash` with `relay.crash.outcome` (`accepted`, `rate_limited`,
`payload_too_large`, `invalid_body`, `unsupported_media_type`), `relay.crash.rate_limit`
(`global` or `install`), `relay.crash.surface` and `relay.crash.kind`; and
`relay.reports.site_event` with `relay.site_event.outcome`. Like every relay span, they are not
exported.

To read them:

- Live: `npx wrangler tail <workerName> --search crash_report` (or `--search site_event`). Add
  `--format json` to get each line's fields as JSON.
- Dashboard: Workers & Pages > the relay Worker > Logs, then filter on `log = crash_report` (or
  `site_event`) and group or filter by `surface`, `category`, `appVersion` or `installIdHash`.
  Workers Logs extracts the fields from the logged object, so they can be queried directly.

The Worker's Effect logger is the console pretty logger: each line is written as a header line
(`[time] WARN (#fiber): crash_report`) followed by the fields object as its own console entry. The
`log` field is on the object entry, so a filter on `log` finds the fields, and a search on the
message text finds both entries.
