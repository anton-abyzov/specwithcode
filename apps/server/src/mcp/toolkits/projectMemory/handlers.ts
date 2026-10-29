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
  return { projectId, context };
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
// Workers kept saving each run's receipt as a new dated file, burying real facts.
const DATED_NAME = /(?:^|[-_.])20\d{2}[-_.]?[01]\d[-_.]?[0-3]\d(?=[-_.])/;
const LOCAL_PATH =
  /(?<=^|[\s(`"'])(?:\/Users\/|\/home\/|\/private\/tmp\/|\/Volumes\/|~\/)[^\s,;)"'`]+/g;
const MAX_LOCAL_PATHS = 3;
/** Why a thread may not create this file, or undefined when it reads as lasting knowledge. */
export function runRecordRefusal(name: string, content: string): string | undefined {
  if (name === "MEMORY.md") return undefined;
  if (DATED_NAME.test(name)) {
    return `${name} carries a date. Memory keeps one file per subject: list memory with a query for the subject and update that file, or name a new subject without a date. A run's status belongs in your report.`;
  }
  if (new Set(content.match(LOCAL_PATH)).size > MAX_LOCAL_PATHS) {
    return `${name} reads as a run receipt with many local paths. Put receipts and evidence paths in your report or the increment's reports/ folder, and keep memory to lasting facts and decisions.`;
  }
  return undefined;
}
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
      const { projectId } = yield* boundProject(input.projectId);
      const workspace = yield* Workspace.ProjectWorkspaceService;
      const memory = (yield* workspace.readWorkspace({ projectId }).pipe(Effect.mapError(failure)))
        .memory;
      return memoryListPage(memory, input);
    }),
  ),
  studio_project_memory_read: Access.reads((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* boundProject(input.projectId);
      const workspace = yield* Workspace.ProjectWorkspaceService;
      return yield* workspace.readMemory({ ...input, projectId }).pipe(Effect.mapError(failure));
    }),
  ),
  studio_project_memory_write: Access.writes((input) =>
    Effect.gen(function* () {
      const { projectId, context } = yield* boundProject(input.projectId);
      const workspace = yield* Workspace.ProjectWorkspaceService;
      // Revisions start at 1, so a missing value or 0 can only mean "create this file".
      const expectedRevision = input.expectedRevision || null;
      // Only new files from threads: updating an existing file, imports and sync stay open.
      const refusal =
        context.caller && expectedRevision === null
          ? runRecordRefusal(input.name, input.content)
          : undefined;
      if (refusal) {
        return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: refusal });
      }
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
