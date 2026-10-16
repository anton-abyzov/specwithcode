import {
  OrchestratorMcpFailure,
  type ProjectId,
  type ProjectPlanError,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Plans from "../../../project/ProjectPlanService.ts";
import * as Access from "../../McpToolAccess.ts";
import { readCaller, resolveProjectId } from "../../threadAccess.ts";
import { ProjectPlanToolkit } from "./tools.ts";
const boundProject = Effect.fn("mcp.projectPlan.boundProject")(function* (requested?: ProjectId) {
  const context = yield* readCaller();
  const projectId = yield* resolveProjectId(context, requested);
  if (context.caller && context.caller.projectId !== projectId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Plans are scoped to the calling thread's project.",
    });
  return { projectId, caller: context.caller };
});
const boundActor = Effect.fn("mcp.projectPlan.boundActor")(function* (requested?: ProjectId) {
  const { projectId, caller } = yield* boundProject(requested);
  if (!caller)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Plan assignments require an authenticated SpecWithCode thread. Use the project UI for human actions.",
    });
  return { projectId, actor: { kind: "thread" as const, threadId: caller.id } };
});
const failure = (error: ProjectPlanError) =>
  new OrchestratorMcpFailure({
    code: error.code === "forbidden" ? "capability_denied" : "invalid_request",
    message: error.message,
  });
export const layer = Access.toLayer(ProjectPlanToolkit, {
  studio_project_plan_read: Access.reads((input) =>
    Effect.gen(function* () {
      const { projectId } = yield* boundProject(input.projectId);
      return yield* (yield* Plans.ProjectPlanService)
        .read({ projectId })
        .pipe(Effect.mapError(failure));
    }),
  ),
  studio_project_plan_claim: Access.writes((input) =>
    Effect.gen(function* () {
      const identity = yield* boundActor(input.projectId);
      return yield* (yield* Plans.ProjectPlanService)
        .claim({ ...input, ...identity })
        .pipe(Effect.mapError(failure));
    }),
  ),
  studio_project_plan_report: Access.writes((input) =>
    Effect.gen(function* () {
      const identity = yield* boundActor(input.projectId);
      return yield* (yield* Plans.ProjectPlanService)
        .report({ ...input, ...identity })
        .pipe(Effect.mapError(failure));
    }),
  ),
  studio_project_plan_release: Access.writes((input) =>
    Effect.gen(function* () {
      const identity = yield* boundActor(input.projectId);
      return yield* (yield* Plans.ProjectPlanService)
        .release({ ...input, ...identity, expectedOwner: identity.actor })
        .pipe(Effect.mapError(failure));
    }),
  ),
});
