import {
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type ScheduledTask,
  type ScheduledTaskError,
  ScheduledTaskId,
  ScheduledTaskWebhookDeliveryId,
  type ScheduledTaskGetWebhookDeliveryInput,
  type ScheduledTaskGetWebhookDeliveryResult,
  type ScheduledTaskListWebhookDeliveriesInput,
  type ScheduledTaskListWebhookDeliveriesResult,
  type ScheduledTaskWebhookDeliveryOutcome,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import type { PlatformError } from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as Metrics from "../observability/Metrics.ts";
import {
  decodeRow,
  decodeTaskId,
  iso,
  taskError,
  type ScheduledTaskRow,
  type WebhookDeliveryRow,
} from "./ScheduledTaskStorage.ts";
import type {
  RateWindow,
  WebhookDeliveryOutcome,
  WebhookDeliverySkipped,
  WebhookTriggerRequest,
  WebhookTriggerResult,
} from "./ScheduledTaskTypes.ts";
import { redactHeaders, redactQuery, renderWebhookPrompt } from "./webhookTemplate.ts";
import { constantTimeEquals, verifyWebhookSignature } from "./webhookVerification.ts";

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);
/** Deliveries kept per task; older ones are pruned on insert. */
const WEBHOOK_DELIVERY_RETENTION = 50;
/** Body text kept in the delivery log. Larger bodies are cut and flagged. */
const WEBHOOK_DELIVERY_LOG_BODY_LIMIT = 64 * 1024;
/** Rendered prompt text kept in the delivery log. */
const WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT = 64 * 1024;
/** Deliveries one task may hold at once, running or waiting their turn. */
const WEBHOOK_MAX_QUEUED_PER_TASK = 20;
/** Accepted deliveries per task per minute, enforced here as well as on the relay because the tunnel hostname is public too. */
const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;

const HeadersJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const MissingFieldsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeHeadersJson = Schema.decodeUnknownOption(HeadersJson);
const decodeMissingFieldsJson = Schema.decodeUnknownOption(MissingFieldsJson);
const encodeHeadersJson = Schema.encodeSync(HeadersJson);
const encodeMissingFieldsJson = Schema.encodeSync(MissingFieldsJson);

/**
 * A webhook task's delivery log and request handling: each request is
 * verified, logged and dispatched through `runTask`, which runs it in the
 * background so the sender gets its answer at once. Built inside the
 * service's scope, which the background runs are forked into.
 */
export const makeWebhookTrigger = Effect.fnUntraced(function* (deps: {
  readonly getRows: (
    id: ScheduledTaskId,
  ) => Effect.Effect<ReadonlyArray<ScheduledTaskRow>, SqlError.SqlError>;
  readonly runTask: (
    task: ScheduledTask,
    webhook: { readonly deliveryId: string; readonly prompt: string },
  ) => Effect.Effect<ScheduledTask, ScheduledTaskError | WebhookDeliverySkipped | PlatformError>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  // Webhook deliveries for one task dispatch in arrival order rather than
  // being dropped while an earlier delivery is still dispatching.
  const webhookPermits = yield* Ref.make<ReadonlyMap<ScheduledTaskId, Semaphore.Semaphore>>(
    new Map(),
  );
  // Keyed by task id and creation time, so deliveries of a deleted task that
  // finish late release their own count, never a recreated task's.
  const webhookQueued = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  const webhookRateWindows = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RateWindow>>(new Map());

  const deliveryHeaders = (row: WebhookDeliveryRow): Readonly<Record<string, string>> =>
    Option.getOrElse(decodeHeadersJson(row.headers_json), () => ({}));
  const decodeDeliverySummary = (row: WebhookDeliveryRow) => ({
    id: ScheduledTaskWebhookDeliveryId.make(row.delivery_id),
    taskId: ScheduledTaskId.make(row.task_id),
    receivedAt: row.received_at,
    method: row.method,
    contentType: deliveryHeaders(row)["content-type"] ?? null,
    bodyBytes: row.body_bytes,
    outcome: row.outcome as ScheduledTaskWebhookDeliveryOutcome,
    signatureVerified: row.signature_verified === 1,
    missingFields: Option.getOrElse(decodeMissingFieldsJson(row.missing_fields_json), () => []),
    error: row.error,
  });

  const listWebhookDeliveries = (
    input: ScheduledTaskListWebhookDeliveriesInput,
  ): Effect.Effect<ScheduledTaskListWebhookDeliveriesResult, ScheduledTaskError> =>
    sql<WebhookDeliveryRow>`
        SELECT * FROM scheduled_task_webhook_deliveries
        WHERE task_id = ${input.id}
        ORDER BY received_at DESC, rowid DESC
      `.pipe(
      Effect.map((rows) => ({ deliveries: rows.map(decodeDeliverySummary) })),
      Effect.mapError((cause) =>
        taskError("Could not list webhook deliveries.", { taskId: input.id, cause }),
      ),
    );

  const getWebhookDelivery = (
    input: ScheduledTaskGetWebhookDeliveryInput,
  ): Effect.Effect<ScheduledTaskGetWebhookDeliveryResult, ScheduledTaskError> =>
    Effect.gen(function* () {
      const rows = yield* sql<WebhookDeliveryRow>`
          SELECT * FROM scheduled_task_webhook_deliveries
          WHERE task_id = ${input.id} AND delivery_id = ${input.deliveryId}
        `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not load webhook delivery.", { taskId: input.id, cause }),
        ),
      );
      const row = rows[0];
      if (row === undefined) {
        return yield* taskError("Webhook delivery not found.", { taskId: input.id });
      }
      return {
        delivery: {
          ...decodeDeliverySummary(row),
          query: row.query,
          headers: deliveryHeaders(row),
          body: row.body,
          bodyTruncated: row.body_truncated === 1,
          renderedPrompt: row.rendered_prompt,
        },
      };
    });

  const recordDelivery = (input: {
    readonly id: string;
    readonly taskId: ScheduledTaskId;
    readonly receivedAt: string;
    readonly request: WebhookTriggerRequest;
    readonly outcome: ScheduledTaskWebhookDeliveryOutcome;
    readonly signatureVerified: boolean;
    readonly missing: ReadonlyArray<string>;
    readonly renderedPrompt: string | null;
    readonly error?: string;
  }) => {
    const truncated = input.request.body.byteLength > WEBHOOK_DELIVERY_LOG_BODY_LIMIT;
    const loggedBody = truncated
      ? new TextDecoder().decode(input.request.body.subarray(0, WEBHOOK_DELIVERY_LOG_BODY_LIMIT))
      : input.request.bodyText;
    return sql
      .withTransaction(
        Effect.gen(function* () {
          // Conditional on the task existing, so a delivery racing a delete
          // cannot leave rows that a recreated task with the same id would show.
          yield* sql`
              INSERT INTO scheduled_task_webhook_deliveries (
                delivery_id, task_id, received_at, method, query, headers_json, body,
                body_bytes, body_truncated, outcome, signature_verified,
                missing_fields_json, rendered_prompt, error
              )
              SELECT
                ${input.id}, ${input.taskId}, ${input.receivedAt}, ${input.request.method},
                ${redactQuery(input.request.query)},
                ${encodeHeadersJson(redactHeaders(input.request.headers))},
                ${loggedBody},
                ${input.request.body.byteLength}, ${truncated ? 1 : 0}, ${input.outcome},
                ${input.signatureVerified ? 1 : 0}, ${encodeMissingFieldsJson(input.missing)},
                ${input.renderedPrompt?.slice(0, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT) ?? null},
                ${input.error ?? null}
              WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${input.taskId})
              -- A held request retried after a rate limit reuses its relay
              -- delivery id; the newer attempt replaces the logged one.
              ON CONFLICT (delivery_id) DO UPDATE SET
                outcome = excluded.outcome,
                signature_verified = excluded.signature_verified,
                missing_fields_json = excluded.missing_fields_json,
                rendered_prompt = excluded.rendered_prompt,
                error = excluded.error
            `;
          yield* sql`
            DELETE FROM scheduled_task_webhook_deliveries
            WHERE task_id = ${input.taskId}
              AND delivery_id NOT IN (
                SELECT delivery_id FROM scheduled_task_webhook_deliveries
                WHERE task_id = ${input.taskId}
                -- rowid breaks timestamp ties in arrival order; delivery ids are random.
                ORDER BY received_at DESC, rowid DESC
                LIMIT ${WEBHOOK_DELIVERY_RETENTION}
              )
          `;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          taskError("Could not record webhook delivery.", { taskId: input.taskId, cause }),
        ),
      );
  };

  const markDeliveryFailed = (deliveryId: string, message: string) =>
    sql`
        UPDATE scheduled_task_webhook_deliveries
        SET outcome = 'dispatch_failed', error = ${message}
        WHERE delivery_id = ${deliveryId}
      `.pipe(Effect.ignore);

  /**
   * Sliding one-minute window counting every request with a valid token,
   * including ones the signature check later rejects.
   */
  const takeRateSlot = (id: ScheduledTaskId, nowMs: number) =>
    Ref.modify(
      webhookRateWindows,
      (
        windows,
      ): readonly [
        "allowed" | "first_rejected" | "rejected",
        ReadonlyMap<ScheduledTaskId, RateWindow>,
      ] => {
        const current = windows.get(id);
        const recent = (current?.accepted ?? []).filter((at) => nowMs - at < 60_000);
        if (recent.length >= WEBHOOK_RATE_LIMIT_PER_MINUTE) {
          const first = current?.rejectedLogged !== true;
          return [
            first ? "first_rejected" : "rejected",
            new Map(windows).set(id, { accepted: recent, rejectedLogged: true }),
          ];
        }
        return [
          "allowed",
          new Map(windows).set(id, { accepted: [...recent, nowMs], rejectedLogged: false }),
        ];
      },
    );

  const webhookPermit = (id: ScheduledTaskId) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(webhookPermits)).get(id);
      if (existing !== undefined) return existing;
      const created = yield* Semaphore.make(1);
      return yield* Ref.modify(webhookPermits, (permits) => {
        const raced = permits.get(id);
        return raced === undefined
          ? [created, new Map(permits).set(id, created)]
          : [raced, permits];
      });
    });

  // Detached from the request so the HTTP response does not wait for the
  // run; scoped to the service so shutdown interrupts it.
  const serviceScope = yield* Effect.scope;

  /**
   * Records one handled request on the span and in metrics. `outcome` is
   * finer than the result tag: it separates a full queue and an oversized
   * prompt from the rest, which is what an operator needs to act on.
   */
  const observeDelivery = (
    request: WebhookTriggerRequest,
    outcome: WebhookDeliveryOutcome,
    receivedAt: DateTime.DateTime | undefined,
    now: DateTime.DateTime | undefined,
  ) =>
    Effect.gen(function* () {
      const source = request.relayDeliveryId === undefined ? "direct" : "relay";
      yield* Effect.annotateCurrentSpan({
        "scheduled_task.webhook.outcome": outcome,
        "scheduled_task.webhook.source": source,
      });
      yield* Metrics.increment(Metrics.webhookDeliveriesTotal, { outcome, source });
      if (request.receivedAt !== undefined && receivedAt !== undefined && now !== undefined) {
        const heldMs = Math.max(
          0,
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt),
        );
        yield* Effect.annotateCurrentSpan({ "scheduled_task.webhook.held_ms": heldMs });
        yield* Metric.update(Metrics.webhookHeldDelay, Duration.millis(heldMs));
      }
    });

  const triggerWebhook = (
    request: WebhookTriggerRequest,
  ): Effect.Effect<WebhookTriggerResult, ScheduledTaskError> =>
    triggerWebhookUnobserved(request).pipe(
      Effect.tapError(() => observeDelivery(request, "error", undefined, undefined)),
      Metrics.withMetrics({ timer: Metrics.webhookDeliveryDuration }),
      Effect.withSpan("ScheduledTaskService.triggerWebhook", {
        attributes: {
          "scheduled_task.webhook.method": request.method,
          "scheduled_task.webhook.body_bytes": request.body.byteLength,
          "scheduled_task.webhook.source":
            request.relayDeliveryId === undefined ? "direct" : "relay",
        },
      }),
    );

  const triggerWebhookUnobserved = (request: WebhookTriggerRequest) =>
    Effect.gen(function* () {
      const taskId = decodeTaskId(request.hookId);
      const notFound = observeDelivery(request, "not_found", undefined, undefined).pipe(
        Effect.as({ _tag: "not_found" as const }),
      );
      if (Option.isNone(taskId)) return yield* notFound;
      const rows = yield* deps
        .getRows(taskId.value)
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not load schedule task.", { taskId: taskId.value, cause }),
          ),
        );
      const row = rows[0];
      // A wrong token is indistinguishable from an unknown hook, so the URL
      // does not reveal which hooks exist.
      if (
        row === undefined ||
        row.webhook_token === null ||
        !constantTimeEquals(request.token, row.webhook_token)
      ) {
        return yield* notFound;
      }
      const task = yield* decodeRow(row);
      yield* Effect.annotateCurrentSpan({ "scheduled_task.id": task.id });
      const schedule = task.schedule;
      if (schedule.type !== "webhook") return yield* notFound;

      const now = yield* localNow;
      // Anyone can reach the tunnel directly and set the relay's header, so
      // a receive time is never later than now: a future one would pin the
      // delivery in the log and slip past the task's max age.
      const receivedAt =
        request.receivedAt === undefined
          ? now
          : DateTime.min(
              Option.getOrElse(DateTime.make(request.receivedAt), () => now),
              now,
            );
      const observe = (outcome: WebhookDeliveryOutcome) =>
        observeDelivery(request, outcome, receivedAt, now);
      const deliveryId = ScheduledTaskWebhookDeliveryId.make(
        request.relayDeliveryId === undefined
          ? `delivery:${yield* crypto.randomUUIDv4.pipe(
              Effect.mapError((cause) => taskError("Could not generate delivery id.", { cause })),
            )}`
          : `delivery:relay:${request.relayDeliveryId}`,
      );
      // A held request may already have reached this environment directly
      // before a timeout; it runs once. Claimed in its own table, kept longer
      // than the relay holds a request, because the delivery log is trimmed.
      // A rate-limited delivery stays held on the relay, so it must give up
      // its claim or the next pass would treat it as already delivered.
      const releaseClaim = <A>(result: A) =>
        request.relayDeliveryId === undefined
          ? Effect.succeed(result)
          : sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE relay_delivery_id = ${request.relayDeliveryId}
              `.pipe(Effect.ignore, Effect.as(result));
      // From the claim until the run is forked nothing may interrupt: a
      // request dropped in between (the relay hangs up after its timeout)
      // would leave a claimed delivery that never runs, or a queue slot
      // that is never released. Everything in here is local and quick.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (request.relayDeliveryId !== undefined) {
            const claimed = yield* sql<{ relay_delivery_id: string }>`
                INSERT INTO scheduled_task_webhook_relay_deliveries
                  (relay_delivery_id, task_id, seen_at)
                VALUES (${request.relayDeliveryId}, ${task.id}, ${iso(now)})
                ON CONFLICT (relay_delivery_id) DO NOTHING
                RETURNING relay_delivery_id
              `.pipe(
              Effect.mapError((cause) =>
                taskError("Could not record webhook delivery.", { taskId: task.id, cause }),
              ),
            );
            if (claimed.length === 0) {
              // A held request this environment already ran: accepted, not run twice.
              yield* observe("duplicate");
              return { _tag: "accepted" as const, deliveryId, outcome: "duplicate" as const };
            }
            // Older claims can no longer be replayed by the relay.
            yield* sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE seen_at < ${iso(DateTime.subtract(now, { hours: 48 }))}
              `.pipe(Effect.ignore);
          }
          const log = (
            outcome: ScheduledTaskWebhookDeliveryOutcome,
            details: {
              readonly signatureVerified?: boolean;
              readonly missing?: ReadonlyArray<string>;
              readonly renderedPrompt?: string;
              readonly error?: string;
            } = {},
          ) =>
            recordDelivery({
              id: deliveryId,
              taskId: task.id,
              receivedAt: iso(receivedAt),
              request,
              outcome,
              signatureVerified: details.signatureVerified ?? false,
              missing: details.missing ?? [],
              renderedPrompt: details.renderedPrompt ?? null,
              ...(details.error === undefined ? {} : { error: details.error }),
            });

          // Only the first rejected request in a window is logged, so a flood
          // cannot write rows or push the real deliveries out of the log.
          const slot = yield* takeRateSlot(task.id, DateTime.toEpochMillis(now));
          if (slot !== "allowed") {
            if (slot === "first_rejected") yield* log("rate_limited");
            yield* observe("rate_limited");
            return yield* releaseClaim({
              _tag: "rate_limited" as const,
              outcome: "rate_limited" as const,
            });
          }
          if (!task.enabled) {
            yield* log("disabled");
            yield* observe("disabled");
            return { _tag: "disabled" as const };
          }
          const signature = schedule.signature;
          if (signature !== null) {
            const verified =
              row.webhook_secret !== null &&
              verifyWebhookSignature({
                signature,
                secret: row.webhook_secret,
                headers: request.headers,
                body: request.body,
              });
            if (!verified) {
              yield* log("rejected_signature");
              yield* observe("rejected_signature");
              return { _tag: "rejected_signature" as const };
            }
          }
          const maxAgeMinutes = schedule.maxDeliveryAgeMinutes ?? null;
          if (
            maxAgeMinutes !== null &&
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt) >
              maxAgeMinutes * 60_000
          ) {
            yield* log("expired", { signatureVerified: signature !== null });
            yield* observe("expired");
            return { _tag: "expired" as const };
          }

          const rendered = renderWebhookPrompt(task.prompt, request);
          // A provider refuses a turn this long, so it is not started. The
          // delivery is not retryable, so the claim is kept. Providers trim
          // the prompt before checking, so whitespace around it is free.
          if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
            yield* log("dispatch_failed", {
              signatureVerified: signature !== null,
              missing: rendered.missing,
              renderedPrompt: rendered.prompt,
              error: "The filled-in prompt is too long.",
            });
            yield* observe("prompt_too_long");
            return { _tag: "accepted" as const, deliveryId, outcome: "prompt_too_long" as const };
          }
          // Bound the deliveries one task holds, so steady traffic to a stuck
          // task cannot pile up parked fibers. A refused request is not logged,
          // so it cannot push real deliveries out of the log.
          const queueKey = `${task.id}\u0000${task.createdAt}`;
          const queued = yield* Ref.modify(webhookQueued, (counts) => {
            const count = counts.get(queueKey) ?? 0;
            return count >= WEBHOOK_MAX_QUEUED_PER_TASK
              ? ([false, counts] as const)
              : ([true, new Map(counts).set(queueKey, count + 1)] as const);
          });
          if (!queued) {
            // The task is busy with WEBHOOK_MAX_QUEUED_PER_TASK deliveries already.
            yield* observe("queue_full");
            return yield* releaseClaim({
              _tag: "rate_limited" as const,
              outcome: "queue_full" as const,
            });
          }
          // Entries leave the map when their count reaches zero, so a deleted
          // task's key does not linger once its last delivery finishes.
          const release = Ref.update(webhookQueued, (counts) => {
            const next = new Map(counts);
            const count = (next.get(queueKey) ?? 1) - 1;
            if (count <= 0) next.delete(queueKey);
            else next.set(queueKey, count);
            return next;
          });
          yield* log("accepted", {
            signatureVerified: signature !== null,
            missing: rendered.missing,
            renderedPrompt: rendered.prompt,
          }).pipe(Effect.onError(() => release));
          yield* observe("accepted");
          const permit = yield* webhookPermit(task.id);
          const runOutcome = (outcome: "started" | "skipped" | "failed") =>
            Effect.all([
              Effect.annotateCurrentSpan({ "scheduled_task.webhook.run_outcome": outcome }),
              Metrics.increment(Metrics.webhookRunsTotal, { outcome }),
            ]);
          yield* deps.runTask(task, { deliveryId, prompt: rendered.prompt }).pipe(
            Effect.flatMap((completed) =>
              completed.lastRunStatus === "failed"
                ? runOutcome("failed").pipe(
                    Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
                  )
                : runOutcome("started"),
            ),
            Effect.catchTags({
              WebhookDeliverySkipped: (skipped) =>
                runOutcome("skipped").pipe(
                  Effect.andThen(markDeliveryFailed(deliveryId, skipped.reason)),
                ),
            }),
            // The log is readable over RPC, so it gets a fixed reason; the
            // cause, which can carry request data, stays in the server log.
            Effect.catchCause((cause) =>
              Effect.logWarning("Webhook dispatch failed", { taskId: task.id, cause }).pipe(
                Effect.andThen(runOutcome("failed")),
                Effect.andThen(markDeliveryFailed(deliveryId, "The run failed to start.")),
              ),
            ),
            permit.withPermits(1),
            // Its own trace: the request that triggered it has already been answered.
            Effect.withSpan("ScheduledTaskService.runWebhookDelivery", {
              root: true,
              attributes: {
                "scheduled_task.id": task.id,
                "scheduled_task.webhook.delivery_id": deliveryId,
              },
            }),
            Effect.ensuring(release),
            Effect.forkIn(serviceScope),
          );
          return { _tag: "accepted" as const, deliveryId, outcome: "accepted" as const };
        }),
      );
    });

  /** Drops a deleted task's rate window and dispatch order. */
  const forget = (id: ScheduledTaskId) =>
    Effect.all([
      Ref.update(webhookRateWindows, (windows) => {
        const next = new Map(windows);
        next.delete(id);
        return next;
      }),
      Ref.update(webhookPermits, (permits) => {
        const next = new Map(permits);
        next.delete(id);
        return next;
      }),
    ]).pipe(Effect.asVoid);

  return { listWebhookDeliveries, getWebhookDelivery, triggerWebhook, forget };
});
