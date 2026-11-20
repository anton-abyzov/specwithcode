/**
 * Threads whose Stop is still ending processes. A run can settle before what its CLI
 * started has ended (the CLI acknowledges the interrupt first, or exits before its tools),
 * so the project folder change also waits on this: it moves nothing while a tool of the
 * stopped run may still write in the old folder.
 *
 * One registry per server process; entries are counted, so overlapping Stops of one
 * thread each hold it until they end.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

const pending = new Map<string, number>();
/**
 * Threads whose Stop could not end everything: processes of a stopped CLI that still ran,
 * or could not be confirmed gone, after every try. One entry per teardown, so a second
 * failed Stop of the thread never hides the first. They block the folder change until
 * a retry (the folder flow's Stop runs one) confirms each gone, or the server restarts.
 */
const failed = new Map<string, Set<() => Promise<boolean>>>();

/** Holds `threadId` until the returned release is called (once; later calls do nothing). */
export function beginStopTeardown(threadId: string): () => void {
  pending.set(threadId, (pending.get(threadId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (pending.get(threadId) ?? 1) - 1;
    if (left <= 0) pending.delete(threadId);
    else pending.set(threadId, left);
  };
}

export function stopTeardownPending(threadId: string): boolean {
  return pending.has(threadId) || failed.has(threadId);
}

/** Whether Stop gave up on processes of this thread that may still run. */
export function stopTeardownFailed(threadId: string): boolean {
  return failed.has(threadId);
}

/**
 * Keeps `threadId` blocked until `retry` resolves true (on a later retry), or until the
 * returned release is called: by the owner, once it learns by itself that all is gone.
 */
export function holdFailedStopTeardown(
  threadId: string,
  retry: () => Promise<boolean>,
): () => void {
  const entries = failed.get(threadId) ?? new Set();
  entries.add(retry);
  failed.set(threadId, entries);
  return () => {
    entries.delete(retry);
    if (entries.size === 0 && failed.get(threadId) === entries) failed.delete(threadId);
  };
}

/** The longest one retry may take: one that never answers keeps its hold. */
const RETRY_TIMEOUT_MS = 20_000;

/**
 * Tries every failed teardown of the thread again, at once and each within `timeoutMs`;
 * true once nothing of any is left.
 */
export async function retryFailedStopTeardown(
  threadId: string,
  timeoutMs = RETRY_TIMEOUT_MS,
): Promise<boolean> {
  const entries = failed.get(threadId);
  if (entries === undefined) return true;
  await Promise.all(
    [...entries].map(async (retry) => {
      const done = await Effect.runPromise(
        Effect.promise(() => retry().catch(() => false)).pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.map(Option.getOrElse(() => false)),
        ),
      );
      if (done) entries.delete(retry);
    }),
  );
  if (entries.size > 0) return false;
  if (failed.get(threadId) === entries) failed.delete(threadId);
  return true;
}

/** Runs `effect` with `threadId` held, released however it ends. */
export const withStopTeardown = <A, E, R>(
  threadId: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => beginStopTeardown(threadId)),
    () => effect,
    (release) => Effect.sync(release),
  );
