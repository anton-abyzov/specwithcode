import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ProjectPlanError,
  ProjectPlanLinkExport,
  ProjectPlanLinkExportInput,
  ProjectPlanLinkMergeInput,
  ProjectPlanLinkMergeResult,
} from "./projectPlan.ts";

export const PROJECT_PLAN_LINK_RPC_METHODS = {
  projectLinkPlanExport: "projectLink.planExport",
  projectLinkPlanMerge: "projectLink.planMerge",
} as const;
const error = Schema.Union([ProjectPlanError, EnvironmentAuthorizationError]);
/** Two-way replication of a linked project's native plan, so claims bind on every machine. */
export const projectPlanLinkRpcs = [
  Rpc.make(PROJECT_PLAN_LINK_RPC_METHODS.projectLinkPlanExport, {
    payload: ProjectPlanLinkExportInput,
    success: ProjectPlanLinkExport,
    error,
  }),
  Rpc.make(PROJECT_PLAN_LINK_RPC_METHODS.projectLinkPlanMerge, {
    payload: ProjectPlanLinkMergeInput,
    success: ProjectPlanLinkMergeResult,
    error,
  }),
] as const;
