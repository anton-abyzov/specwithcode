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

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.projectsEnvironmentImport]: AuthOrchestrationOperateScope,
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
  [WS_METHODS.browserExtensionInstallFolder]: AuthFilesystemWriteScope,
  [WS_METHODS.nativeConnectionApply]: AuthFilesystemWriteScope,
  [WS_METHODS.managedUpdatesEnroll]: AuthAccessWriteScope,
  [WS_METHODS.managedUpdatesRevoke]: AuthAccessWriteScope,
  [WS_METHODS.managedUpdatesCheck]: AuthEnvironmentMaintainScope,
  [WS_METHODS.machineHandoffPrepare]: AuthOrchestrationOperateScope,
  [WS_METHODS.machineHandoffReceive]: AuthSourceControlWriteScope,
  [WS_METHODS.projectsEnvironmentPrepare]: AuthSourceControlWriteScope,
  [WS_METHODS.projectsPlanReplace]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsPlanConfigure]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsPlanClaim]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsPlanRelease]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsPlanReport]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsPlanVerify]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsMemoryWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsLibraryAddArtifact]: AuthFilesystemWriteScope,
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
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
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
  if (method === WS_METHODS.projectsConnectionSave || method === WS_METHODS.projectsConnectionCheck)
    return [AuthOrchestrationOperateScope, AuthTerminalOperateScope];
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
