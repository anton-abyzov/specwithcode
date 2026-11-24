/**
 * One record per alert delivery decision (1436 AC-05): which app showed a
 * thread's alert and why the others did not. Ids, kinds and reasons only,
 * never message text or a thread title. Written as a span whose event keeps it
 * through trace sampling, into this machine's existing trace files.
 *
 * @module notificationDeliveryRecord
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as ClientTracer from "./observability/clientTracer";

export const NOTIFICATION_DELIVERY_SPAN = "notification.delivery";
export const NOTIFICATION_DELIVERY_EVENT = "notification.delivery.decided";

export type NotificationDeliveryOutcome = "toast" | "system" | "badge" | "held-back" | "none";

export interface NotificationDeliveryRecord {
  /** This app's own machine; null in a browser that is not on one. */
  readonly machine: string | null;
  /** The machine that serves the thread. */
  readonly servingMachine: string;
  readonly threadId: string;
  /** "action:approval", "operational", "completion", "stalled". */
  readonly kind: string;
  readonly focused: boolean;
  /** Whether the thread was the one open in this window. */
  readonly openThread: boolean;
  readonly ownerMachine: string;
  readonly targetClientId: string | null;
  readonly targetReason: string | null;
  readonly ownerInUse: boolean | null;
  /** Why this app held back or not; see OwnerHoldWhy. */
  readonly holdWhy: string;
  /** "first" when the alert arrived, "recheck" for the one read after a hold. */
  readonly phase: "first" | "recheck";
  readonly outcome: NotificationDeliveryOutcome;
  /** Why this outcome: a short reason id. */
  readonly why: string;
}

/** The attributes written, keyed for the trace file. A null value is left out, as OTLP has none. */
export function deliveryRecordAttributes(
  record: NotificationDeliveryRecord,
): Record<string, string | boolean> {
  const all: Record<string, string | boolean | null> = {
    "notification.machine": record.machine,
    "notification.serving_machine": record.servingMachine,
    "notification.thread_id": record.threadId,
    "notification.kind": record.kind,
    "notification.focused": record.focused,
    "notification.open_thread": record.openThread,
    "notification.owner_machine": record.ownerMachine,
    "notification.target_client_id": record.targetClientId,
    "notification.target_reason": record.targetReason,
    "notification.owner_in_use": record.ownerInUse,
    "notification.hold_why": record.holdWhy,
    "notification.phase": record.phase,
    "notification.outcome": record.outcome,
    "notification.why": record.why,
  };
  return Object.fromEntries(
    Object.entries(all).filter((entry): entry is [string, string | boolean] => entry[1] !== null),
  );
}

type Sink = (record: NotificationDeliveryRecord) => void;

const traceSink: Sink = (record) => {
  const attributes = deliveryRecordAttributes(record);
  Effect.runFork(
    Effect.gen(function* () {
      const span = yield* Effect.currentSpan;
      const nowNs = yield* Clock.currentTimeNanos;
      // An event other than a commit keeps the span through sampling.
      span.event(NOTIFICATION_DELIVERY_EVENT, nowNs, attributes);
    }).pipe(
      Effect.withSpan(NOTIFICATION_DELIVERY_SPAN, { attributes }),
      Effect.provide(ClientTracer.layer),
      Effect.ignore,
    ),
  );
};

let sink: Sink = traceSink;

export function recordNotificationDelivery(record: NotificationDeliveryRecord): void {
  try {
    sink(record);
  } catch {
    // A record never stops an alert.
  }
}

export function __setNotificationDeliverySinkForTests(next: Sink | null): void {
  sink = next ?? traceSink;
}
