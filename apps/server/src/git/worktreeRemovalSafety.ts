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

const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ worktreePath: Schema.NullOr(Schema.String) })),
);
const decodeSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

/** Internal compensation only. This context is never part of the wire request. */
export interface WorktreeRemovalContext {
  readonly cancelledSetup?: {
    readonly threadId: ThreadId;
    /** Re-read the exact cancelled bootstrap; a retry/replacement revokes this exception. */
    readonly verify: () => Effect.Effect<boolean>;
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
  const sql = yield* SqlClient.SqlClient;
  const terminals = yield* TerminalManager.TerminalManager;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const canonical = (value: string) =>
    Effect.gen(function* () {
      const resolved = path.resolve(value);
      return (yield* fs.exists(resolved)) ? yield* fs.realPath(resolved) : resolved;
    });
  const contains = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

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
          const projects = yield* sql<{ workspace_root: string }>`
          SELECT workspace_root FROM projection_projects WHERE deleted_at IS NULL
        `;
          for (const project of projects) {
            if (contains(worktreePath, yield* canonical(project.workspace_root)))
              return yield* reject(
                "A registered project uses this worktree. Remove that project reference first.",
              );
          }
          // No archived filter: archived and idle threads still own their checkout.
          // Deleted threads retain it until their durable cleanup effects have settled.
          const threads = yield* sql<{
            thread_id: string;
            payload_json: string;
            deleted_at: string | null;
            cleanup_failed: number;
          }>`
          SELECT t.thread_id, t.payload_json, t.deleted_at, EXISTS (
            SELECT 1 FROM orchestration_v2_effect_outbox failed
            WHERE failed.thread_id = t.thread_id
              AND failed.status NOT IN ('pending', 'running', 'succeeded', 'cancelled')
          ) AS cleanup_failed FROM orchestration_v2_projection_threads t
          WHERE t.deleted_at IS NULL OR EXISTS (
            SELECT 1 FROM orchestration_v2_effect_outbox e
            WHERE e.thread_id = t.thread_id AND e.status NOT IN ('succeeded', 'cancelled')
          )
        `;
          const pendingThreadIds = new Set<string>();
          for (const row of threads) {
            const thread = yield* decodeThread(row.payload_json);
            if (
              thread.worktreePath !== null &&
              contains(worktreePath, yield* canonical(thread.worktreePath))
            ) {
              if (row.deleted_at !== null) {
                if (row.cleanup_failed !== 0)
                  return yield* reject(
                    "Thread cleanup failed or has an unknown state. The worktree was kept.",
                  );
                pendingThreadIds.add(row.thread_id);
              } else if (
                !(
                  context?.cancelledSetup?.threadId === row.thread_id &&
                  (yield* context.cancelledSetup.verify())
                )
              ) {
                return yield* reject("Another thread uses this worktree. Its files were kept.");
              }
            }
          }
          const sessions = yield* sql<{ thread_id: string | null; payload_json: string }>`
          SELECT thread_id, payload_json FROM orchestration_v2_projection_provider_sessions WHERE status != 'stopped'
        `;
          for (const row of sessions) {
            if (
              contains(
                worktreePath,
                yield* canonical((yield* decodeSession(row.payload_json)).cwd),
              ) &&
              (row.thread_id === null || !pendingThreadIds.has(row.thread_id))
            )
              return yield* reject(
                "A retained agent session uses this worktree. Stop that session before removing it.",
              );
          }
          for (const terminal of liveTerminals.values()) {
            if (terminal.status !== "starting" && terminal.status !== "running") continue;
            if (
              contains(worktreePath, yield* canonical(terminal.cwd)) ||
              (terminal.worktreePath !== null &&
                contains(worktreePath, yield* canonical(terminal.worktreePath)))
            ) {
              if (pendingThreadIds.has(terminal.threadId)) continue;
              return yield* reject(
                "A terminal uses this worktree. Close it before removing the worktree.",
              );
            }
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
          if (!status.isRepo || status.branch === null || status.hasWorkingTreeChanges)
            return yield* reject(
              "The worktree has local changes or no retained branch. Commit or preserve its files first.",
            );
          const ignored = yield* git.execute({
            operation: "WorktreeRemoval.ignoredFiles",
            cwd: worktreePath,
            args: ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
            maxOutputBytes: 64 * 1024,
          });
          if (
            ignored.stdoutTruncated ||
            ignored.stdout
              .split("\0")
              .some((entry) => entry !== "" && !/(^|\/)node_modules\/$/.test(entry))
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
          // Client force flags never authorize discarding data. Git is the final dirty check.
          // External processes do not participate in Studio's lease; no cross-process lock is claimed.
          yield* git.removeWorktree({ cwd: input.cwd, path: worktreePath, force: false });
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
        times: 20,
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
