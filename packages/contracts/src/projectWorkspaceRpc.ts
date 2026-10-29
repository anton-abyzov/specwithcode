import {
  ProjectEnvironmentReadInput,
  ProjectEnvironmentReadResult,
  ProjectEnvironmentPrepareInput,
  ProjectEnvironmentError,
  ProjectEnvironmentImportPreviewInput,
  ProjectEnvironmentImportPreview,
  ProjectEnvironmentImportInput,
} from "./projectEnvironment.ts";
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ProjectFolderCheck,
  ProjectFolderCheckError,
  ProjectFolderCheckInput,
  ProjectThreadsDeleteError,
  ProjectThreadsDeleteInput,
  ProjectThreadsDeletion,
  ProjectWorktrees,
  ProjectWorktreesError,
  ProjectWorktreesInput,
  ProjectWorktreesRemoval,
  ProjectWorktreesRemoveInput,
} from "./project.ts";
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
  ProjectKnowledgeError,
  ProjectKnowledgeReindexInput,
  ProjectKnowledgeSearchInput,
  ProjectKnowledgeSearchResult,
  ProjectKnowledgeStatus,
  ProjectKnowledgeStatusInput,
} from "./projectKnowledge.ts";
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
  ProjectIncrementsListInput,
  ProjectIncrementsListResult,
  ThreadIncrementLinkInput,
  ThreadIncrementLinkResult,
  ThreadIncrementProgressInput,
  ThreadIncrementProgressSnapshot,
} from "./threadIncrementProgress.ts";
import {
  ProjectSkillsActionError,
  ProjectSkillsActionInput,
  ProjectSkillsActionResult,
  ProjectSkillsFleetPushInput,
  ProjectSkillsFleetPushResult,
  ProjectSkillsReadError,
  ProjectSkillsReadInput,
  ProjectSkillsSnapshot,
  ProjectSkillsStudioLink,
  ProjectSkillsStudioLinkInput,
  ProjectSkillsVersions,
  ProjectSkillsVersionsInput,
} from "./projectSkills.ts";
export const PROJECT_WORKSPACE_RPC_METHODS = {
  projectsEnvironmentRead: "projects.environmentRead",
  projectsEnvironmentPrepare: "projects.environmentPrepare",
  projectsEnvironmentImportPreview: "projects.environmentImportPreview",
  projectsEnvironmentImport: "projects.environmentImport",
  projectsFolderCheck: "projects.folderCheck",
  projectsWorktreesRead: "projects.worktreesRead",
  projectsWorktreesRemove: "projects.worktreesRemove",
  projectsThreadsDelete: "projects.threadsDelete",
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
  projectsSkillsVersions: "projects.skillsVersions",
  projectsSkillsAction: "projects.skillsAction",
  projectsSkillsFleetPush: "projects.skillsFleetPush",
  projectsSkillsStudioLink: "projects.skillsStudioLink",
  projectsWorkspaceRead: "projects.workspaceRead",
  projectsStarterSuggestions: "projects.starterSuggestions",
  projectsMemoryRead: "projects.memoryRead",
  projectsMemoryWrite: "projects.memoryWrite",
  projectsMemoryDelete: "projects.memoryDelete",
  projectsCoordinatorStart: "projects.coordinatorStart",
  projectsCoordinatorSend: "projects.coordinatorSend",
  projectsLibraryRead: "projects.libraryRead",
  projectsLibraryAddArtifact: "projects.libraryAddArtifact",
  projectsKnowledgeRead: "projects.knowledgeRead",
  projectsKnowledgeSearch: "projects.knowledgeSearch",
  projectsKnowledgeReindex: "projects.knowledgeReindex",
  projectsThreadReportsRead: "projects.threadReportsRead",
  projectsThreadReportSave: "projects.threadReportSave",
  projectsThreadIncrementProgressRead: "projects.threadIncrementProgressRead",
  projectsIncrementsList: "projects.incrementsList",
  projectsThreadIncrementLink: "projects.threadIncrementLink",
} as const;
const error = Schema.Union([ProjectWorkspaceError, EnvironmentAuthorizationError]);
const planError = Schema.Union([ProjectPlanError, EnvironmentAuthorizationError]);
const knowledgeError = Schema.Union([ProjectKnowledgeError, EnvironmentAuthorizationError]);
// Human RPCs never accept actor identity from the caller.
const planChange = {
  projectId: ProjectPlanTaskInput.fields.projectId,
  expectedRevision: ProjectPlanTaskInput.fields.expectedRevision,
};
const planTask = { ...planChange, taskId: ProjectPlanTaskInput.fields.taskId };
export const projectWorkspaceRpcs = [
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsEnvironmentImportPreview, {
    payload: ProjectEnvironmentImportPreviewInput,
    success: ProjectEnvironmentImportPreview,
    error: Schema.Union([ProjectEnvironmentError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsEnvironmentImport, {
    payload: ProjectEnvironmentImportInput,
    success: ProjectEnvironmentReadResult,
    error: Schema.Union([ProjectEnvironmentError, EnvironmentAuthorizationError]),
  }),
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

/**
 * SpecWeave planning: the folder check (which reports the planning root a
 * change would read), the project worktree preview and removal, and increment progress, listing and links. Registered as
 * their own group for the same depth reason (see `WsProjectPlanningRpcGroup`).
 */
export const projectPlanningRpcs = [
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsFolderCheck, {
    payload: ProjectFolderCheckInput,
    success: ProjectFolderCheck,
    error: Schema.Union([ProjectFolderCheckError, EnvironmentAuthorizationError]),
  }),
  // A project's worktrees, read before deleting it and removed after.
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsWorktreesRead, {
    payload: ProjectWorktreesInput,
    success: ProjectWorktrees,
    error: Schema.Union([ProjectWorktreesError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsWorktreesRemove, {
    payload: ProjectWorktreesRemoveInput,
    success: ProjectWorktreesRemoval,
    error: Schema.Union([ProjectWorktreesError, EnvironmentAuthorizationError]),
  }),
  // Every thread but the coordinator; the project and its memory stay.
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsThreadsDelete, {
    payload: ProjectThreadsDeleteInput,
    success: ProjectThreadsDeletion,
    error: Schema.Union([ProjectThreadsDeleteError, EnvironmentAuthorizationError]),
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsThreadIncrementProgressRead, {
    payload: ThreadIncrementProgressInput,
    success: ThreadIncrementProgressSnapshot,
    error,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsIncrementsList, {
    payload: ProjectIncrementsListInput,
    success: ProjectIncrementsListResult,
    error,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsThreadIncrementLink, {
    payload: ThreadIncrementLinkInput,
    success: ThreadIncrementLinkResult,
    error,
  }),
] as const;

/**
 * Project knowledge, registered as its own group: the core group is at
 * TypeScript's instantiation-depth limit (see `WsProjectKnowledgeRpcGroup`).
 */
export const projectKnowledgeRpcs = [
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsKnowledgeRead, {
    payload: ProjectKnowledgeStatusInput,
    success: ProjectKnowledgeStatus,
    error: knowledgeError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsKnowledgeSearch, {
    payload: ProjectKnowledgeSearchInput,
    success: ProjectKnowledgeSearchResult,
    error: knowledgeError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsKnowledgeReindex, {
    payload: ProjectKnowledgeReindexInput,
    success: ProjectKnowledgeStatus,
    error: knowledgeError,
  }),
] as const;

/**
 * The Skills control center: versions, per-agent switches, fleet push and the
 * Skill Studio hand-off. Its own group for the same depth reason (see
 * `WsProjectSkillsActionsRpcGroup`).
 */
const skillsActionError = Schema.Union([ProjectSkillsActionError, EnvironmentAuthorizationError]);
export const projectSkillsActionRpcs = [
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsSkillsVersions, {
    payload: ProjectSkillsVersionsInput,
    success: ProjectSkillsVersions,
    error: skillsActionError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsSkillsAction, {
    payload: ProjectSkillsActionInput,
    success: ProjectSkillsActionResult,
    error: skillsActionError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsSkillsFleetPush, {
    payload: ProjectSkillsFleetPushInput,
    success: ProjectSkillsFleetPushResult,
    error: skillsActionError,
  }),
  Rpc.make(PROJECT_WORKSPACE_RPC_METHODS.projectsSkillsStudioLink, {
    payload: ProjectSkillsStudioLinkInput,
    success: ProjectSkillsStudioLink,
    error: skillsActionError,
  }),
] as const;
