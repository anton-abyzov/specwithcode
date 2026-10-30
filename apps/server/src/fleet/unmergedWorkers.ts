/**
 * A summarized coordinator handoff leaves every worker chat on the source. Over
 * Git it still checks their branches and worktrees, as a full handoff does, but
 * names the ones the published commits lack instead of refusing the project.
 */
import type { OrchestrationV2ThreadShell, ProjectId, ThreadId } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { stringifyJson } from "../json.ts";
import type { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import type { HandoffGit } from "./handoffGit.ts";
import type { HandoffGitManifest } from "./handoffGitTypes.ts";
/**
 * Newest created first. Archiving or touching a chat leaves its place, so the
 * worktrees checked at a preview are the ones checked again at its publish.
 */
const byCreation = (a: OrchestrationV2ThreadShell, b: OrchestrationV2ThreadShell) =>
  DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const checkout = (thread: OrchestrationV2ThreadShell) => ({
  worktreePath: thread.worktreePath ?? null,
  branch: thread.branch ?? null,
});

/** The project's worker chats on this machine whose code the manifest's heads may not include. */
export const makeUnmergedWorkers =
  (projections: ProjectionStoreV2["Service"], git: HandoffGit["Service"]) =>
  (input: {
    readonly projectId: ProjectId;
    readonly coordinatorId: ThreadId;
    readonly workspaceRoot: string;
    readonly manifest: HandoffGitManifest;
  }) =>
    Effect.gen(function* () {
      const snapshot = yield* projections.getShellSnapshot();
      // Newest first: past its limit of worktrees, the report checks the most recently created.
      const workers = [...snapshot.threads, ...snapshot.archivedThreads]
        .filter(
          (t) =>
            t.projectId === input.projectId && t.deletedAt === null && t.id !== input.coordinatorId,
        )
        .sort(byCreation);
      const reported = yield* git.reportWorkerCheckpoints({
        workspaceRoot: input.workspaceRoot,
        manifest: input.manifest,
        workers: workers.map(checkout),
      });
      const keys = new Set(reported.map((w) => stringifyJson([w.worktreePath, w.branch])));
      return workers.filter((t) => {
        const { worktreePath, branch } = checkout(t);
        return keys.has(stringifyJson([worktreePath, branch]));
      });
    });
