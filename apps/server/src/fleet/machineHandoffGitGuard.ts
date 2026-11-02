import { MachineHandoffError } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import type { HandoffGitError } from "./handoffGitTypes.ts";

/** Maps a Git refusal to the handoff error its caller and the dialog understand. */
export const gitGuarded = <A>(effect: Effect.Effect<A, HandoffGitError>) =>
  effect.pipe(
    Effect.mapError((error) => {
      const code: MachineHandoffError["code"] =
        (
          {
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
          } as Partial<Record<HandoffGitError["reason"], MachineHandoffError["code"]>>
        )[error.reason] ?? "git_refused";
      return new MachineHandoffError({ code });
    }),
  );
