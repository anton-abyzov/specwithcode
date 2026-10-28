import {
  GitCommandError,
  type TerminalSummary,
  type ThreadId,
  type VcsRemoveWorktreeInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import { canonicalPath, listWorktreeBindings, worktreeOwnersOf } from "./worktreeOwnership.ts";

/** Internal compensation only. This context is never part of the wire request. */
export interface WorktreeRemovalContext {
  readonly cancelledSetup?: {
    readonly threadId: ThreadId;
    /** Re-read the exact cancelled bootstrap; a retry/replacement revokes this exception. */
    readonly verify: () => Effect.Effect<boolean>;
  };
  /**
   * Removal of a worktree whose project or threads were deleted, confirmed by
   * the person in the delete dialog.
   */
  readonly confirmedDeletion?: {
    /** They agreed to lose its uncommitted, untracked and ignored files. The branch stays. */
    readonly discardLocalChanges: boolean;
  };
}

class PendingThreadCleanup extends Schema.TaggedError<PendingThreadCleanup>()(
  "PendingThreadCleanup",
  {},
) {}

/** Explicit removals use persisted ownership, never the client's partial thread list. */
export const makeWorktreeRemovalGuard = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path | SqlClient.SqlClient>();
  const terminals = yield* TerminalManager.TerminalManager;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const canonical = (value: string) => canonicalPath(value).pipe(Effect.provideContext(services));

  return (
    input: VcsRemoveWorktreeInput,
    context?: WorktreeRemovalContext,
  ): Effect.Effect<void, GitCommandError> => {
    const reject = (detail: string) =>
      new GitCommandError({
        operation: "GitWorkflowService.removeWorktree",
        command: "git worktree remove",
        cwd: input.cwd,
        detail,
      });
    const discard = context?.confirmedDeletion?.discardLocalChanges === true;
    return Effect.scoped(
      Effect.gen(function* () {
        const requestedPath = path.resolve(input.path);
        // An absent checkout has no files to delete. Do not prune other registrations.
        if (!(yield* fs.exists(requestedPath))) return;
        const worktreePath = yield* fs.realPath(requestedPath);
        const realParent = yield* fs.realPath(path.dirname(requestedPath));
        if (worktreePath !== path.join(realParent, path.basename(requestedPath)))
          return yield* reject("The worktree path is a symbolic link. Its files were kept.");

        const liveTerminals = new Map<string, TerminalSummary>();
        let receivedTerminalSnapshot = false;
        yield* Effect.acquireRelease(
          terminals.subscribeMetadata((event) =>
            Effect.sync(() => {
              if (event.type === "snapshot") {
                liveTerminals.clear();
                receivedTerminalSnapshot = true;
                for (const terminal of event.terminals)
                  liveTerminals.set(`${terminal.threadId}:${terminal.terminalId}`, terminal);
              } else if (event.type === "upsert") {
                liveTerminals.set(
                  `${event.terminal.threadId}:${event.terminal.terminalId}`,
                  event.terminal,
                );
              } else {
                liveTerminals.delete(`${event.threadId}:${event.terminalId}`);
              }
            }),
          ),
          (unsubscribe) => Effect.sync(unsubscribe),
        );

        const assertUnowned = Effect.fn("WorktreeRemoval.assertUnowned")(function* () {
          if (!receivedTerminalSnapshot)
            return yield* reject(
              "Terminal ownership could not be verified. The worktree was kept.",
            );
          const owners = yield* listWorktreeBindings.pipe(
            Effect.flatMap((bindings) =>
              worktreeOwnersOf(bindings, worktreePath, {
                match: "within",
                terminals: liveTerminals.values(),
              }),
            ),
            Effect.provideContext(services),
          );
          if (owners.projects.length > 0)
            return yield* reject(
              "A registered project uses this worktree. Remove that project reference first.",
            );
          const pendingThreadIds = new Set<string>();
          for (const thread of owners.threads) {
            if (thread.deleted) {
              if (thread.cleanupFailed)
                return yield* reject(
                  "Thread cleanup failed or has an unknown state. The worktree was kept.",
                );
              pendingThreadIds.add(thread.threadId);
            } else if (
              !(
                context?.cancelledSetup?.threadId === thread.threadId &&
                (yield* context.cancelledSetup.verify())
              )
            ) {
              return yield* reject("Another thread uses this worktree. Its files were kept.");
            }
          }
          for (const session of owners.sessions) {
            if (session.threadId === null || !pendingThreadIds.has(session.threadId))
              return yield* reject(
                "A retained agent session uses this worktree. Stop that session before removing it.",
              );
          }
          for (const terminal of owners.terminals) {
            if (pendingThreadIds.has(terminal.threadId)) continue;
            return yield* reject(
              "A terminal uses this worktree. Close it before removing the worktree.",
            );
          }
          if (pendingThreadIds.size > 0) return yield* new PendingThreadCleanup();
        });

        const inspectFiles = Effect.fn("WorktreeRemoval.inspectFiles")(function* () {
          if ((yield* fs.stat(path.join(worktreePath, ".git"))).type !== "File")
            return yield* reject(
              "Only registered linked worktrees can be removed. The project checkout was kept.",
            );
          const registered = yield* Effect.forEach(
            yield* git.listWorktreePaths(input.cwd),
            canonical,
          );
          if (!registered.includes(worktreePath))
            return yield* reject("This path is not a linked worktree of the requested repository.");
          const status = yield* git.statusDetailsLocal(worktreePath);
          if (!status.isRepo || status.branch === null)
            return yield* reject(
              "The worktree has no retained branch. Commit or preserve its files first.",
            );
          if (status.hasWorkingTreeChanges && !discard)
            return yield* reject(
              "The worktree has local changes. Commit or preserve its files first.",
            );
          const ignored = yield* git.execute({
            operation: "WorktreeRemoval.ignoredFiles",
            cwd: worktreePath,
            args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
            maxOutputBytes: 64 * 1024,
          });
          if (
            !discard &&
            (ignored.stdoutTruncated ||
              ignored.stdout
                .split("\0")
                .some((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry)))
          )
            return yield* reject(
              "The worktree contains ignored local files. Preserve them before removing it.",
            );
          return {
            branch: status.branch,
            head: (yield* git.resolveCommit({ cwd: worktreePath, revision: "HEAD" })).commitSha,
          };
        });

        const remove = Effect.gen(function* () {
          yield* assertUnowned();
          const before = yield* inspectFiles();
          // Git/filesystem reads yield; recheck ownership and mutable data before removal.
          const after = yield* inspectFiles();
          if (before.head !== after.head || before.branch !== after.branch)
            return yield* reject("The worktree changed during inspection. Its files were kept.");
          yield* assertUnowned();
          // Client force flags never authorize discarding data; only the confirmed
          // project deletion does. Otherwise Git is the final dirty check.
          // External processes do not participate in Studio's lease; no cross-process lock is claimed.
          yield* git.removeWorktree({ cwd: input.cwd, path: worktreePath, force: discard });
        });
        // Cover the caller's spelling and canonical spelling in a stable order.
        const leasePaths = [...new Set([requestedPath, worktreePath])].sort();
        yield* leasePaths.reduceRight(
          (effect, leasePath) => withWorkspaceLease(leasePath, effect),
          remove,
        );
      }),
    ).pipe(
      // Retry only this known transitional state. Release the lease between
      // attempts so the deletion worker/terminal cleanup can finish.
      Effect.retry({
        while: (error) => Schema.is(PendingThreadCleanup)(error),
        schedule: Schedule.spaced("250 millis"),
        // Many threads were just deleted; their cleanup takes longer.
        times: context?.confirmedDeletion === undefined ? 20 : 240,
      }),
      Effect.mapError((cause) =>
        Schema.is(GitCommandError)(cause)
          ? cause
          : Schema.is(PendingThreadCleanup)(cause)
            ? reject(
                "Thread cleanup is still running. The worktree was kept; retry after cleanup finishes.",
              )
            : reject(
                "Worktree ownership or local files could not be verified. The worktree was kept.",
              ),
      ),
    );
  };
});
