import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemWriteScope,
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";
import { PROVISION_RPC_METHODS } from "./provision.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.voiceSynthesize]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsEnvironmentImport]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsThreadsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.nativeConnectionsRead]: AuthFilesystemReadScope,
  [WS_METHODS.browserBridgeStatus]: AuthFilesystemReadScope,
  // Both start Claude Code's browser server, a local process.
  [WS_METHODS.browserBridgeTest]: AuthTerminalOperateScope,
  [WS_METHODS.browserBridgeReconnect]: AuthTerminalOperateScope,
  [WS_METHODS.browserExtensionStatus]: AuthFilesystemReadScope,
  // The pairing code lets a Chrome profile answer agents on this machine.
  [WS_METHODS.browserExtensionPairing]: AuthTerminalOperateScope,
  [WS_METHODS.browserExtensionTest]: AuthTerminalOperateScope,
  [WS_METHODS.browserExtensionReconnect]: AuthTerminalOperateScope,
  [WS_METHODS.browserExtensionStop]: AuthTerminalOperateScope,
  // Lets another machine's threads act in the signed-in Chrome here.
  [WS_METHODS.browserExtensionPeer]: AuthAccessWriteScope,
  [WS_METHODS.nativeConnectionApply]: AuthFilesystemWriteScope,
  // Skills control center. Writes widen per action kind in `projectSkillsActionScopes`.
  [WS_METHODS.projectsSkillsVersions]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsSkillsAction]: AuthFilesystemWriteScope,
  // Installs on other machines, like a fleet update.
  [WS_METHODS.projectsSkillsFleetPush]: AuthEnvironmentMaintainScope,
  [WS_METHODS.projectsSkillsStudioLink]: AuthOrchestrationOperateScope,
  [WS_METHODS.managedUpdatesEnroll]: AuthAccessWriteScope,
  [WS_METHODS.managedUpdatesRevoke]: AuthAccessWriteScope,
  [WS_METHODS.managedUpdatesCheck]: AuthEnvironmentMaintainScope,
  [WS_METHODS.machineHandoffPrepare]: AuthOrchestrationOperateScope,
  [WS_METHODS.machineHandoffReceive]: AuthSourceControlWriteScope,
  // Provisioning reads the machine like Check readiness and installs like a server update.
  [PROVISION_RPC_METHODS.provisionPreview]: AuthFilesystemReadScope,
  [PROVISION_RPC_METHODS.provisionRun]: AuthEnvironmentMaintainScope,
  // Reading a folder's repositories and a copy's notes before linking.
  [WS_METHODS.projectsFingerprint]: AuthFilesystemReadScope,
  [WS_METHODS.projectLinkPreview]: AuthOrchestrationReadScope,
  // Linking rewrites who coordinates a project, like a handoff.
  [WS_METHODS.projectLinkPrepare]: AuthSettingsWriteScope,
  [WS_METHODS.projectLinkAccept]: AuthSettingsWriteScope,
  [WS_METHODS.projectLinkCommit]: AuthSettingsWriteScope,
  [WS_METHODS.projectUnlink]: AuthSettingsWriteScope,
  [WS_METHODS.machineHandoffCopyOffer]: AuthOrchestrationOperateScope,
  [WS_METHODS.machineHandoffCopyScopes]: AuthFilesystemReadScope,
  [WS_METHODS.machineHandoffCopyCapabilities]: AuthFilesystemReadScope,
  [WS_METHODS.machineHandoffCopySourceStatus]: AuthFilesystemReadScope,
  [WS_METHODS.machineHandoffCopySourceCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.machineHandoffCopyRelease]: AuthOrchestrationOperateScope,
  [WS_METHODS.machineHandoffCopyStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.machineHandoffCopyStatus]: AuthFilesystemReadScope,
  [WS_METHODS.machineHandoffCopyDecide]: AuthOrchestrationOperateScope,
  [WS_METHODS.machineHandoffCopyApprove]: AuthFilesystemWriteScope,
  [WS_METHODS.machineHandoffCopyRetry]: AuthFilesystemWriteScope,
  [WS_METHODS.machineHandoffCopyUndo]: AuthFilesystemWriteScope,
  [WS_METHODS.machineHandoffCopyCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.machineHandoffCopySecrets]: AuthAccessWriteScope,
  [WS_METHODS.machineHandoffSentSecrets]: AuthFilesystemReadScope,
  [WS_METHODS.machineHandoffReadiness]: AuthFilesystemReadScope,
  // Handoff mode: settings, per-thread checkpoints (a Git ref, maybe pushed) and moving work.
  [WS_METHODS.handoffModeSnapshot]: AuthOrchestrationReadScope,
  [WS_METHODS.handoffModeUpdateConfig]: AuthSettingsWriteScope,
  [WS_METHODS.handoffModeSetThreadMode]: AuthOrchestrationOperateScope,
  [WS_METHODS.handoffModeSetProjectMode]: AuthSettingsWriteScope,
  [WS_METHODS.handoffModeCheckpointNow]: AuthSourceControlWriteScope,
  [WS_METHODS.handoffModeHandOff]: AuthOrchestrationOperateScope,
  [WS_METHODS.handoffModeHandOffMachine]: AuthOrchestrationOperateScope,
  [WS_METHODS.handoffModeContinueHere]: AuthOrchestrationOperateScope,
  [WS_METHODS.handoffModeResumeFenced]: AuthOrchestrationOperateScope,
  [WS_METHODS.handoffModePreflight]: AuthOrchestrationReadScope,
  [WS_METHODS.projectLinkDigest]: AuthOrchestrationReadScope,
  [WS_METHODS.projectLinkMemoryExport]: AuthOrchestrationReadScope,
  [WS_METHODS.projectLinkMemoryMerge]: AuthSettingsWriteScope,
  // Machine names, grant status and usage of paired machines for one thread.
  [WS_METHODS.limitHandoffCandidates]: AuthOrchestrationReadScope,
  // A member's read-only copy of its coordinator's notes, and taking over or giving way.
  [WS_METHODS.projectLinkReplicate]: AuthSettingsWriteScope,
  [WS_METHODS.projectTakeover]: AuthSettingsWriteScope,
  [WS_METHODS.projectSupersede]: AuthSettingsWriteScope,
  [WS_METHODS.projectStartCoordinator]: AuthSettingsWriteScope,
  // Arming automatic takeover lets another machine become the coordinator.
  [WS_METHODS.projectSetStandby]: AuthSettingsWriteScope,
  [WS_METHODS.projectAcceptStandby]: AuthSettingsWriteScope,
  [WS_METHODS.projectsEnvironmentPrepare]: AuthSourceControlWriteScope,
  [WS_METHODS.projectsPlanReplace]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsPlanConfigure]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsPlanClaim]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsPlanRelease]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsPlanReport]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsPlanVerify]: AuthOrchestrationOperateScope,
  // Applies claims made on a linked machine, like claiming here.
  [WS_METHODS.projectLinkPlanMerge]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsMemoryWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsLibraryAddArtifact]: AuthFilesystemWriteScope,
  // Designs are files in the project checkout or the app's Playground folder.
  [WS_METHODS.designList]: AuthFilesystemReadScope,
  [WS_METHODS.designGet]: AuthFilesystemReadScope,
  [WS_METHODS.designHistory]: AuthFilesystemReadScope,
  [WS_METHODS.designExport]: AuthFilesystemReadScope,
  [WS_METHODS.designPreviewDeck]: AuthFilesystemReadScope,
  [WS_METHODS.designSystemList]: AuthFilesystemReadScope,
  [WS_METHODS.designSystemGet]: AuthFilesystemReadScope,
  [WS_METHODS.designSystemUsage]: AuthFilesystemReadScope,
  [WS_METHODS.designCreate]: AuthFilesystemWriteScope,
  [WS_METHODS.designApply]: AuthFilesystemWriteScope,
  [WS_METHODS.designSaveVersion]: AuthFilesystemWriteScope,
  [WS_METHODS.designRestore]: AuthFilesystemWriteScope,
  [WS_METHODS.designCopy]: AuthFilesystemWriteScope,
  [WS_METHODS.designMove]: AuthFilesystemWriteScope,
  [WS_METHODS.designImportDeck]: AuthFilesystemWriteScope,
  [WS_METHODS.designDelete]: AuthFilesystemWriteScope,
  [WS_METHODS.designAssetPut]: AuthFilesystemWriteScope,
  [WS_METHODS.designSystemCopy]: AuthFilesystemWriteScope,
  [WS_METHODS.designSystemRename]: AuthFilesystemWriteScope,
  [WS_METHODS.designSystemDelete]: AuthFilesystemWriteScope,
  // Design-system import reads the checkout and holds proposals; only confirm writes.
  [WS_METHODS.designSystemScan]: AuthFilesystemReadScope,
  [WS_METHODS.designSystemPropose]: AuthFilesystemReadScope,
  [WS_METHODS.designSystemProposals]: AuthFilesystemReadScope,
  [WS_METHODS.designSystemProposal]: AuthFilesystemReadScope,
  [WS_METHODS.designSystemRescan]: AuthFilesystemReadScope,
  [WS_METHODS.designSystemFigmaStatus]: AuthFilesystemReadScope,
  [WS_METHODS.designSystemConfirm]: AuthFilesystemWriteScope,
  [WS_METHODS.designSystemDiscard]: AuthFilesystemWriteScope,
  // Runs the kit's own code in a child process and stores the previews it renders.
  [WS_METHODS.designSystemRebuildPreviews]: AuthFilesystemWriteScope,
  // Hand editing: files and source reads need read; every change needs write.
  [WS_METHODS.designSystemFiles]: AuthFilesystemReadScope,
  [WS_METHODS.designSystemFileRead]: AuthFilesystemReadScope,
  [WS_METHODS.designSystemCreate]: AuthFilesystemWriteScope,
  [WS_METHODS.designSystemApply]: AuthFilesystemWriteScope,
  [WS_METHODS.designSystemFilePut]: AuthFilesystemWriteScope,
  [WS_METHODS.designSystemFileDelete]: AuthFilesystemWriteScope,
  [WS_METHODS.designSystemFileMove]: AuthFilesystemWriteScope,
  [WS_METHODS.projectsKnowledgeReindex]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsThreadReportSave]: AuthFilesystemWriteScope,
  [WS_METHODS.projectsConnectionSave]: AuthTerminalOperateScope,
  [WS_METHODS.projectsConnectionCheck]: AuthTerminalOperateScope,
  [WS_METHODS.projectsConnectionRevoke]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsMemoryDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCoordinatorStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCoordinatorSend]: AuthOrchestrationOperateScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  // Signing gh in stores a GitHub credential on that machine, like saving a token in Settings.
  // Status carries the one-time code, so reading it needs the same scope.
  [WS_METHODS.gitHubSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.gitHubSignInStatus]: AuthSettingsWriteScope,
  [WS_METHODS.gitHubSignInCancel]: AuthSettingsWriteScope,
  // Copying a sign-in reads this machine's token and stores it on another; both ends need it.
  [WS_METHODS.gitHubCredentialState]: AuthSettingsWriteScope,
  [WS_METHODS.gitHubCredentialRemoveCopied]: AuthSettingsWriteScope,
  [WS_METHODS.gitHubCredentialCopyPreview]: AuthSettingsWriteScope,
  [WS_METHODS.gitHubCredentialCopy]: AuthSettingsWriteScope,
  // Runs git with this machine's credentials; only offered before a clone, which needs write.
  [WS_METHODS.sourceControlCheckRemoteAccess]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlInspectDestination]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.projectsWorktreesRemove]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRestoreThreadWorkspace]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,

  // Approving a mod lets its code run in every client of this host.
  [WS_METHODS.modsApprove]: AuthSettingsWriteScope,
  [WS_METHODS.modsDisable]: AuthSettingsWriteScope,

  [WS_METHODS.composerDraftsPut]: AuthOrchestrationOperateScope,
  [WS_METHODS.composerDraftsDelete]: AuthOrchestrationOperateScope,

  // The paired chat can start coordinator turns, so changing it is a settings write.
  [WS_METHODS.telegramChannelConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.telegramChannelUnpair]: AuthSettingsWriteScope,
  [WS_METHODS.telegramChannelRemove]: AuthSettingsWriteScope,
  [WS_METHODS.googleAccountConfigureClient]: AuthSettingsWriteScope,
  [WS_METHODS.googleAccountStartSignIn]: AuthSettingsWriteScope,
  [WS_METHODS.googleAccountCompleteSignIn]: AuthSettingsWriteScope,
  [WS_METHODS.googleAccountSetProjectAccess]: AuthSettingsWriteScope,
  [WS_METHODS.googleAccountDisconnect]: AuthSettingsWriteScope,
  [WS_METHODS.googleAccountRemove]: AuthSettingsWriteScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);

/**
 * Folder copy: offering serves the project's files to one machine; Apply writes
 * a folder, runs Git and registers a project; release returns a coordinator.
 */
function folderCopyScopes(method: string, input: unknown): readonly AuthEnvironmentScope[] | null {
  const read = [AuthOrchestrationReadScope, AuthFilesystemReadScope] as const;
  switch (method) {
    case WS_METHODS.machineHandoffCopyScopes:
    case WS_METHODS.machineHandoffCopyCapabilities:
    case WS_METHODS.machineHandoffCopySourceStatus:
    case WS_METHODS.machineHandoffCopyStatus:
    case WS_METHODS.machineHandoffSentSecrets:
    case WS_METHODS.machineHandoffReadiness:
    case PROVISION_RPC_METHODS.provisionPreview:
      return read;
    // Sends secret files to another machine: as strong as granting it access.
    case WS_METHODS.machineHandoffCopySecrets:
      return [...read, AuthOrchestrationOperateScope, AuthAccessWriteScope];
    case WS_METHODS.machineHandoffCopyOffer:
    case WS_METHODS.machineHandoffCopySourceCancel:
    case WS_METHODS.machineHandoffCopyStart:
    case WS_METHODS.machineHandoffCopyDecide:
    case WS_METHODS.machineHandoffCopyCancel:
      return [...read, AuthOrchestrationOperateScope];
    case WS_METHODS.machineHandoffCopyRelease:
      return [...read, AuthOrchestrationOperateScope, AuthSourceControlWriteScope];
    case WS_METHODS.machineHandoffCopyUndo:
      if ((input as { preview?: boolean } | undefined)?.preview === true) return read;
      return [
        ...read,
        AuthFilesystemWriteScope,
        AuthSourceControlWriteScope,
        AuthOrchestrationOperateScope,
      ];
    case WS_METHODS.machineHandoffCopyApprove:
    case WS_METHODS.machineHandoffCopyRetry:
      return [
        ...read,
        AuthFilesystemWriteScope,
        AuthSourceControlWriteScope,
        AuthOrchestrationOperateScope,
        AuthSettingsWriteScope,
      ];
    default:
      return null;
  }
}

/**
 * `projects.skillsAction` by action kind: every kind writes a file; all but a
 * Claude skill switch (a settings edit) also start a CLI or app server. An
 * action that cannot be read takes the wider set.
 */
/** Agents whose skill switch is an edit to their own settings file, with no CLI run. */
export const FILE_SWITCHED_SKILL_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "grok",
  "opencode",
  "pi",
  "acpRegistry",
]);

export function projectSkillsActionScopes(input: unknown): readonly AuthEnvironmentScope[] {
  const action =
    typeof input === "object" && input !== null
      ? (input as { readonly action?: { readonly kind?: unknown; readonly provider?: unknown } })
          .action
      : undefined;
  return action?.kind === "toggle-skill" &&
    typeof action.provider === "string" &&
    FILE_SWITCHED_SKILL_DRIVERS.has(action.provider)
    ? [AuthFilesystemWriteScope]
    : [AuthFilesystemWriteScope, AuthTerminalOperateScope];
}

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.managedUpdatesEnroll || method === WS_METHODS.managedUpdatesRevoke)
    return [AuthAccessWriteScope, AuthEnvironmentMaintainScope];
  if (method === WS_METHODS.machineHandoffPrepare || method === WS_METHODS.machineHandoffReceive) {
    const value = input as { publish?: boolean; mode?: string } | undefined;
    const writes =
      method === WS_METHODS.machineHandoffPrepare
        ? value?.publish === true
        : value?.mode === "start";
    return writes
      ? [
          AuthOrchestrationReadScope,
          AuthFilesystemReadScope,
          AuthFilesystemWriteScope,
          AuthSourceControlWriteScope,
          AuthOrchestrationOperateScope,
          ...(method === WS_METHODS.machineHandoffReceive ? [AuthSettingsWriteScope] : []),
        ]
      : [AuthOrchestrationReadScope, AuthFilesystemReadScope];
  }
  if (
    method === WS_METHODS.projectLinkPrepare ||
    method === WS_METHODS.projectLinkAccept ||
    method === WS_METHODS.projectLinkCommit ||
    method === WS_METHODS.projectUnlink ||
    method === WS_METHODS.projectLinkReplicate ||
    method === WS_METHODS.projectLinkMemoryMerge ||
    method === WS_METHODS.projectTakeover ||
    method === WS_METHODS.projectSupersede ||
    method === WS_METHODS.projectStartCoordinator ||
    method === WS_METHODS.projectSetStandby ||
    method === WS_METHODS.projectAcceptStandby
  )
    return [AuthSettingsWriteScope, AuthOrchestrationOperateScope];
  // Moving a thread writes a checkpoint ref (pushed when allowed) and starts work elsewhere.
  if (
    method === WS_METHODS.handoffModeHandOff ||
    method === WS_METHODS.handoffModeHandOffMachine ||
    method === WS_METHODS.handoffModeContinueHere
  )
    return [AuthOrchestrationOperateScope, AuthSourceControlWriteScope];
  if (method === WS_METHODS.projectLinkPreview)
    return [AuthOrchestrationReadScope, AuthFilesystemReadScope];
  const copyScopes = folderCopyScopes(method, input);
  if (copyScopes) return copyScopes;
  // Knowledge describes the project and quotes its Library files.
  if (method === WS_METHODS.projectsKnowledgeRead || method === WS_METHODS.projectsKnowledgeSearch)
    return [AuthOrchestrationReadScope, AuthFilesystemReadScope];
  // A subscription, so not in the unary map.
  if (method === WS_METHODS.designWatch) return [AuthFilesystemReadScope];
  if (method === WS_METHODS.projectsConnectionSave || method === WS_METHODS.projectsConnectionCheck)
    return [AuthOrchestrationOperateScope, AuthTerminalOperateScope];
  if (method === WS_METHODS.projectsSkillsAction) return projectSkillsActionScopes(input);
  // Writes another tool's configuration, which that tool then runs as commands.
  if (method === WS_METHODS.nativeConnectionApply)
    return [AuthFilesystemWriteScope, AuthTerminalOperateScope];
  if (method === WS_METHODS.projectsPlanVerify)
    return [AuthOrchestrationOperateScope, AuthTerminalOperateScope];
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
