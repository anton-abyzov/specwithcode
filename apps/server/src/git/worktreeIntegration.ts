import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/**
 * A squash/rebase merge need not retain the feature commit's ancestry. Prove
 * that merging its exact HEAD would add no content to the refreshed default
 * commit. This writes Git tree objects only, never the index or checkout.
 * Call only after the host confirms the branch's PR was merged; retain the
 * branch ref when reclaiming the checkout.
 */
export const worktreeHasNoAdditionalChanges = Effect.fn("worktreeHasNoAdditionalChanges")(
  function* (
    git: Pick<GitVcsDriver.GitVcsDriver["Service"], "execute">,
    cwd: string,
    head: string,
    base: string,
  ) {
    // A custom merge driver can discard one side (or run arbitrary commands),
    // making tree equality a false proof. Never invoke it during cleanup.
    const drivers = yield* git.execute({
      operation: "StorageCleanup.mergeDrivers",
      cwd,
      args: ["config", "--get-regexp", "^merge\\..*\\.(driver|recursive)$|^merge\\.default$"],
      allowNonZeroExit: true,
      maxOutputBytes: 1024,
    });
    if (drivers.exitCode !== 1 || drivers.stdoutTruncated) return false;
    const target = yield* git.execute({
      operation: "StorageCleanup.defaultTree",
      cwd,
      args: ["rev-parse", "--verify", `${base}^{tree}`],
      allowNonZeroExit: true,
      maxOutputBytes: 1024,
    });
    if (target.exitCode !== 0 || target.stdoutTruncated) return false;
    const tree = target.stdout.trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) return false;
    const merged = yield* git.execute({
      operation: "StorageCleanup.integratedContent",
      cwd,
      args: ["-c", "merge.renormalize=false", "merge-tree", "--write-tree", base, head],
      allowNonZeroExit: true,
      maxOutputBytes: 64 * 1024,
    });
    return merged.exitCode === 0 && !merged.stdoutTruncated && merged.stdout.trim() === tree;
  },
);
