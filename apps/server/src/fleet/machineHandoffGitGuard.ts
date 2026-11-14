import {
  MachineHandoffError,
  type MachineHandoffUpdateSkipped,
  type MachineHandoffUpdateSkipReason,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type { HandoffGitError } from "./handoffGitTypes.ts";

/** The handoff error code of a Git refusal, for callers that build the error themselves. */
export const gitRefusalCode = (error: HandoffGitError): MachineHandoffError["code"] =>
  (
    ({
      "dirty-repository":
        error.stage === "inspect" || error.stage === "publish"
          ? "dirty_source"
          : "dirty_destination",
      "identity-mismatch": "identity_mismatch",
      "unsafe-path": "unsafe_path",
      "source-changed": "source_changed",
      "diverged-repository": "diverged",
      "missing-repository": "missing_repository",
      "uninitialized-repository": "missing_repository",
      "remote-ref-mismatch": "remote_unavailable",
      "git-failed": "remote_unavailable",
      "operation-conflict": "conflict",
      "worktree-conflict": "conflict",
      "in-use": "busy",
    }) as Partial<Record<HandoffGitError["reason"], MachineHandoffError["code"]>>
  )[error.reason] ?? "git_refused";

const SKIPPED: Partial<
  Record<HandoffGitError["reason"], readonly [MachineHandoffUpdateSkipReason, string]>
> = {
  "unsafe-git-config": [
    "unsafe-git-config",
    "its Git settings could run commands, so they were not used",
  ],
  "detached-head": ["detached-head", "its checkout is not on a branch (detached HEAD)"],
  "dirty-repository": ["dirty", "it has uncommitted changes"],
  "uninitialized-repository": ["dirty", "a submodule in it is not checked out"],
  "diverged-repository": ["local-commits", "it has commits this machine does not have"],
  "missing-repository": ["missing-repository", "a repository this project has is missing there"],
  "identity-mismatch": ["identity-mismatch", "a repository there points at a different origin"],
  "in-use": ["in-use", "a thread or another project is working in it"],
  "remote-ref-mismatch": [
    "not-published",
    "this machine's commits did not reach origin, so it cannot fetch them",
  ],
  "needs-lfs": ["needs-lfs", "it needs Git LFS, which is not installed there"],
  "lfs-failed": [
    "lfs-failed",
    "its commits were updated, but Git LFS files did not download (run git lfs pull there)",
  ],
  "git-failed": ["git-failed", "Git could not fetch or merge there"],
};

/**
 * Why an existing copy was not brought to the source heads, in words for the dialog (1326);
 * null for a refusal that no "move anyway" may pass (an unsafe path, a bad manifest).
 */
export const updateSkippedOf = (error: HandoffGitError): MachineHandoffUpdateSkipped | null => {
  const known = SKIPPED[error.reason];
  if (!known) return null;
  const [reason, words] = known;
  const where =
    error.repository === undefined || error.repository === "." ? "" : ` (${error.repository})`;
  const keys = error.unsafeConfig?.length ? `: ${error.unsafeConfig.join(", ")}` : "";
  return {
    reason,
    message:
      `The copy there was not updated to this machine's commits: ${words}${where}${keys}.`.slice(
        0,
        1_000,
      ),
    ...(error.repository === undefined ? {} : { repository: error.repository.slice(0, 1_024) }),
    ...(error.unsafeConfig?.length
      ? { unsafeConfig: error.unsafeConfig.slice(0, 32).map((key) => key.slice(0, 256)) }
      : {}),
  };
};

/** Maps a Git refusal to the handoff error its caller and the dialog understand. */
export const gitGuarded = <A>(effect: Effect.Effect<A, HandoffGitError>) =>
  effect.pipe(Effect.mapError((error) => new MachineHandoffError({ code: gitRefusalCode(error) })));

/**
 * Runs an existing copy's check or update (1326): null when it reached the source heads,
 * the reason and refusal code when it did not; any other refusal fails as `gitGuarded` does.
 */
export const existingCopyUpdate = (effect: Effect.Effect<unknown, HandoffGitError>) =>
  effect.pipe(
    Effect.as(null),
    Effect.catchTag("HandoffGitError", (error) => {
      const skipped = updateSkippedOf(error);
      return skipped
        ? Effect.succeed({ skipped, code: gitRefusalCode(error) })
        : gitGuarded(Effect.fail(error));
    }),
  );
