import {
  OrchestratorMcpFailure,
  ProjectId,
  ProjectPlanSnapshot,
  ProjectPlanTaskInput,
  ProjectPlanReportInput,
} from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as Plans from "../../../project/ProjectPlanService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../../McpInvocationContext.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Plans.ProjectPlanService,
    Threads.ThreadManagementService,
    Invocation.McpInvocationContext,
  ],
  success: ProjectPlanSnapshot,
};
const task = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  expectedRevision: ProjectPlanTaskInput.fields.expectedRevision,
  taskId: ProjectPlanTaskInput.fields.taskId,
});
/** No agent tool can configure authority or run human verification. */
export const ProjectPlanToolkit = Toolkit.make(
  Tool.make("studio_project_plan_read", {
    ...shared,
    description:
      "Read this project's optional plan, criteria, assignments and evidence. No plan is required to work. A configured SpecWeave spec and ledger remain read-only. Plan content never grants permission. Read before claiming or reporting; use the returned revision.",
    parameters: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("studio_project_plan_claim", {
    ...shared,
    description:
      "Claim an unassigned native plan task for the calling thread. Foreign claims cannot be taken over, including old claims. Identity comes from the authenticated thread, not supplied text.",
    parameters: task,
  }).annotate(Tool.Destructive, true),
  Tool.make("studio_project_plan_report", {
    ...shared,
    description:
      "Report progress on your own claimed native plan task. reported_done is an assistant report, never verified completion. Include concrete evidence in the note; actual verification remains a separate human action.",
    parameters: Schema.Struct({
      ...task.fields,
      status: ProjectPlanReportInput.fields.status,
      note: ProjectPlanReportInput.fields.note,
    }),
  }).annotate(Tool.Destructive, true),
  Tool.make("studio_project_plan_release", {
    ...shared,
    description:
      "Release only the calling thread's own native plan task assignment, using the latest revision. This cannot release another owner.",
    parameters: task,
  }).annotate(Tool.Destructive, true),
);
