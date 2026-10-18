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

const TRANSIENT_TAGS = new Set([
  "EnvironmentRpcUnavailableError",
  "RpcClientError",
  "ServiceUpdateInProgressError",
]);
const TRANSIENT_MESSAGES = [SERVICE_UPDATE_IN_PROGRESS_MESSAGE, SERVICE_UPDATE_VERIFYING_MESSAGE];

/** Whether the failure means "the host was not there", not "the host said no". */
export function isTransientSendFailure(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const tag = (current as { _tag?: unknown })._tag;
    if (typeof tag === "string" && TRANSIENT_TAGS.has(tag)) return true;
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string" && TRANSIENT_MESSAGES.some((text) => message.includes(text))) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
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
}

export async function retryTransientSend<A, E>(
  send: () => Promise<AtomCommandResult<A, E>>,
  options: TransientRetryOptions,
): Promise<AtomCommandResult<A, E>> {
  const delays = options.delaysMs ?? [1_000, 2_000, 5_000, 10_000];
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? 3 * 60_000);
  let attempt = 0;
  for (;;) {
    const result = await send();
    // An interrupt or a refusal from the host is final; only "not there" is retried.
    if (result._tag === "Success" || !isTransientSendFailure(squashAtomCommandFailure(result))) {
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
