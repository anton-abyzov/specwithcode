import {
  OrchestratorMcpFailure,
  type ProjectId,
  type ProjectWorkspaceError,
  type ProjectWorkspaceReadResult,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Workspace from "../../../project/ProjectWorkspaceService.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../threadAccess.ts";
import { assertProjectReadable } from "../../workGrantAccess.ts";
import { ProjectMemoryToolkit } from "./tools.ts";

const boundProject = Effect.fn("mcp.projectMemory.boundProject")(function* (requested?: ProjectId) {
  const context = yield* readCaller();
  const projectId = yield* resolveProjectId(context, requested);
  if (context.caller && context.caller.projectId !== projectId) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Project memory is scoped to the calling thread's project.",
    });
  }
  // Another machine's work reaches only the projects its grant covers.
  yield* assertProjectReadable(context, projectId);
  return projectId;
});
const failure = (error: ProjectWorkspaceError) =>
  new OrchestratorMcpFailure({
    code: error.code === "operation_failed" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });
// A revision mismatch on one memory file is not a project-wide change; say how to recover.
export const memoryConflict = (name: string, revision: number | null) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message:
      revision === null
        ? `${name} does not exist yet. Write it again without expectedRevision.`
        : `${name} is at revision ${revision}. Read it, merge your change and write again with expectedRevision ${revision}.`,
  });
export const MEMORY_LIST_PAGE = 200;
export const MEMORY_LIST_MAX_PAGE = 1_000;
/** totalBytes stays the project's whole stored size; totalFiles counts what the query matched. */
export function memoryListPage(
  memory: ProjectWorkspaceReadResult["memory"],
  input: {
    readonly query?: string | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  },
) {
  const needle = input.query?.trim().toLowerCase() ?? "";
  const matched = needle
    ? memory.files.filter((file) => file.name.toLowerCase().includes(needle))
    : memory.files;
  const offset = Math.min(input.offset ?? 0, matched.length);
  const limit = Math.min(Math.max(input.limit ?? MEMORY_LIST_PAGE, 1), MEMORY_LIST_MAX_PAGE);
  return {
    files: matched.slice(offset, offset + limit),
    totalBytes: memory.totalBytes,
    totalFiles: matched.length,
  };
}
export const layer = Access.toLayer(ProjectMemoryToolkit, {
  studio_project_memory_list: Access.reads((input) =>
    Effect.gen(function* () {
      const projectId = yield* boundProject(input.projectId);
      const workspace = yield* Workspace.ProjectWorkspaceService;
      const memory = (yield* workspace.readWorkspace({ projectId }).pipe(Effect.mapError(failure)))
        .memory;
      return memoryListPage(memory, input);
    }),
  ),
  studio_project_memory_read: Access.reads((input) =>
    Effect.gen(function* () {
      const projectId = yield* boundProject(input.projectId);
      const workspace = yield* Workspace.ProjectWorkspaceService;
      return yield* workspace.readMemory({ ...input, projectId }).pipe(Effect.mapError(failure));
    }),
  ),
  studio_project_memory_write: Access.writes((input) =>
    Effect.gen(function* () {
      const projectId = yield* boundProject(input.projectId);
      const workspace = yield* Workspace.ProjectWorkspaceService;
      // Revisions start at 1, so a missing value or 0 can only mean "create this file".
      const expectedRevision = input.expectedRevision || null;
      return yield* workspace.writeMemory({ ...input, projectId, expectedRevision }).pipe(
        Effect.catch((error) =>
          error.code === "conflict"
            ? workspace.readMemory({ projectId, name: input.name }).pipe(
                Effect.map((file) => file.revision),
                Effect.orElseSucceed(() => null),
                Effect.flatMap((revision) => Effect.fail(memoryConflict(input.name, revision))),
              )
            : Effect.fail(failure(error)),
        ),
      );
    }),
  ),
});
