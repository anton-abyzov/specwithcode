import * as ConnectDeviceTrust from "../fleet/ConnectDeviceTrust.ts";
import {
  CLIENT_GUARDED_RPC_SCOPES,
  type DeviceListInput,
  clientRpcRequiredScopes,
  authScopeRequiredResponse,
  AssetCreateUrlInput,
  assetResourceReadsHostFiles,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthPrincipal,
  ServerSettingsPatch,
  ProviderInstanceMutation,
  requiredScopesForServerSettingsPatch,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  ORCHESTRATION_V2_WS_METHODS,
  AuthTerminalReadScope,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  RpcScopeAuthorization,
  WS_METHODS,
  WsRpcGroup,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import type * as RpcGroup from "effect/rpc/RpcGroup";

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

/**
 * Keep authorization coverage coupled to the RPC group itself. Adding an RPC to
 * `WsRpcGroup` without choosing a scope is a type error instead of a production
 * runtime failure.
 */
export const RPC_REQUIRED_SCOPES = {
  ...CLIENT_GUARDED_RPC_SCOPES,
  // Hosting computer use answers agents' desktop actions on this machine.
  [WS_METHODS.computerUseHost]: AuthTerminalOperateScope,
  [WS_METHODS.computerUseRespond]: AuthTerminalOperateScope,
  [WS_METHODS.managedUpdatesStatus]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.startAdversarialReview]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeArchivedShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsPlanRead]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsPlanAuthorityRead]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsPlanExport]: AuthOrchestrationReadScope,
  [WS_METHODS.projectLinkPlanExport]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsUsageRead]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsSkillsRead]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsEnvironmentRead]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsEnvironmentImportPreview]: AuthOrchestrationReadScope,
  // The check walks the folder and reports its checkouts and planning roots.
  [WS_METHODS.projectsFolderCheck]: AuthFilesystemReadScope,
  // Stops threads, like the Stop button.
  [WS_METHODS.projectsFolderStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsWorktreesRead]: AuthFilesystemReadScope,
  // Lists the checkouts inside the project folder.
  [WS_METHODS.projectsRepositoriesRead]: AuthFilesystemReadScope,
  // May clone missing checkouts into the project folder, as vcs clone does.
  [WS_METHODS.projectsRepositoriesCheck]: AuthSourceControlWriteScope,
  // Same scope as vcs.removeWorktree: it removes checkouts.
  [WS_METHODS.projectsWorktreesRemove]: AuthSourceControlWriteScope,
  // Same scope as thread.delete and project.delete.
  [WS_METHODS.projectsThreadsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsWorkspaceRead]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsStarterSuggestions]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsConnectionsRead]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsMemoryRead]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsLibraryRead]: AuthFilesystemReadScope,
  [WS_METHODS.projectsLibraryAddArtifact]: AuthFilesystemWriteScope,
  // Runs `specweave init`, which writes SpecWeave's files into the project folder.
  [WS_METHODS.projectsSpecweaveSetUp]: AuthFilesystemWriteScope,
  // Answers that write no file, so a window without file access can give them (1396).
  [WS_METHODS.projectsSpecweaveAnswer]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsFirstFeatureGuide]: AuthOrchestrationOperateScope,
  // Search results quote Library files, so reading knowledge is a file read.
  [WS_METHODS.projectsKnowledgeRead]: AuthFilesystemReadScope,
  [WS_METHODS.designExport]: AuthFilesystemReadScope,
  [WS_METHODS.designPreviewDeck]: AuthFilesystemReadScope,
  [WS_METHODS.designWatch]: AuthFilesystemReadScope,
  [WS_METHODS.projectsKnowledgeSearch]: AuthFilesystemReadScope,
  [WS_METHODS.projectsKnowledgeReindex]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsThreadReportsRead]: AuthFilesystemReadScope,
  [WS_METHODS.projectsThreadIncrementProgressRead]: AuthFilesystemReadScope,
  [WS_METHODS.projectsIncrementsList]: AuthFilesystemReadScope,
  [WS_METHODS.projectsBoard]: AuthFilesystemReadScope,
  [WS_METHODS.projectsBoardIncrement]: AuthFilesystemReadScope,
  [WS_METHODS.projectsThreadIncrementLink]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCoordinatorMessages]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsThreadReportSave]: AuthFilesystemWriteScope,
  [WS_METHODS.projectsMemoryWrite]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsMemoryDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCoordinatorStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCoordinatorSend]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateProvider]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthStart]: AuthProvidersManageScope,
  [WS_METHODS.providerConsumeResetCredit]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthComplete]: AuthProvidersManageScope,
  [WS_METHODS.chatGptReconnectProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptImportProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptHandoffSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.codexAuthCallbackSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthRespond]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthLogout]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallStart]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.providerInstallRemove]: AuthProvidersManageScope,
  [WS_METHODS.serverUpdateServer]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpdateServerWithProgress]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCommitDesktopUpdate]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverPrepareServiceUpdate]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpsertKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverRemoveKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverGetSettings]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateSettings]: AuthSettingsWriteScope,
  [WS_METHODS.serverSearchAcpRegistry]: AuthOrchestrationReadScope,
  [WS_METHODS.serverPrepareAcpRegistryAgent]: AuthProvidersManageScope,
  [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: AuthProvidersManageScope,
  [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: AuthProvidersManageScope,
  [WS_METHODS.serverListAcpRegistrySessions]: AuthOrchestrationReadScope,
  [WS_METHODS.serverImportAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDeleteAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListAcpRegistryProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverSetAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverDisableAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverLogoutAcpRegistry]: AuthProvidersManageScope,
  [WS_METHODS.serverDiscoverSourceControl]: AuthOrchestrationReadScope,
  [WS_METHODS.serverTeamRulesForFolder]: AuthOrchestrationReadScope,
  // Same scope as editing the hub list: detection names install paths, adoption stores a key.
  [WS_METHODS.serverDetectLocalUsageHubs]: AuthProvidersManageScope,
  [WS_METHODS.serverAdoptLocalUsageHub]: AuthProvidersManageScope,
  [WS_METHODS.serverGetTraceDiagnostics]: AuthDiagnosticsReadScope,
  // Approved mods run in every client, so every reader of this host loads them.
  [WS_METHODS.modsList]: AuthOrchestrationReadScope,
  [WS_METHODS.modsSpecweave]: AuthOrchestrationReadScope,
  [WS_METHODS.composerDraftsGet]: AuthOrchestrationReadScope,
  // Refresh reads public status feeds and this host's checks; it changes nothing.
  [WS_METHODS.statusPageSnapshot]: AuthOrchestrationReadScope,
  [WS_METHODS.statusPageRefresh]: AuthOrchestrationReadScope,
  // Spends the user's own ElevenLabs credit, so only a caller that can operate may ask.
  [WS_METHODS.voiceSynthesize]: AuthOrchestrationOperateScope,
  // Status carries no token, only the paired person's display name.
  [WS_METHODS.telegramChannelStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.googleAccountStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetProcessDiagnostics]: AuthDiagnosticsReadScope,
  // Load-balancing new threads reads host load; that is part of operating
  // threads, not of inspecting diagnostics.
  [WS_METHODS.serverGetHostResources]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetProcessResourceHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetResourceTelemetryHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRetryResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetUsageSummary]: AuthDiagnosticsReadScope,
  // The same quota the server config already carries, kept over time.
  [WS_METHODS.usageLimitsHistory]: AuthOrchestrationReadScope,
  [WS_METHODS.usageLimitsResets]: AuthOrchestrationReadScope,
  // The same transcripts the usage summary reads, grouped by account (1357).
  [WS_METHODS.usageMachineReport]: AuthDiagnosticsReadScope,
  // Team usage (0898): what this machine shares with a team, and whether it does.
  [WS_METHODS.teamUsageStatus]: AuthSettingsWriteScope,
  [WS_METHODS.teamUsageUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.teamUsageOrgs]: AuthSettingsWriteScope,
  [WS_METHODS.resetAnnouncementsList]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRefreshUsageRates]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverSignalProcess]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.serverReportHostPowerState]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverGetBackgroundPolicy]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksList]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.secretsAnswerRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.accessAnswerRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.accessListGrants]: AuthOrchestrationReadScope,
  [WS_METHODS.accessRevokeGrant]: AuthSettingsWriteScope,
  // Lists which machines may read the owner's mail, calendar and files, and the log of it.
  [WS_METHODS.personalDataStatus]: AuthSettingsWriteScope,
  [WS_METHODS.personalDataSetAccess]: AuthSettingsWriteScope,
  [WS_METHODS.serverCleanOldAppVersions]: AuthSettingsWriteScope,
  // The plan names local folders and costs a host lookup per finished folder;
  // the run removes folders. Both are this machine's storage settings.
  [WS_METHODS.serverGetStorageCleanupPlan]: AuthSettingsWriteScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Delivery logs hold request bodies, so they need the same scope as the URL.
  [WS_METHODS.scheduledTasksListWebhookDeliveries]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksGetWebhookDelivery]: AuthOrchestrationOperateScope,
  [WS_METHODS.cloudGetRelayClientStatus]: AuthRelayReadScope,
  [WS_METHODS.cloudInstallRelayClient]: AuthRelayWriteScope,
  [WS_METHODS.pullRequestsList]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsListStats]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSummary]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRouting]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRoutingIdentity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsStack]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLinkedThreads]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsPreview]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsChecks]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsCheckFailureLog]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsThreadComments]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDiffFileContents]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsFilesViewed]: AuthOrchestrationReadScope,
  // Read scope like the reads it un-caches: refreshing is part of reading, and a read-only
  // client pressing refresh must not be told it may not look again.
  [WS_METHODS.pullRequestsInvalidate]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSubscribeRefreshes]: AuthOrchestrationReadScope,
  // The candidate list is a read like the detail beside it; asking somebody for a review is a
  // write like every other one.
  [WS_METHODS.pullRequestsReviewerCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLabelCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlLookupRepository]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeProjectClones]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsListEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsReadFile]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchContents]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsWriteFile]: AuthFilesystemWriteScope,
  [WS_METHODS.projectsEnsureScratch]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateNew]: AuthOrchestrationOperateScope,
  [WS_METHODS.shellOpenInEditor]: AuthOrchestrationOperateScope,
  [WS_METHODS.filesystemBrowse]: AuthFilesystemReadScope,
  [WS_METHODS.filesystemCreateDirectory]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentSessionsScan]: AuthOrchestrationReadScope,
  [WS_METHODS.agentSessionsImport]: AuthOrchestrationOperateScope,
  [WS_METHODS.assetsCreateUrl]: AuthOrchestrationReadScope,
  [WS_METHODS.assetsPersistChatAttachments]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsCreateUploadUrl]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerUploadFeedback]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeWorktreeSetup]: AuthOrchestrationReadScope,
  [WS_METHODS.worktreeSetupCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.vcsRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.gitResolvePullRequest]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [WS_METHODS.reviewGetDiffPreview]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffFileContents]: AuthFilesystemReadScope,
  [WS_METHODS.terminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.terminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.terminalObserve]: AuthTerminalReadScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.terminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClear]: AuthTerminalOperateScope,
  [WS_METHODS.terminalRestart]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClose]: AuthTerminalOperateScope,
  [WS_METHODS.terminalCloseIdle]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalEvents]: AuthTerminalReadScope,
  [WS_METHODS.subscribeTerminalMetadata]: AuthTerminalReadScope,
  [WS_METHODS.previewOpen]: AuthPreviewOperateScope,
  [WS_METHODS.previewNavigate]: AuthPreviewOperateScope,
  [WS_METHODS.previewResize]: AuthPreviewOperateScope,
  [WS_METHODS.previewAdjust]: AuthPreviewOperateScope,
  [WS_METHODS.previewRefresh]: AuthPreviewOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.previewList]: AuthOrchestrationReadScope,
  [WS_METHODS.previewClearProfile]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportStatus]: AuthPreviewOperateScope,
  [WS_METHODS.subscribePreviewEvents]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeDiscoveredLocalServers]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.deviceTestHost]: AuthSettingsWriteScope,
  [WS_METHODS.deviceList]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceClose]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceShutdown]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeDeviceState]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeAuthAccess]: AuthAccessReadScope,
  [WS_METHODS.subscribeBackgroundPolicy]: AuthOrchestrationReadScope,
} as const satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>;

export function requiredScopeForRpcMethod(method: string): AuthEnvironmentScope {
  if (!Object.hasOwn(RPC_REQUIRED_SCOPES, method)) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  const requiredScope = RPC_REQUIRED_SCOPES[method as WsRpcMethod];
  if (requiredScope === undefined) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  return requiredScope;
}

export const rpcAuthorizationError = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: `The authenticated token is missing required scope: ${requiredScope}.`,
    ...authScopeRequiredResponse(requiredScope),
  });

const SettingsUpdate = Schema.Struct({
  patch: ServerSettingsPatch,
  providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
});

const requiredScopesForSettingsUpdate = (payload: unknown) => {
  const input = Schema.decodeUnknownSync(SettingsUpdate)(payload);
  const scopes = requiredScopesForServerSettingsPatch(input.patch);
  if (input.providerInstanceMutation === undefined) return scopes;
  // An atomic provider mutation carries an empty patch unless it also changes settings.
  return Object.values(input.patch).every((value) => value === undefined)
    ? [AuthProvidersManageScope]
    : [...new Set([...scopes, AuthProvidersManageScope])];
};

const requiredScopesForRpcCall = (
  method: string,
  payload: unknown,
): ReadonlyArray<AuthEnvironmentScope> => {
  if (method === WS_METHODS.serverRetryResourceTelemetry) {
    return [AuthEnvironmentMaintainScope, AuthDiagnosticsReadScope];
  }
  if (method === WS_METHODS.assetsCreateUrl) {
    const { resource } = Schema.decodeUnknownSync(AssetCreateUrlInput)(payload);
    return [
      assetResourceReadsHostFiles(resource) ? AuthFilesystemReadScope : AuthOrchestrationReadScope,
    ];
  }
  if (method === WS_METHODS.serverUpdateSettings) return requiredScopesForSettingsUpdate(payload);
  const guarded = clientRpcRequiredScopes(method, payload);
  if (guarded.length > 0) return guarded;
  return [requiredScopeForRpcMethod(method)];
};

/**
 * Methods only this machine's own people may call: they change who may run
 * work here, so another machine's coordinator key is refused even when it
 * holds the scope (as Settings > Machines > Who can run work here is).
 *
 * This meets the bar HTTP grant changes set (requireGrantManager in
 * studioFleetHttp.ts: access:write, a trusted request, never a coordinator
 * principal). The scope is checked per call below. The trusted request is
 * checked once, when the socket opens: a cookie session may open one only
 * from this server's own origin (EnvironmentAuth.authenticateSameOriginRequest),
 * and any other socket comes from a bearer or DPoP credential or a ticket one
 * minted, which the HTTP check also lets through without an Origin. So a
 * socket from the owner's own app is the same-origin request HTTP asks for.
 */
/**
 * The owner's personal data and the accounts behind it: which machines may
 * read mail, calendar and files here, the Google accounts and each project's
 * use of them, and the Telegram chat that reaches the assistant. Another
 * machine's key could otherwise allow itself, switch a project's Google use
 * on, read the account addresses or re-point the chat.
 */
export const PERSONAL_DATA_RPC_METHODS: ReadonlyArray<string> = [
  WS_METHODS.personalDataStatus,
  WS_METHODS.personalDataSetAccess,
  WS_METHODS.googleAccountStatus,
  WS_METHODS.googleAccountConfigureClient,
  WS_METHODS.googleAccountStartSignIn,
  WS_METHODS.googleAccountCompleteSignIn,
  WS_METHODS.googleAccountSetProjectAccess,
  WS_METHODS.googleAccountDisconnect,
  WS_METHODS.googleAccountRemove,
  WS_METHODS.googleAccountSetLabel,
  WS_METHODS.telegramChannelStatus,
  WS_METHODS.telegramChannelConfigure,
  WS_METHODS.telegramChannelUnpair,
  WS_METHODS.telegramChannelRemove,
];

/**
 * Team usage (0898): whether this machine sends its usage summary to a team,
 * where, and under which labels. The member decides on the machine; another
 * machine's key that reached this socket cannot opt it in or read the preview.
 */
export const TEAM_USAGE_OWNER_RPC_METHODS: ReadonlyArray<string> = [
  WS_METHODS.teamUsageStatus,
  WS_METHODS.teamUsageUpdate,
  WS_METHODS.teamUsageOrgs,
];

const OWNER_ONLY_RPC_METHODS: ReadonlySet<string> = new Set([
  WS_METHODS.awayDecideAccess,
  // Away moves this machine's threads, routines and coordinator to another
  // machine, asks that machine for access, or changes when that happens: the
  // owner decides, never a coordinator key that reached this socket.
  WS_METHODS.awayRequestAccess,
  WS_METHODS.awayStart,
  WS_METHODS.awayBringBack,
  WS_METHODS.awayUpdateConfig,
  // Run here anyway may let two machines run one coordinator: the owner's call alone.
  WS_METHODS.awayForceLocal,
  // Sends this machine's secret files, sealed, to one of the owner's machines: a person
  // running the copy decides that, never another machine's key that reached this socket.
  WS_METHODS.machineHandoffCopySealedSecrets,
  // The kept messages between this project's coordinators and every linked machine are
  // for the owner's window; a peer's key reads its own copy on its own machine.
  WS_METHODS.projectsCoordinatorMessages,
  ...PERSONAL_DATA_RPC_METHODS,
  ...TEAM_USAGE_OWNER_RPC_METHODS,
]);

const ownerOnlyRpcMessage = (method: string) =>
  method === WS_METHODS.awayDecideAccess
    ? "Only this machine's owner can approve access here."
    : method === WS_METHODS.machineHandoffCopySealedSecrets
      ? "Only a person running the copy can send this machine's secret files."
      : method === WS_METHODS.projectsCoordinatorMessages
        ? "Only this machine's owner can read the messages between its coordinators."
        : TEAM_USAGE_OWNER_RPC_METHODS.includes(method)
          ? "Only a person on this machine can change what it shares with a team."
          : PERSONAL_DATA_RPC_METHODS.includes(method)
            ? "Only this machine's owner can see or change personal data access here."
            : "Only this machine's owner can start, stop or change Away here.";

export const refusesOwnerOnlyRpc = (method: string, principal: AuthPrincipal | undefined) =>
  principal?.kind === "coordinator" && OWNER_ONLY_RPC_METHODS.has(method);

const LOCAL_COPILOT_OWNER_SUBJECTS: ReadonlySet<string> = new Set([
  "desktop-bootstrap",
  "administrative-bootstrap",
  "local-cli-owner",
  "reusable-dev-token",
  "reusable-dev-token-child",
]);

/** Host selection belongs to local owners, including headless and service installs. */
export function canSelectCopilotSignInHost(session: {
  readonly subject: string;
  readonly principal?: AuthPrincipal | undefined;
  readonly deviceKey?: string | undefined;
  readonly boundDevice?: unknown;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}): boolean {
  return (
    session.principal === undefined &&
    session.deviceKey === undefined &&
    session.boundDevice === undefined &&
    session.scopes.includes(AuthProvidersManageScope) &&
    (LOCAL_COPILOT_OWNER_SUBJECTS.has(session.subject) ||
      (session.subject === "one-time-token" && session.scopes.includes(AuthAccessWriteScope)))
  );
}

/** Authorizes every RPC on one connection against that connection's session scopes. */
export const layer = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  principal?: AuthPrincipal | undefined,
  /** The approved device behind this connection (1327); what its calls mint is bound to it. */
  deviceKey?: string | undefined,
) =>
  Layer.succeed(RpcScopeAuthorization)((call, { rpc, payload }) => {
    const effect =
      deviceKey === undefined
        ? call
        : call.pipe(Effect.provideService(ConnectDeviceTrust.RequestDevice, deviceKey));
    if (refusesOwnerOnlyRpc(rpc._tag, principal)) {
      return Effect.fail(
        new EnvironmentAuthorizationError({
          message: ownerOnlyRpcMessage(rpc._tag),
          requiredScope: AuthAccessWriteScope,
        }),
      );
    }
    const requiredScopes = requiredScopesForRpcCall(rpc._tag, payload);
    const requiredScope = requiredScopes.find((scope) => !scopes.includes(scope));
    return requiredScope === undefined ? effect : Effect.fail(rpcAuthorizationError(requiredScope));
  });

/** Retrying can install or restart tools even though ordinary listing is readable. */
export const requiredScopeForDeviceList = (input: DeviceListInput): AuthEnvironmentScope =>
  input.retryHostId || input.updateTool
    ? AuthOrchestrationOperateScope
    : AuthOrchestrationReadScope;
