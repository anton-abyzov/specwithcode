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

const pending = new Map<string, number>();

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
  return pending.has(threadId);
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
