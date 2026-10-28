// @effect-diagnostics nodeBuiltinImport:off - native Git worktree placement boundary.
import * as NodePath from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { resolveWorktreeLocationMode, type ServerSettings } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as FileSystem from "effect/FileSystem";
import { runGit } from "../fleet/folderTransfer/git.ts";
import { nodePath } from "../nodePath.ts";
import { ignoreProjectWorktrees, validateWorktreePlacement } from "../worktreePlacement.ts";
import { resolveWorktreesDirectory } from "../worktreesDirectory.ts";

class HandoffPlacementError extends Data.TaggedError("HandoffPlacementError")<{
  readonly message: string;
}> {}

/** Reuse Git's registered checkout before consulting settings: a retry never relocates work. */
export const resolveHandoffPlacement = (input: {
  readonly repository: string;
  readonly name: string;
  readonly defaultDirectory: string;
  readonly settings: Pick<ServerSettings, "worktreesDirectory" | "worktreeLocationMode">;
}) =>
  Effect.gen(function* () {
    const fs = yield* Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer);
    const listed = yield* Effect.tryPromise(() =>
      runGit(input.repository, ["worktree", "list", "--porcelain", "-z"]),
    );
    const matches = listed.stdout
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice("worktree ".length))
      .filter(
        (directory) =>
          NodePath.basename(directory) === input.name &&
          NodePath.resolve(directory) !== NodePath.resolve(input.repository),
      );
    if (matches.length > 1)
      return yield* Effect.fail(
        new HandoffPlacementError({
          message:
            "Several registered worktrees match this handoff. Reconcile them before retrying.",
        }),
      );
    if (matches.length === 1) {
      const worktreePath = matches[0]!;
      if (!(yield* fs.exists(worktreePath)))
        return yield* Effect.fail(
          new HandoffPlacementError({
            message: "The registered handoff worktree is missing. Restore it before retrying.",
          }),
        );
      return { worktreePath, existing: true };
    }
    let parent = resolveWorktreesDirectory(
      input.settings.worktreesDirectory,
      input.defaultDirectory,
      nodePath,
      input.settings.worktreeLocationMode,
      input.repository,
    );
    if (parent !== null)
      parent = yield* validateWorktreePlacement(
        {
          directory: parent,
          repository: input.repository,
          setting: input.settings.worktreesDirectory,
          ...(input.settings.worktreeLocationMode
            ? { mode: input.settings.worktreeLocationMode }
            : {}),
        },
        fs,
        nodePath,
      );
    if (parent === null)
      return yield* Effect.fail(
        new HandoffPlacementError({
          message:
            "The destination worktree location is unsafe or unavailable. Change it in Settings → Storage.",
        }),
      );
    const worktreePath = NodePath.join(parent, input.name);
    if (yield* fs.exists(worktreePath))
      return yield* Effect.fail(
        new HandoffPlacementError({
          message:
            "The handoff destination already exists but is not a registered worktree. Preserve it and choose another storage location.",
        }),
      );
    if (resolveWorktreeLocationMode(input.settings) === "project") {
      const result = yield* Effect.tryPromise(() =>
        runGit(input.repository, ["rev-parse", "--git-path", "info/exclude"]),
      );
      yield* ignoreProjectWorktrees(
        NodePath.resolve(input.repository, result.stdout.trim()),
        fs,
        nodePath,
      );
    }
    return { worktreePath, existing: false };
  });
