import type { MachineHandoffUpdateSkipped } from "@specweave-studio/contracts";

/** The same reason in the same repository: an "anyway" given for one never covers another. */
export function sameStaleReason(
  a: MachineHandoffUpdateSkipped | null | undefined,
  b: MachineHandoffUpdateSkipped | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.reason === b.reason &&
    (a.repository ?? ".") === (b.repository ?? ".") &&
    (a.unsafeConfig ?? []).join("\n") === (b.unsafeConfig ?? []).join("\n")
  );
}

/**
 * Why "Continue the coordinator on {machine}" cannot bring that machine's copy to the source's latest commits,
 * in words for the review screen. The copy is only ever fast-forwarded: nothing there is
 * overwritten, so a copy that diverged or holds local edits stays as it is.
 */
export function staleCopyText(input: {
  readonly skipped: MachineHandoffUpdateSkipped;
  readonly source: string;
  readonly target: string;
  readonly projectTitle: string;
}): { readonly headline: string; readonly detail: string; readonly anyway: string } {
  const { skipped, source, target } = input;
  const repo =
    skipped.repository === undefined || skipped.repository === "."
      ? input.projectTitle
      : skipped.repository;
  const older = `Nothing on ${target} is overwritten: moving anyway leaves it on its older commits.`;
  const asIs = `Nothing on ${target} is overwritten: moving anyway leaves that repository as it is.`;
  const headline = `${target}'s copy will not be updated to ${source}'s latest commits`;
  const anyway = `Make ${target} main anyway, on its older commits`;
  const said = (why: string, tail: string, label = anyway) => ({
    headline,
    detail: `${why} ${tail}`,
    anyway: label,
  });
  switch (skipped.reason) {
    case "local-commits":
      return said(
        `${repo} on ${target} has commits ${source} does not have, so it cannot fast-forward. Push or merge them on ${target}, then check again.`,
        older,
      );
    case "dirty":
      return said(
        `${repo} on ${target} has uncommitted changes, or a submodule that is not checked out. Commit or stash the changes, or check out the submodule, there, then check again.`,
        older,
      );
    case "in-use":
      return said(
        `A thread on ${target} is working in ${repo}. Let it finish, then check again.`,
        older,
      );
    case "not-published":
      return said(
        `${source}'s commits in ${repo} are not on its remote, so ${target} cannot fetch them. Push them, then check again.`,
        older,
      );
    case "detached-head":
      return said(
        `${repo} on ${target} is not on a branch. Check out its branch there, then check again.`,
        older,
      );
    case "needs-lfs":
      return said(
        `${repo} uses Git LFS, which is not installed on ${target}. Install Git LFS there, then check again.`,
        older,
      );
    case "missing-repository":
      return said(
        `${repo} is missing from the project folder on ${target}. Add it there, then check again.`,
        `Nothing on ${target} is overwritten: moving anyway starts there without it.`,
        `Make ${target} main anyway, without ${repo}`,
      );
    case "identity-mismatch":
      return said(
        `${repo} on ${target} points at a different remote than on ${source}. Fix its origin there, then check again.`,
        asIs,
        `Make ${target} main anyway, with ${repo} as it is`,
      );
    case "unsafe-git-config":
      return said(
        `${repo} on ${target} has Git settings the app does not run with${skipped.unsafeConfig?.length ? ` (${skipped.unsafeConfig.join(", ")})` : ""}. Remove them there, then check again.`,
        asIs,
        `Make ${target} main anyway, with ${repo} as it is`,
      );
    case "external-storage":
      return said(
        `${repo} on ${target} keeps its Git data outside the project folder, so the app does not update it.`,
        asIs,
        `Make ${target} main anyway, with ${repo} as it is`,
      );
    case "lfs-failed":
      return {
        headline: `${target}'s copy was updated, but its Git LFS files did not download`,
        detail: `${repo} on ${target} has ${source}'s latest commits, with some large files still as pointers. Run git lfs pull there.`,
        anyway: `Make ${target} main anyway, without those large files`,
      };
    default:
      return said(
        `${skipped.message} Check the repository on ${target}, then check again.`,
        asIs,
        `Make ${target} main anyway, with ${repo} as it is`,
      );
  }
}
