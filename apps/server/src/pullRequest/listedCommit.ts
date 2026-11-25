import {
  type PullRequestActivity,
  PullRequestOperationError,
  type PullRequestRef,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

const COMMIT_PREFIX = /^[0-9a-f]{7,64}$/;

/**
 * Narrows a caller-named commit to one the change request itself lists.
 *
 * A host answers a commit's diff or file contents from the whole repository (and, on GitHub,
 * its fork network), not from the change request, so forwarding whatever the caller names
 * would let a reader of one pull request read any commit with the project's credential. Only a
 * hex prefix that matches exactly one listed commit goes through, as that commit's full id, so
 * equal requests also share one cache entry. Input without a commit is returned untouched.
 */
export const withListedCommit = <
  I extends PullRequestRef & { readonly commit?: string | undefined },
  E,
>(
  operation: string,
  input: I,
  listCommits: (input: I) => Effect.Effect<PullRequestActivity, E>,
): Effect.Effect<I, E | PullRequestOperationError> => {
  const named = input.commit?.toLowerCase();
  if (named === undefined) return Effect.succeed(input);
  const refused = new PullRequestOperationError({
    operation,
    detail: "That commit is not one of this change request's commits.",
    reason: "not-found",
  });
  if (!COMMIT_PREFIX.test(named)) return Effect.fail(refused);
  return listCommits(input).pipe(
    Effect.flatMap(({ commits }) => {
      const matches = commits.filter((commit) => commit.oid.toLowerCase().startsWith(named));
      const [only] = matches;
      return only !== undefined && matches.length === 1
        ? Effect.succeed({ ...input, commit: only.oid })
        : Effect.fail(refused);
    }),
  );
};
