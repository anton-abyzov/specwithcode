import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * When the request in flight must have its answer, in clock milliseconds, or
 * undefined outside an HTTP request. The relay's request deadline sets it, so
 * work late in a request (a machine's endpoint probe after auth, the link
 * lookup and proof signing) can fit inside the time that is actually left.
 */
export class RelayRequestDeadlineAt extends Context.Reference(
  "studio-relay/requestDeadline/RelayRequestDeadlineAt",
  { defaultValue: (): number | undefined => undefined },
) {}

/** Time kept back from the deadline for building and sending the response. */
export const RELAY_RESPONSE_MARGIN_MS = 1_000;

/**
 * How long a step may run: its own limit, cut to what is left before the
 * request deadline minus the response margin, and never below zero.
 */
export const boundedByRequestDeadline = Effect.fnUntraced(function* (limitMs: number) {
  const deadlineAt = yield* RelayRequestDeadlineAt;
  if (deadlineAt === undefined) return limitMs;
  const left = deadlineAt - RELAY_RESPONSE_MARGIN_MS - (yield* Clock.currentTimeMillis);
  return Math.max(0, Math.min(limitMs, left));
});
