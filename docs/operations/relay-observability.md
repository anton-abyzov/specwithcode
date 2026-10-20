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
