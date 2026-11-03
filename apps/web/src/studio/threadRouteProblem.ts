/**
 * What a thread's own page says when it has no conversation to show. It never
 * shows nothing: a link to a thread that cannot open names the reason.
 */
import type { CheckoutUnavailableReason } from "./projectCoordinatorMachine";

/** Long enough for a thread started a moment ago to reach this client. */
export const THREAD_ROUTE_GRACE_MS = 2_000;
export const THREAD_ROUTE_SLOW_MS = 15_000;

export interface ThreadRouteProblemText {
  readonly kind: "opening" | "deleted" | "missing" | "unreachable" | "slow";
  readonly title: string;
  readonly detail: string | null;
}

export function threadRouteProblem(input: {
  /** `missing`: the machine's thread list answered without it. */
  readonly state: "missing" | "loading";
  readonly deleted: boolean;
  readonly host: CheckoutUnavailableReason;
  /** The machine's nickname or host label; null when this device knows neither. */
  readonly machine: string | null;
  readonly waitedMs: number;
}): ThreadRouteProblemText {
  const machine = input.machine ?? "That machine";
  if (input.deleted) return { kind: "deleted", title: "This thread was deleted", detail: null };
  const unreachable = (detail: string): ThreadRouteProblemText => ({
    kind: "unreachable",
    title: "This thread cannot open right now",
    detail,
  });
  // A device learns its other machines shortly after it starts: not yet listed is a wait.
  if (input.host === "host-unknown" && input.waitedMs >= THREAD_ROUTE_SLOW_MS)
    return unreachable(
      "This device is not connected to the machine that holds this thread. Connect it under Settings > Connections.",
    );
  if (input.host === "host-unknown")
    return { kind: "opening", title: "Opening thread...", detail: null };
  if (input.host === "host-refused")
    return unreachable(
      `This device cannot connect to ${machine}. Check it under Settings > Connections.`,
    );
  if (input.host === "host-offline")
    return unreachable(`${machine} is offline. This thread opens when it reconnects.`);
  // Only a connected machine with a current thread list can say a thread is gone.
  const answered = input.state === "missing" && input.host === "not-registered";
  if (answered && input.waitedMs >= THREAD_ROUTE_GRACE_MS)
    return {
      kind: "missing",
      title: "Thread not found",
      detail: `${machine} has no such thread. It may have been removed, or the link is out of date.`,
    };
  if (!answered && input.waitedMs >= THREAD_ROUTE_SLOW_MS)
    return {
      kind: "slow",
      title: "Still waiting for this thread",
      detail: `${machine} has not answered for ${Math.round(THREAD_ROUTE_SLOW_MS / 1000)} seconds. This thread opens as soon as it does.`,
    };
  return { kind: "opening", title: "Opening thread...", detail: null };
}
