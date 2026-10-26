/**
 * A send that fails only because the host is restarting (an update, a lost
 * socket) is sent again with the same command id once the host is back. The
 * server deduplicates by command id, so a send that did land before the
 * connection dropped is not delivered twice.
 */
import {
  SERVICE_UPDATE_IN_PROGRESS_MESSAGE,
  SERVICE_UPDATE_VERIFYING_MESSAGE,
} from "@specweave-studio/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";

import { THIS_MACHINE_BUSY_TITLE } from "./machineStatus";

const TRANSIENT_TAGS = new Set([
  "EnvironmentRpcUnavailableError",
  "RpcClientError",
  "ServiceUpdateInProgressError",
]);
// A lost socket (RpcClientError) may have carried the request; these never left the window.
const UNSENT_TAGS = new Set(["EnvironmentRpcUnavailableError", "ServiceUpdateInProgressError"]);
const TRANSIENT_MESSAGES = [SERVICE_UPDATE_IN_PROGRESS_MESSAGE, SERVICE_UPDATE_VERIFYING_MESSAGE];

function matchesFailure(error: unknown, tags: ReadonlySet<string>): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const tag = (current as { _tag?: unknown })._tag;
    if (typeof tag === "string" && tags.has(tag)) return true;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && TRANSIENT_MESSAGES.some((text) => message.includes(text))) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Whether the failure means "the host was not there", not "the host said no". */
export function isTransientSendFailure(error: unknown): boolean {
  return matchesFailure(error, TRANSIENT_TAGS);
}

/**
 * Whether the request never reached the host: there was no session, or the
 * host refused it while updating. Sending it again is safe even for a command
 * the host does not deduplicate, such as an approval decision.
 */
export function isUnsentHostFailure(error: unknown): boolean {
  return matchesFailure(error, UNSENT_TAGS);
}

/** What a send this Mac never received says: it is busy, never "not connected". */
export const THIS_MACHINE_NOT_SENT = `${THIS_MACHINE_BUSY_TITLE}, so this was not sent. Try again once it catches up.`;

/** What a send says when this Mac's connection dropped under it: it may have landed. */
export const THIS_MACHINE_MAYBE_SENT = `${THIS_MACHINE_BUSY_TITLE} and stopped answering, so this may not have gone through. Check before trying again.`;

/**
 * The text for a failed send. The app's own machine is never "not connected":
 * a send it did not take while busy says so, instead of the connection's raw
 * "<machine> is not connected." A dropped socket may have carried the request,
 * so it is not called unsent. Another machine keeps the host's own words.
 */
export function hostSendFailureText(
  error: unknown,
  input: { readonly isThisMachine: boolean; readonly fallback: string },
): string {
  if (input.isThisMachine && isUnsentHostFailure(error)) return THIS_MACHINE_NOT_SENT;
  if (input.isThisMachine && isTransientSendFailure(error)) return THIS_MACHINE_MAYBE_SENT;
  return error instanceof Error && error.message ? error.message : input.fallback;
}

export interface TransientRetryOptions {
  /** Resolves true once the host is reachable again, false to give up. */
  readonly waitForHost: () => Promise<boolean>;
  /** Pauses between attempts; the last one repeats until the deadline. */
  readonly delaysMs?: ReadonlyArray<number>;
  /** Total time to keep trying before the send is reported as failed. */
  readonly deadlineMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Called before each retry, for a "Sending again…" hint. */
  readonly onRetry?: (attempt: number) => void;
  /** Which failures are sent again; defaults to {@link isTransientSendFailure}. */
  readonly retryable?: (error: unknown) => boolean;
}

export async function retryTransientSend<A, E>(
  send: () => Promise<AtomCommandResult<A, E>>,
  options: TransientRetryOptions,
): Promise<AtomCommandResult<A, E>> {
  const delays = options.delaysMs ?? [1_000, 2_000, 5_000, 10_000];
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? 3 * 60_000);
  const retryable = options.retryable ?? isTransientSendFailure;
  let attempt = 0;
  for (;;) {
    const result = await send();
    // An interrupt or a refusal from the host is final; only "not there" is retried.
    if (result._tag === "Success" || !retryable(squashAtomCommandFailure(result))) {
      return result;
    }
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 10_000;
    if (now() + delay > deadline) return result;
    await sleep(delay);
    if (!(await options.waitForHost()) || now() > deadline) return result;
    attempt += 1;
    options.onRetry?.(attempt);
  }
}
