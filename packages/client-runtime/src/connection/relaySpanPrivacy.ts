import { RelayClientTracer } from "@specweave-studio/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

/** What a machine's name reads as in a relay span. */
const REDACTED_MACHINE = "<machine>";

const MAX_CAUSE_DEPTH = 8;

function redactText(text: string, labels: ReadonlyArray<string>): string {
  // Longest first: with "Mac" saved and "Mac Upstairs" reported, replacing "Mac" first
  // would leave "<machine> Upstairs".
  const ordered = [...new Set(labels)]
    .filter((label) => label.length > 0)
    .toSorted((left, right) => right.length - left.length);
  let redacted = text;
  for (const label of ordered) redacted = redacted.split(label).join(REDACTED_MACHINE);
  return redacted;
}

const strings = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];

/**
 * Host-written text a failure carries apart from its message: `machineLabel`, `hostText`
 * and `deviceApprovalCode` on connection errors, and the raw auth refusal's
 * `teamRulesMessage` and `approvalCode` before it is mapped.
 */
function carriedLabels(value: unknown, depth = 0): ReadonlyArray<string> {
  if (depth > MAX_CAUSE_DEPTH || typeof value !== "object" || value === null) return [];
  const record = value as Record<string, unknown>;
  return [
    ...strings(record.machineLabel),
    ...strings(record.hostText),
    ...strings(record.deviceApprovalCode),
    ...strings(record.teamRulesMessage),
    ...strings(record.approvalCode),
    ...carriedLabels(record.cause, depth + 1),
    ...carriedLabels(record.error, depth + 1),
  ];
}

/**
 * A copy of a failure that keeps only what an exporter reads (name, message, stack and the
 * cause chain), with every machine name taken out.
 */
function redactFailure(value: unknown, labels: ReadonlyArray<string>, depth = 0): unknown {
  if (typeof value === "string") return redactText(value, labels);
  if (typeof value !== "object" || value === null || depth > MAX_CAUSE_DEPTH) return value;
  const record = value as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    cause?: unknown;
    error?: unknown;
  };
  // A traced attempt failure wraps the connection error it ended with.
  const inner = record.error !== undefined && record.message === undefined ? record.error : value;
  const source = inner as typeof record;
  const message = typeof source.message === "string" ? source.message : String(inner);
  const cause =
    source.cause === undefined ? undefined : redactFailure(source.cause, labels, depth + 1);
  const copy = new Error(redactText(message, labels), cause === undefined ? undefined : { cause });
  if (typeof source.name === "string") copy.name = source.name;
  copy.stack =
    typeof source.stack === "string"
      ? redactText(source.stack, labels)
      : `${copy.name}: ${copy.message}`;
  return copy;
}

function redactExit(
  exit: Exit.Exit<unknown, unknown>,
  labels: ReadonlyArray<string>,
): Exit.Exit<unknown, unknown> {
  if (Exit.isSuccess(exit)) return exit;
  return Exit.failCause(
    Cause.fromReasons(
      exit.cause.reasons.map((reason) => {
        if (Cause.isFailReason(reason)) {
          const all = [...labels, ...carriedLabels(reason.error)];
          return Cause.makeFailReason(redactFailure(reason.error, all));
        }
        if (Cause.isDieReason(reason)) {
          const all = [...labels, ...carriedLabels(reason.defect)];
          return Cause.makeDieReason(redactFailure(reason.defect, all));
        }
        return reason;
      }),
    ),
  );
}

function redactValue(value: unknown, labels: ReadonlyArray<string>): unknown {
  return typeof value === "string" ? redactText(value, labels) : value;
}

function withoutMachineLabels(
  delegate: Tracer.Tracer,
  labels: () => ReadonlyArray<string>,
): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = delegate.span(options);
      const end = span.end.bind(span);
      const attribute = span.attribute.bind(span);
      const event = span.event.bind(span);
      span.end = (endTime, exit) => end(endTime, redactExit(exit, labels()));
      span.attribute = (key, value) => attribute(key, redactValue(value, labels()));
      span.event = (name, startTime, attributes) =>
        event(
          redactText(name, labels()),
          startTime,
          attributes === undefined
            ? undefined
            : Object.fromEntries(
                Object.entries(attributes).map(([key, value]) => [
                  key,
                  redactValue(value, labels()),
                ]),
              ),
        );
      return span;
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
}

/**
 * Relay spans leave the device, so they must not name the person's machines. Spans
 * `effect` exports through the relay tracer get `labels` (and any `machineLabel` a failure
 * carries) replaced in failure text, attributes and events. Local spans, logs and what the
 * person sees keep the names. Apply it outside `withRelayClientTracing`.
 */
export const withoutMachineLabelsInRelaySpans =
  (labels: () => ReadonlyArray<string>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    RelayClientTracer.pipe(
      Effect.flatMap((relayTracer) =>
        effect.pipe(
          Effect.provideService(
            RelayClientTracer,
            Option.map(relayTracer, (tracer) => withoutMachineLabels(tracer, labels)),
          ),
        ),
      ),
    );
