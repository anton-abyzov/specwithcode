import { PullRequestOperationError } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

const ABBREVIATED_SHA = /^[0-9a-f]{7,64}$/i;

/** True when `current` is the commit `expected` names, in full or by a hex prefix. */
export function isSameHead(current: string, expected: string): boolean {
  const left = current.toLowerCase();
  const right = expected.toLowerCase();
  return left === right || (ABBREVIATED_SHA.test(right) && left.startsWith(right));
}

/**
 * The head a write is pinned to. Without one from the caller nothing is read and the provider
 * pins to the head it sees itself. With one, the host's current head must still be that commit;
 * the full sha is handed on so a host that can pin a write to a commit does so as well.
 */
export function pinnedHead<E>(
  expected: string | undefined,
  operation: string,
  readCurrentHead: Effect.Effect<string | undefined, E>,
): Effect.Effect<string | undefined, E | PullRequestOperationError> {
  if (expected === undefined) return Effect.succeed(undefined);
  return readCurrentHead.pipe(
    Effect.flatMap((current) =>
      current !== undefined && isSameHead(current, expected)
        ? Effect.succeed(current)
        : Effect.fail(
            new PullRequestOperationError({
              operation,
              detail: `New commits arrived after you opened this change request (head ${(current ?? "unknown").slice(0, 12)}, you saw ${expected.slice(0, 12)}). Review them first.`,
            }),
          ),
    ),
  );
}
