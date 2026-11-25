import { OrchestratorMcpFailure } from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { runSpecweave } from "./cli.ts";
import { SpecweaveToolkit } from "./tools.ts";
import { resolveCallerWorkspace, type CallerWorkspaceInput } from "./workspace.ts";

const READ_TIMEOUT = Duration.minutes(2);

const refuse = (
  code: "capability_denied" | "invalid_request" | "thread_not_found",
  message: string,
) => new OrchestratorMcpFailure({ code, message });

/**
 * The calling thread's registered worktree. Only a thread caller has one; an
 * outside client is refused, and so is a thread without a worktree.
 */
export const callerWorkspaceInput = Effect.fn("specweaveTools.callerWorkspaceInput")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) {
    return yield* refuse(
      "capability_denied",
      "SpecWeave tools read a SpecWithCode thread's own worktree; this caller has none.",
    );
  }
  const threads = yield* ThreadManagement.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (shell === null || shell.deletedAt !== null) {
    return yield* refuse("thread_not_found", "The calling thread was not found.");
  }
  return { worktreePath: shell.worktreePath } satisfies CallerWorkspaceInput;
});

const workspaceFor = (folder: string | undefined) =>
  Effect.gen(function* () {
    const input = yield* callerWorkspaceInput();
    const resolved = yield* Effect.promise(() => resolveCallerWorkspace({ ...input, folder }));
    if (!resolved.ok) {
      return yield* refuse(
        resolved.reason === "no-specweave" || resolved.reason === "outside"
          ? "invalid_request"
          : "capability_denied",
        resolved.message,
      );
    }
    return resolved;
  });

interface ListedTask {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly status?: unknown;
  readonly by?: unknown;
  readonly since?: unknown;
}

/** Tasks claimed (or blocked) right now, from `task list --json`. */
export function liveClaimsOf(listData: unknown): ReadonlyArray<ListedTask> | null {
  if (listData === null || typeof listData !== "object") return null;
  const tasks = (listData as { readonly tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return null;
  return tasks
    .filter(
      (task): task is ListedTask =>
        task !== null &&
        typeof task === "object" &&
        ((task as ListedTask).status === "claimed" || (task as ListedTask).status === "blocked"),
    )
    .map(({ id, title, status, by, since }) => ({ id, title, status, by, since }));
}

export const layer = Access.toLayer(SpecweaveToolkit, {
  specweave_task_status: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const where = yield* workspaceFor(input.folder);
      return yield* runSpecweave({
        specweaveRoot: where.specweaveRoot,
        args: ["task", "list", input.increment, "--json"],
        timeout: READ_TIMEOUT,
      });
    }),
  ),
  specweave_next_task: Access.readsAsCaller((input) =>
    Effect.gen(function* () {
      const where = yield* workspaceFor(input.folder);
      const [next, list] = yield* Effect.all(
        [
          runSpecweave({
            specweaveRoot: where.specweaveRoot,
            args: ["task", "next", input.increment, "--json"],
            timeout: READ_TIMEOUT,
          }),
          runSpecweave({
            specweaveRoot: where.specweaveRoot,
            args: ["task", "list", input.increment, "--json"],
            timeout: READ_TIMEOUT,
          }),
        ],
        { concurrency: 2 },
      );
      const nextData = next.data !== null && typeof next.data === "object" ? next.data : {};
      return {
        ...next,
        data: { ...nextData, liveClaims: list.ok ? liveClaimsOf(list.data) : null },
      };
    }),
  ),
});
