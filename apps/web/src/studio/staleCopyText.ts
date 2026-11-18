import type { MachineHandoffUpdateSkipped } from "@specweave-studio/contracts";

/**
 * Why "Make {machine} main" cannot bring that machine's copy to the source's latest commits,
 * in words for the review screen. The copy is only ever fast-forwarded: nothing there is
 * overwritten, so a copy that diverged or holds local edits stays as it is.
 */
export function staleCopyText(input: {
  readonly skipped: MachineHandoffUpdateSkipped;
  readonly source: string;
  readonly target: string;
  readonly projectTitle: string;
}): { readonly headline: string; readonly detail: string } {
  const { skipped, source, target } = input;
  const repo =
    skipped.repository === undefined || skipped.repository === "."
      ? input.projectTitle
      : skipped.repository;
  const headline = `${target}'s copy will not be updated to ${source}'s latest commits`;
  const why = (() => {
    switch (skipped.reason) {
      case "local-commits":
        return `${repo} on ${target} has commits ${source} does not have, so it cannot fast-forward. Push or merge them on ${target}, then check again.`;
      case "dirty":
        return `${repo} on ${target} has uncommitted changes. Commit or stash them there, then check again.`;
      case "in-use":
        return `A thread on ${target} is working in ${repo}. Let it finish, then check again.`;
      case "not-published":
        return `${source}'s commits in ${repo} are not on its remote, so ${target} cannot fetch them. Push them, then check again.`;
      case "detached-head":
        return `${repo} on ${target} is not on a branch. Check out its branch there, then check again.`;
      default:
        return skipped.message;
    }
  })();
  return {
    headline,
    detail: `${why} Nothing on ${target} is overwritten: moving anyway leaves it on its older commits.`,
  };
}
