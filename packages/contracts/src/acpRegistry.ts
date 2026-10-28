import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderOptionDescriptor } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const AcpRegistryAgentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/),
);

const ACP_REGISTRY_CDN_HOSTNAME = "cdn.agentclientprotocol.com";
const ACP_REGISTRY_AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export const GITHUB_COPILOT_AGENT_ID = "github-copilot-cli";

/**
 * The official GitHub Copilot mark, as GitHub publishes it for its agent in the
 * ACP Registry (registry/v1/latest/github-copilot-cli.svg). Every Copilot
 * surface renders these paths; there is no second Copilot glyph.
 */
export const GITHUB_COPILOT_ICON_VIEW_BOX = "0 0 16 16";
export const GITHUB_COPILOT_ICON_PATHS = [
  "M7.99816 14.2779C12.0678 14.2779 14.9997 11.6274 14.9997 10.9574V9.3189C14.939 8.77306 14.4165 7.82349 13.6074 7.48636C13.5959 7.42498 13.5859 7.36153 13.5756 7.29542C13.5506 7.13548 13.5231 6.95977 13.4649 6.75954C13.6409 6.31508 13.6873 5.81187 13.6873 5.31135C13.6873 4.54947 13.5757 3.76321 13.0811 3.13712C12.5745 2.4959 11.7737 2.15372 10.6972 2.03411C9.64215 1.91688 8.71828 2.06409 8.12157 2.70342C8.07827 2.74981 8.0345 2.79812 7.99655 2.84746C7.95861 2.79812 7.91805 2.74981 7.87475 2.70342C7.27804 2.06409 6.35416 1.91688 5.29908 2.03411C4.22263 2.15372 3.42181 2.4959 2.91521 3.13712C2.42057 3.76321 2.30905 4.54947 2.30905 5.31135C2.30905 5.81187 2.35539 6.31508 2.53142 6.75954C2.47323 6.95977 2.44574 7.13542 2.42072 7.29536C2.41037 7.3615 2.40044 7.42496 2.38893 7.48636C1.57983 7.82349 1.05728 8.77306 0.996582 9.3189V10.9574C0.996582 11.6274 3.92849 14.2779 7.99816 14.2779ZM10.5523 3.33859C9.63863 3.23707 9.25001 3.41798 9.0811 3.59896C8.90273 3.79007 8.76738 4.19254 8.86971 5.0112C8.94909 5.64627 9.13423 6.08757 9.41018 6.36929C9.67188 6.63645 10.0966 6.8426 10.8435 6.8426C11.6506 6.8426 11.9631 6.66867 12.1051 6.51046C12.2619 6.33577 12.3748 6.00462 12.3748 5.31135C12.3748 4.64141 12.2675 4.22455 12.0513 3.95077C11.8469 3.69214 11.4446 3.43773 10.5523 3.33859ZM6.91639 3.59896C6.74748 3.41798 6.35886 3.23707 5.44518 3.33859C4.55289 3.43773 4.15058 3.69214 3.94624 3.95077C3.72994 4.22455 3.62271 4.64141 3.62271 5.31135C3.62271 6.00462 3.73563 6.33577 3.89239 6.51046C4.03436 6.66867 4.34693 6.8426 5.15396 6.8426C5.90092 6.8426 6.32561 6.63645 6.58731 6.36929C6.86326 6.08757 7.0484 5.64627 7.12778 5.0112C7.23011 4.19254 7.09476 3.79007 6.91639 3.59896ZM7.99818 12.9788C9.99307 12.9788 12.0088 12.0076 12.3748 11.7248V8.00133L12.3546 7.90026C11.9257 8.08369 11.4142 8.1551 10.8435 8.1551C9.84049 8.1551 9.04148 7.86851 8.47257 7.28773C8.28092 7.09208 8.12536 6.87308 7.99978 6.6378C7.8742 6.87308 7.71544 7.09208 7.52378 7.28773C6.95488 7.86851 6.15587 8.1551 5.15283 8.1551C4.58212 8.1551 4.07068 8.08369 3.6418 7.90026L3.62158 8.00133V11.7248C3.98755 12.0076 6.00329 12.9788 7.99818 12.9788Z",
  "M6.46854 9.0301C6.83097 9.0301 7.12479 9.32391 7.12479 9.68635V10.9988C7.12479 11.3613 6.83097 11.6551 6.46854 11.6551C6.1061 11.6551 5.81229 11.3613 5.81229 10.9988V9.68635C5.81229 9.32391 6.1061 9.0301 6.46854 9.0301Z",
  "M10.1873 9.68635C10.1873 9.32391 9.89347 9.0301 9.53104 9.0301C9.1686 9.0301 8.87479 9.32391 8.87479 9.68635V10.9988C8.87479 11.3613 9.1686 11.6551 9.53104 11.6551C9.89347 11.6551 10.1873 11.3613 10.1873 10.9988V9.68635Z",
] as const;

/** Match registry identity, never a user-editable display name. */
export function isGitHubCopilotIcon(agentId?: string | null, icon?: string | null): boolean {
  if (agentId) return agentId.trim() === GITHUB_COPILOT_AGENT_ID;
  const allowed = resolveOfficialAcpRegistryIconUrl(icon);
  return (
    allowed !== null && new URL(allowed).pathname === "/registry/v1/latest/github-copilot-cli.svg"
  );
}

/**
 * A local command keeps Copilot branding only when it names GitHub's agent and
 * the executable is Copilot itself, so a repointed command never inherits it.
 */
export function isLocalGitHubCopilotCommand(
  agentId: string | null | undefined,
  commandPath: string | null | undefined,
): boolean {
  if (agentId?.trim() !== GITHUB_COPILOT_AGENT_ID) return false;
  const executable = commandPath?.trim().split(/[\\/]/u).pop()?.toLowerCase() ?? "";
  return /^copilot(?:\.(?:exe|cmd|bat))?$/u.test(executable);
}

/**
 * DeepSeek Harness (`@deepseek-ai/dsh`) is not in the ACP Registry, so a local
 * `dsh` command is the only way to recognise it. The id is Studio's own name
 * for it and never resolves to a Registry icon.
 */
export const DEEPSEEK_HARNESS_AGENT_ID = "deepseek-harness";

export function isLocalDeepSeekHarnessCommand(commandPath: string | null | undefined): boolean {
  const executable = commandPath?.trim().split(/[\\/]/u).pop()?.toLowerCase() ?? "";
  return /^dsh(?:\.(?:exe|cmd|bat))?$/u.test(executable);
}

/** The agent a local ACP command runs, when the command is recognisably one we brand. */
export function localAcpAgentIdForCommand(
  agentId: string | null | undefined,
  commandPath: string | null | undefined,
): string | null {
  if (isLocalGitHubCopilotCommand(agentId, commandPath)) return GITHUB_COPILOT_AGENT_ID;
  if (isLocalDeepSeekHarnessCommand(commandPath)) return DEEPSEEK_HARNESS_AGENT_ID;
  return null;
}

/**
 * The official Copilot icon URL for a configured provider instance, or null when
 * the instance is not GitHub Copilot. Clients use it to name Copilot even when a
 * snapshot from an older server carries no icon.
 */
export function gitHubCopilotIconUrlForInstanceConfig(config: unknown): string | null {
  if (config === null || typeof config !== "object") return null;
  const { source, agentId, commandPath } = config as Record<string, unknown>;
  const agent = typeof agentId === "string" ? agentId : null;
  const copilot =
    source === "local"
      ? isLocalGitHubCopilotCommand(agent, typeof commandPath === "string" ? commandPath : null)
      : isGitHubCopilotIcon(agent);
  return copilot ? officialAcpRegistryIconUrlForAgentId(GITHUB_COPILOT_AGENT_ID) : null;
}

/** Derives the official Registry icon URL without trusting stored URL metadata. */
export function officialAcpRegistryIconUrlForAgentId(
  agentId: string | null | undefined,
): string | null {
  if (agentId === null || agentId === undefined || !ACP_REGISTRY_AGENT_ID_PATTERN.test(agentId)) {
    return null;
  }
  return `https://${ACP_REGISTRY_CDN_HOSTNAME}/registry/v1/latest/${agentId}.svg`;
}

/** Allows provider icons only from the credential-free official Registry CDN origin. */
export function resolveOfficialAcpRegistryIconUrl(icon: string | null | undefined): string | null {
  if (!icon) return null;
  try {
    const url = new URL(icon);
    if (
      url.protocol !== "https:" ||
      url.hostname !== ACP_REGISTRY_CDN_HOSTNAME ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export const AcpRegistryDistribution = Schema.Literals(["binary", "npx", "uvx"]);
export type AcpRegistryDistribution = typeof AcpRegistryDistribution.Type;

export const AcpRegistryIntegrity = Schema.Literals(["sha256", "registry"]);
export type AcpRegistryIntegrity = typeof AcpRegistryIntegrity.Type;

export const AcpRegistrySearchInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMaxLength(120)),
});
export type AcpRegistrySearchInput = typeof AcpRegistrySearchInput.Type;

const AcpRegistryUrl = Schema.String.check(Schema.isMaxLength(2_048));

export const AcpRegistrySearchAgent = Schema.Struct({
  id: AcpRegistryAgentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  description: Schema.String.check(Schema.isMaxLength(1_024)),
  authors: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).check(Schema.isMaxLength(16)),
  license: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  website: Schema.NullOr(AcpRegistryUrl),
  repository: Schema.NullOr(AcpRegistryUrl),
  icon: Schema.NullOr(AcpRegistryUrl),
  distribution: AcpRegistryDistribution,
  integrity: AcpRegistryIntegrity,
});
export type AcpRegistrySearchAgent = typeof AcpRegistrySearchAgent.Type;

export const AcpRegistrySearchResult = Schema.Struct({
  agents: Schema.Array(AcpRegistrySearchAgent).check(Schema.isMaxLength(20)),
});
export type AcpRegistrySearchResult = typeof AcpRegistrySearchResult.Type;

export const AcpRegistryPrepareInput = Schema.Struct({
  agentId: AcpRegistryAgentId,
});
export type AcpRegistryPrepareInput = typeof AcpRegistryPrepareInput.Type;

export const AcpRegistryPrepareResult = Schema.Struct({
  agentId: AcpRegistryAgentId,
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  distribution: AcpRegistryDistribution,
  prepared: Schema.Literal(true),
  /** The installed command, for package distributions. Absent from older servers. */
  executablePath: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type AcpRegistryPrepareResult = typeof AcpRegistryPrepareResult.Type;

export const AcpRegistryManagedBinaryUninstallInput = Schema.Struct({
  agentId: AcpRegistryAgentId,
});
export type AcpRegistryManagedBinaryUninstallInput =
  typeof AcpRegistryManagedBinaryUninstallInput.Type;

export const AcpRegistryManagedBinaryUninstallResult = Schema.Struct({
  agentId: AcpRegistryAgentId,
  removed: Schema.Boolean,
});
export type AcpRegistryManagedBinaryUninstallResult =
  typeof AcpRegistryManagedBinaryUninstallResult.Type;

const AcpRegistryProbeText = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const AcpRegistryProbeDescription = Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024)));

export const AcpRegistryProbeAuthMethod = Schema.Struct({
  id: AcpRegistryProbeText,
  name: AcpRegistryProbeText,
  description: AcpRegistryProbeDescription,
  type: Schema.Literals(["agent", "env_var", "terminal"]),
  // Terminal methods: the full command line the user runs in a thread
  // terminal on the owning environment to complete interactive auth.
  command: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
  // Env-var methods: variable names the user sets on the provider instance.
  envVarNames: Schema.optionalKey(Schema.Array(AcpRegistryProbeText).check(Schema.isMaxLength(16))),
  // Env-var methods may advertise where credentials can be created.
  link: Schema.optionalKey(AcpRegistryUrl),
});
export type AcpRegistryProbeAuthMethod = typeof AcpRegistryProbeAuthMethod.Type;

export const AcpRegistryUrlAuthAction = Schema.Struct({
  elicitationId: AcpRegistryProbeText,
  url: AcpRegistryUrl,
  message: Schema.String.check(Schema.isMaxLength(1_024)),
  // Optional for mixed-version clients. New servers include both timestamps
  // so a pending browser login remains understandable on another device.
  createdAt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  expiresAt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});
export type AcpRegistryUrlAuthAction = typeof AcpRegistryUrlAuthAction.Type;

export const AcpRegistryAcceptUrlAuthInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  elicitationId: AcpRegistryProbeText,
});
export type AcpRegistryAcceptUrlAuthInput = typeof AcpRegistryAcceptUrlAuthInput.Type;

export const AcpRegistryAcceptUrlAuthResult = Schema.Struct({
  accepted: Schema.Boolean,
});
export type AcpRegistryAcceptUrlAuthResult = typeof AcpRegistryAcceptUrlAuthResult.Type;

const AcpRegistrySessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(1_024));
const AcpRegistrySessionPath = TrimmedNonEmptyString.check(Schema.isMaxLength(4_096));

export const AcpRegistrySession = Schema.Struct({
  sessionId: AcpRegistrySessionId,
  cwd: AcpRegistrySessionPath,
  additionalDirectories: Schema.Array(AcpRegistrySessionPath).check(Schema.isMaxLength(32)),
  title: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1_024))),
  updatedAt: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  importedThreadId: Schema.NullOr(ThreadId),
});
export type AcpRegistrySession = typeof AcpRegistrySession.Type;

export const AcpRegistryListSessionsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2_048))),
});
export type AcpRegistryListSessionsInput = typeof AcpRegistryListSessionsInput.Type;

export const AcpRegistryListSessionsResult = Schema.Struct({
  sessions: Schema.Array(AcpRegistrySession).check(Schema.isMaxLength(256)),
  nextCursor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_048))),
  canLoad: Schema.Boolean,
  canResume: Schema.Boolean,
  canDelete: Schema.Boolean,
});
export type AcpRegistryListSessionsResult = typeof AcpRegistryListSessionsResult.Type;

export const AcpRegistryImportSessionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  sessionId: AcpRegistrySessionId,
  title: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)))),
  updatedAt: Schema.optionalKey(
    Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  ),
});
export type AcpRegistryImportSessionInput = typeof AcpRegistryImportSessionInput.Type;

export const AcpRegistryImportSessionResult = Schema.Struct({
  threadId: ThreadId,
  imported: Schema.Boolean,
});
export type AcpRegistryImportSessionResult = typeof AcpRegistryImportSessionResult.Type;

export const AcpRegistryDeleteSessionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  sessionId: AcpRegistrySessionId,
});
export type AcpRegistryDeleteSessionInput = typeof AcpRegistryDeleteSessionInput.Type;

export const AcpRegistryDeleteSessionResult = Schema.Struct({ deleted: Schema.Literal(true) });
export type AcpRegistryDeleteSessionResult = typeof AcpRegistryDeleteSessionResult.Type;

const AcpRegistryProviderId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const AcpRegistryProviderProtocol = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const AcpRegistryConfigurableProvider = Schema.Struct({
  providerId: AcpRegistryProviderId,
  supported: Schema.Array(AcpRegistryProviderProtocol).check(Schema.isMaxLength(16)),
  required: Schema.Boolean,
  current: Schema.NullOr(
    Schema.Struct({
      apiType: AcpRegistryProviderProtocol,
      baseUrl: AcpRegistryUrl,
    }),
  ),
});
export type AcpRegistryConfigurableProvider = typeof AcpRegistryConfigurableProvider.Type;

export const AcpRegistryListProvidersInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
});
export type AcpRegistryListProvidersInput = typeof AcpRegistryListProvidersInput.Type;

export const AcpRegistryListProvidersResult = Schema.Struct({
  providers: Schema.Array(AcpRegistryConfigurableProvider).check(Schema.isMaxLength(64)),
});
export type AcpRegistryListProvidersResult = typeof AcpRegistryListProvidersResult.Type;

export const AcpRegistrySetProviderInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  providerId: AcpRegistryProviderId,
  apiType: AcpRegistryProviderProtocol,
  baseUrl: AcpRegistryUrl,
  // Write-only secrets. Provider list responses intentionally cannot carry headers.
  headers: Schema.optionalKey(
    Schema.Record(
      TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
      Schema.String.check(Schema.isMaxLength(8_192)),
    ),
  ),
});
export type AcpRegistrySetProviderInput = typeof AcpRegistrySetProviderInput.Type;

export const AcpRegistrySetProviderResult = Schema.Struct({ configured: Schema.Literal(true) });
export type AcpRegistrySetProviderResult = typeof AcpRegistrySetProviderResult.Type;

export const AcpRegistryDisableProviderInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  providerId: AcpRegistryProviderId,
});
export type AcpRegistryDisableProviderInput = typeof AcpRegistryDisableProviderInput.Type;

export const AcpRegistryDisableProviderResult = Schema.Struct({ disabled: Schema.Literal(true) });
export type AcpRegistryDisableProviderResult = typeof AcpRegistryDisableProviderResult.Type;

export const AcpRegistryLogoutInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type AcpRegistryLogoutInput = typeof AcpRegistryLogoutInput.Type;

export const AcpRegistryLogoutResult = Schema.Struct({
  loggedOut: Schema.Literal(true),
});
export type AcpRegistryLogoutResult = typeof AcpRegistryLogoutResult.Type;

export const AcpRegistryProbeModel = Schema.Struct({
  id: AcpRegistryProbeText,
  name: AcpRegistryProbeText,
  description: AcpRegistryProbeDescription,
});
export type AcpRegistryProbeModel = typeof AcpRegistryProbeModel.Type;

export const AcpRegistryProbeResult = Schema.Struct({
  instanceId: ProviderInstanceId,
  // `ready` is only returned after a disposable ACP session/new probe completes.
  // It does not imply that authentication was passively detected.
  ready: Schema.Literal(true),
  icon: Schema.NullOr(AcpRegistryUrl),
  authMethods: Schema.Array(AcpRegistryProbeAuthMethod).check(Schema.isMaxLength(32)),
  models: Schema.Array(AcpRegistryProbeModel).check(Schema.isMaxLength(256)),
  currentModelId: Schema.NullOr(AcpRegistryProbeText),
  // Non-model session config options and session modes, pre-mapped onto Studio's
  // provider option descriptors so model capabilities can carry them directly.
  configOptions: Schema.Array(ProviderOptionDescriptor).check(Schema.isMaxLength(16)),
  sessionManagement: Schema.Struct({
    canList: Schema.Boolean,
    canLoad: Schema.Boolean,
    canResume: Schema.Boolean,
    canLogout: Schema.Boolean,
    canDelete: Schema.Boolean,
    canConfigureProviders: Schema.Boolean,
  }).pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        canList: false,
        canLoad: false,
        canResume: false,
        canLogout: false,
        canDelete: false,
        canConfigureProviders: false,
      }),
    ),
  ),
});
export type AcpRegistryProbeResult = typeof AcpRegistryProbeResult.Type;

export const AcpRegistryOperationErrorReason = Schema.Literals([
  "agent_not_configured",
  "agent_not_found",
  "archive_invalid",
  "authentication_failed",
  "checksum_mismatch",
  "download_failed",
  "install_failed",
  "instance_not_found",
  "logout_unsupported",
  "logout_failed",
  "probe_failed",
  "project_not_found",
  "registry_unavailable",
  "runner_unavailable",
  "session_import_failed",
  "session_delete_unsupported",
  "session_delete_failed",
  "session_list_unsupported",
  "session_resume_unsupported",
  "providers_unsupported",
  "providers_list_failed",
  "provider_configuration_failed",
  "unsupported_distribution",
  "unsupported_platform",
]);
export type AcpRegistryOperationErrorReason = typeof AcpRegistryOperationErrorReason.Type;

export class AcpRegistryOperationError extends Schema.TaggedError<AcpRegistryOperationError>()(
  "AcpRegistryOperationError",
  {
    reason: AcpRegistryOperationErrorReason,
    message: Schema.String,
    authMethods: Schema.optionalKey(
      Schema.Array(AcpRegistryProbeAuthMethod).check(Schema.isMaxLength(32)),
    ),
    authAction: Schema.optionalKey(AcpRegistryUrlAuthAction),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}
