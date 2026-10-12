import {
  ProjectEnvironmentReadInput,
  ProjectEnvironmentReadResult,
  ProjectEnvironmentPrepareInput,
  ProjectEnvironmentError,
} from "./projectEnvironment.ts";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ProjectPlanReadInput,
  ProjectPlanAuthorityReadResult,
  ProjectPlanTaskInput,
  ProjectPlanReplaceInput,
  ProjectPlanConfigureInput,
  ProjectPlanReleaseInput,
  ProjectPlanReportInput,
  ProjectPlanVerifyInput,
  ProjectPlanSnapshot,
  ProjectPlanError,
} from "./projectPlan.ts";
import {
  ProjectWorkspaceReadInput,
  ProjectWorkspaceReadResult,
  ProjectWorkspaceError,
  ProjectMemoryReadInput,
  ProjectMemoryFile,
  ProjectMemoryWriteInput,
  ProjectMemoryDeleteInput,
  ProjectMemoryDeleteResult,
  ProjectCoordinatorStartInput,
  ProjectCoordinatorSendInput,
  ProjectCoordinatorResult,
} from "./projectWorkspace.ts";
import {
  ProjectLibraryAddArtifactInput,
  ProjectLibraryError,
  ProjectLibraryReadInput,
  ProjectLibrarySnapshot,
  ProjectThreadReportSaveInput,
  ProjectThreadReportsInput,
  ProjectThreadReportsSnapshot,
} from "./projectLibrary.ts";
import {
  ProjectStarterSuggestionsInput,
  ProjectStarterSuggestionsResult,
} from "./projectSuggestions.ts";
import {
  ProjectUsageReadInput,
  ProjectUsageSummary,
  ProjectUsageReadError,
} from "./projectUsage.ts";
import {
  ProjectSkillsReadError,
  ProjectSkillsReadInput,
  ProjectSkillsSnapshot,
} from "./projectSkills.ts";
export const PROJECT_WORKSPACE_RPC_METHODS = {
  projectsEnvironmentRead: "projects.environmentRead",
  projectsEnvironmentPrepare: "projects.environmentPrepare",
  projectsPlanRead: "projects.planRead",
  projectsPlanAuthorityRead: "projects.planAuthorityRead",
  projectsPlanReplace: "projects.planReplace",
  projectsPlanConfigure: "projects.planConfigure",
  projectsPlanClaim: "projects.planClaim",
  projectsPlanRelease: "projects.planRelease",
  projectsPlanReport: "projects.planReport",
  projectsPlanVerify: "projects.planVerify",
  projectsPlanExport: "projects.planExport",
  projectsUsageRead: "projects.usageRead",
  projectsSkillsRead: "projects.skillsRead",
  projectsWorkspaceRead: "projects.workspaceRead",
  projectsStarterSuggestions: "projects.starterSuggestions",
  projectsMemoryRead: "projects.memoryRead",
  projectsMemoryWrite: "projects.memoryWrite",
  projectsMemoryDelete: "projects.memoryDelete",
  projectsCoordinatorStart: "projects.coordinatorStart",
  projectsCoordinatorSend: "projects.coordinatorSend",
  projectsLibraryRead: "projects.libraryRead",
  projectsLibraryAddArtifact: "projects.libraryAddArtifact",
  projectsThreadReportsRead: "projects.threadReportsRead",
  projectsThreadReportSave: "projects.threadReportSave",
} as const;
const error = Schema.Union([ProjectWorkspaceError, EnvironmentAuthorizationError]);
const planError = Schema.Union([ProjectPlanError, EnvironmentAuthorizationError]);
// Human RPCs never accept actor identity from the caller.
const planChange = {
  projectId: ProjectPlanTaskInput.fields.projectId,
  expectedRevision: ProjectPlanTaskInput.fields.expectedRevision,
};
const planTask = { ...planChange, taskId: ProjectPlanTaskInput.fields.taskId };
export const projectWorkspaceRpcs = [
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsEnvironmentRead, {
    payload: ProjectEnvironmentReadInput,
    success: ProjectEnvironmentReadResult,
    error: Schema.Union([ProjectEnvironmentError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsEnvironmentPrepare, {
    payload: ProjectEnvironmentPrepareInput,
    success: ProjectEnvironmentReadResult,
    error: Schema.Union([ProjectEnvironmentError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsPlanAuthorityRead, {
    payload: ProjectPlanReadInput,
    success: ProjectPlanAuthorityReadResult,
    error: planError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsPlanRead, {
    payload: ProjectPlanReadInput,
    success: ProjectPlanSnapshot,
    error: planError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsPlanReplace, {
    payload: Schema.Struct({
      ...planChange,
      definition: ProjectPlanReplaceInput.fields.definition,
    }),
    success: ProjectPlanSnapshot,
    error: planError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsPlanConfigure, {
    payload: Schema.Struct({
      ...planChange,
      authority: ProjectPlanConfigureInput.fields.authority,
      discardNative: Schema.Boolean,
    }),
    success: ProjectPlanSnapshot,
    error: planError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsPlanClaim, {
    payload: Schema.Struct(planTask),
    success: ProjectPlanSnapshot,
    error: planError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsPlanRelease, {
    payload: Schema.Struct({
      ...planTask,
      expectedOwner: ProjectPlanReleaseInput.fields.expectedOwner,
    }),
    success: ProjectPlanSnapshot,
    error: planError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsPlanReport, {
    payload: Schema.Struct({
      ...planTask,
      status: ProjectPlanReportInput.fields.status,
      note: ProjectPlanReportInput.fields.note,
    }),
    success: ProjectPlanSnapshot,
    error: planError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsPlanVerify, {
    payload: Schema.Struct({
      ...planTask,
      commandId: ProjectPlanVerifyInput.fields.commandId,
      recheckOnly: ProjectPlanVerifyInput.fields.recheckOnly,
    }),
    success: ProjectPlanSnapshot,
    error: planError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsPlanExport, {
    payload: ProjectPlanReadInput,
    success: Schema.Struct({ filename: Schema.Literal("project-plan.md"), content: Schema.String }),
    error: planError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsUsageRead, {
    payload: ProjectUsageReadInput,
    success: ProjectUsageSummary,
    error: Schema.Union([ProjectUsageReadError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsSkillsRead, {
    payload: ProjectSkillsReadInput,
    success: ProjectSkillsSnapshot,
    error: Schema.Union([ProjectSkillsReadError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsWorkspaceRead, {
    payload: ProjectWorkspaceReadInput,
    success: ProjectWorkspaceReadResult,
    error,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsStarterSuggestions, {
    payload: ProjectStarterSuggestionsInput,
    success: ProjectStarterSuggestionsResult,
    error,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsMemoryRead, {
    payload: ProjectMemoryReadInput,
    success: ProjectMemoryFile,
    error,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsMemoryWrite, {
    payload: ProjectMemoryWriteInput,
    success: ProjectMemoryFile,
    error,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsMemoryDelete, {
    payload: ProjectMemoryDeleteInput,
    success: ProjectMemoryDeleteResult,
    error,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsCoordinatorStart, {
    payload: ProjectCoordinatorStartInput,
    success: ProjectCoordinatorResult,
    error,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsCoordinatorSend, {
    payload: ProjectCoordinatorSendInput,
    success: ProjectCoordinatorResult,
    error,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsLibraryRead, {
    payload: ProjectLibraryReadInput,
    success: ProjectLibrarySnapshot,
    error: Schema.Union([ProjectLibraryError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsLibraryAddArtifact, {
    payload: ProjectLibraryAddArtifactInput,
    success: ProjectLibrarySnapshot,
    error: Schema.Union([ProjectLibraryError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsThreadReportsRead, {
    payload: ProjectThreadReportsInput,
    success: ProjectThreadReportsSnapshot,
    error: Schema.Union([ProjectLibraryError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsThreadReportSave, {
    payload: ProjectThreadReportSaveInput,
    success: ProjectThreadReportsSnapshot,
    error: Schema.Union([ProjectLibraryError, EnvironmentAuthorizationError]),
  }),
] as const;
