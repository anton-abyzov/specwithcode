import {
  AcpRegistrySettings,
  gitHubCopilotIconUrlForInstanceConfig,
  isGitHubCopilotIcon,
  officialAcpRegistryIconUrlForAgentId,
  ProviderDriverKind,
  ProviderSetupError,
  resolveOfficialAcpRegistryIconUrl,
  TextGenerationError,
  AcpRegistryOperationError,
  type CustomModelSetting,
  type ServerProvider,
  type ServerProviderModel,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import { createModelCapabilities } from "@specweave-studio/shared/model";
import { compareSemverVersions } from "@specweave-studio/shared/semver";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import type * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import {
  AcpRegistryAdapterV2Driver,
  type AcpRegistryAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/AcpRegistryAdapterV2.ts";
import * as ServerSettings from "../../serverSettings.ts";
import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  COPILOT_USAGE_AGENT_ID,
  type CachedCopilotUsage,
  type CopilotUsageReading,
  makeCachedCopilotUsageLimits,
  readCopilotSignedInLogin,
  readCopilotUsage,
  readCopilotAccountStamp,
  resolveCopilotHome,
} from "../copilotUsageLimits.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { providerModelsFromSettings } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import {
  type AcpRegistryAvailableCommands,
  type AcpRegistryConfigurationProbe,
  type AcpRegistryConfigurationProbeResult,
  type AcpRegistryLiveConfiguration,
  deleteAcpRegistrySession,
  disableAcpRegistryProvider,
  listAcpRegistrySessions,
  listAcpRegistryProviders,
  logoutAcpRegistry,
  probeAcpRegistryConfiguration,
  setAcpRegistryProvider,
} from "../acp/AcpRegistryProbe.ts";
import * as AcpRegistrySupport from "../acp/AcpRegistrySupport.ts";
import {
  teamRulesDriverRefusal,
  teamRulesOwnsProviderLaunch,
  teamRulesSetByLabel,
} from "@specweave-studio/shared/teamRules";
import { currentTeamRules } from "../../teamRules/TeamRules.ts";
import * as AcpRegistryRuntimeCoordinator from "../acp/AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistryAuth from "../acp/AcpRegistryAuth.ts";
import * as AcpRegistryAuthenticationState from "../acp/AcpRegistryAuthenticationState.ts";

const DRIVER_KIND = ProviderDriverKind.make("acpRegistry");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
// How long a successful discovery probe stays valid. Periodic health
// refreshes reuse it instead of spawning a fresh disposable ACP session;
// failed or unauthenticated probes are never cached so a completed sign-in
// is detected on the next refresh.
const PROBE_SUCCESS_TTL_MS = 15 * 60 * 1_000;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const makeUnsupportedTextGeneration = (): TextGeneration["Service"] => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "ACP Registry instances do not provide application text generation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
};

/**
 * Models an agent accepts through `session/set_model` but leaves out of its
 * catalog. Gemini CLI 0.63.0 lists no Gemini 4 Argon, yet runs it on Vertex AI
 * and paid Gemini API keys (verified with a coding turn whose `model_usage`
 * named gemini-4-argon). Free Google sign-ins have no Argon access; the agent
 * then fails the turn with its own error.
 */
const UNLISTED_AGENT_MODELS: Readonly<
  Record<string, ReadonlyArray<{ readonly id: string; readonly name: string }>>
> = {
  gemini: [{ id: "gemini-4-argon", name: "Gemini 4 Argon" }],
};

function modelsFromDiscovery(
  discovery:
    | Pick<AcpRegistryLiveConfiguration, "models" | "currentModelId" | "configOptions">
    | undefined,
  customModels: ReadonlyArray<CustomModelSetting>,
  agentId: string,
): ReadonlyArray<ServerProviderModel> {
  const listed = discovery?.models ?? [];
  const unlisted = (UNLISTED_AGENT_MODELS[agentId] ?? []).filter(
    (model) => !listed.some((candidate) => candidate.id === model.id),
  );
  // Only a probed catalog proves the agent runs; before that the picker keeps "Default".
  const discovered =
    listed.length === 0
      ? listed
      : [...listed, ...unlisted.map((model) => ({ ...model, description: null }))];
  // Discovered session config options and modes ride on every model so the
  // composer's generic option controls can drive them per thread.
  const capabilities =
    discovery === undefined || discovery.configOptions.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors: discovery.configOptions });
  const builtInModels: ReadonlyArray<ServerProviderModel> =
    discovered.length === 0
      ? [
          {
            slug: "default",
            name: "Default",
            isCustom: false,
            isDefault: true,
            capabilities,
          },
        ]
      : discovered.map((model) => ({
          slug: model.id,
          name: model.name,
          isCustom: false,
          ...(model.id === discovery?.currentModelId ? { isDefault: true } : {}),
          capabilities,
        }));
  return providerModelsFromSettings(builtInModels, customModels, capabilities);
}

/**
 * The note on an agent that runs its prepared version while the registry
 * lists another. A registry that rolled back lists an older one, and
 * "update" would then downgrade it, so that case only says what is listed.
 */
function retainedVersionMessage(
  inspection: {
    readonly agentId: string;
    readonly agentName?: string;
    readonly version: string | null;
  },
  availableVersion: string,
): string {
  const name = inspection.agentName ?? inspection.agentId;
  const running = `${name} ${inspection.version ?? ""}`.trimEnd();
  return inspection.version !== null &&
    compareSemverVersions(availableVersion, inspection.version) < 0
    ? `${running} is running; the ACP Registry lists ${availableVersion}.`
    : `${running} is running; ${availableVersion} is available. Use Install / update agent in Settings → Providers.`;
}

/**
 * Stores an API key accepted at sign-in as a secret environment variable on
 * this instance, so later sessions on this machine read it. The settings
 * service moves sensitive values into the machine's secret store.
 */
export const saveAcpRegistryCredential = (
  serverSettings: ServerSettings.ServerSettingsService["Service"],
  instanceId: ProviderInstance["instanceId"],
  credential: AcpRegistryAuth.AcpRegistryCredential,
): Effect.Effect<void, ProviderSetupError> => {
  const saveFailed = new ProviderSetupError({
    instanceId,
    operation: "save",
    detail: credential.keepEnvironment
      ? `Signed in with the ${credential.envName} already set on this machine, but the sign-in method could not be saved. Sign in again so later sessions use it.`
      : "The API key worked but could not be saved on this machine. The agent here now expects an API key: sign in again to save it, or choose another sign-in method.",
  });
  return Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const instance = settings.providerInstances[instanceId];
    if (!instance) return yield* saveFailed;
    const config =
      instance.config !== null && typeof instance.config === "object"
        ? (instance.config as Record<string, unknown>)
        : {};
    yield* serverSettings.updateProviderInstance({
      operation: "upsert",
      instanceId,
      instance: {
        ...instance,
        environment: credential.keepEnvironment
          ? (instance.environment ?? [])
          : [
              ...(instance.environment ?? []).filter(
                (variable) => variable.name !== credential.envName,
              ),
              { name: credential.envName, value: credential.value, sensitive: true },
            ],
        config: { ...config, authMethodId: credential.authMethodId },
      },
    });
    // Settings errors can carry the written snapshot, so the cause is dropped.
  }).pipe(Effect.mapError(() => saveFailed));
};

export function acpRegistrySnapshotReadiness(
  inspection:
    | AcpRegistrySupport.AcpRegistryInspection
    | { readonly status: "failed"; readonly message: string },
): Pick<ServerProvider, "installed" | "version" | "status" | "message"> {
  switch (inspection.status) {
    case "ready":
      return {
        installed: true,
        version: inspection.version,
        status: "ready",
        // The prepared install keeps running; the registry update is opt-in.
        ...(inspection.availableVersion !== undefined
          ? { message: retainedVersionMessage(inspection, inspection.availableVersion) }
          : {}),
      };
    case "unconfigured":
      return {
        installed: false,
        version: null,
        status: "warning",
        message:
          "Select an ACP Registry agent or configure a local ACP executable before starting a thread.",
      };
    case "not_found":
      return {
        installed: false,
        version: null,
        status: "error",
        message: `ACP Registry does not contain agent '${inspection.agentId}'.`,
      };
    case "unsupported":
      return {
        installed: false,
        version: inspection.version,
        status: "error",
        message: `ACP Registry agent '${inspection.agentId}' has no compatible distribution for this environment.`,
      };
    case "missing_runner":
      return {
        installed: false,
        version: inspection.version,
        status: "error",
        message:
          inspection.distribution === "local"
            ? "Local ACP executable is not available on this environment's PATH."
            : `ACP executable '${inspection.runner}' is not available on this environment's PATH.`,
      };
    case "unprepared":
      return {
        installed: false,
        version: inspection.version,
        status: "warning",
        message: `ACP Registry agent '${inspection.agentId}' has not been prepared on this environment.`,
      };
    case "failed":
      return {
        installed: false,
        version: null,
        status: "error",
        message: inspection.message,
      };
  }
}

interface SnapshotIdentity {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationKey: string;
}

function baseSnapshot(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly checkedAt: string;
    readonly installed: boolean;
    readonly version: string | null;
    readonly status: ServerProvider["status"];
    readonly auth: ServerProvider["auth"];
    readonly documentationUrl?: string;
    readonly message?: string;
    readonly probe?: AcpRegistryConfigurationProbeResult;
    readonly probeError?: AcpRegistryOperationError;
  },
): ServerProvider {
  // Copilot branding carries subscription identity in automatic routing.
  // An agent's self-reported icon must not grant that identity.
  const probeIcon = resolveOfficialAcpRegistryIconUrl(input.probe?.probe.icon);
  const iconUrl =
    gitHubCopilotIconUrlForInstanceConfig(input.settings) ??
    (input.settings.source === "local"
      ? null
      : ((isGitHubCopilotIcon(null, probeIcon) ? null : probeIcon) ??
        officialAcpRegistryIconUrlForAgentId(input.settings.agentId)));
  return {
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    continuation: { groupKey: input.continuationKey },
    // The registry driver rejects every application text-generation operation,
    // so selectors must not offer these instances for commit, PR, branch, or
    // title generation.
    supportsTextGeneration: false,
    enabled: input.settings.enabled,
    installed: input.installed,
    version: input.version,
    status: input.settings.enabled ? input.status : "disabled",
    auth: { ...input.auth, canLogout: input.auth.canLogout ?? false },
    checkedAt: input.checkedAt,
    setup: {
      canInstall: false,
      ...(input.documentationUrl ? { documentationUrl: input.documentationUrl } : {}),
      canAuthenticate:
        input.installed &&
        (input.probe
          ? input.probe.probe.authMethods.length > 0
          : input.settings.source === "local"
            ? (input.probeError?.authMethods?.length ?? 0) > 0
            : input.settings.agentId.length > 0),
    },
    ...(input.message ? { message: input.message } : {}),
    models: modelsFromDiscovery(
      input.probe?.probe,
      input.settings.customModels,
      input.settings.agentId,
    ),
    ...(input.probe === undefined
      ? {}
      : {
          nativeSessions: {
            canList: input.probe.probe.sessionManagement.canList,
            canLoad: input.probe.probe.sessionManagement.canLoad,
            canResume: input.probe.probe.sessionManagement.canResume,
            canDelete: input.probe.probe.sessionManagement.canDelete,
          },
          configurableProviders: input.probe.probe.sessionManagement.canConfigureProviders,
        }),
    slashCommands: input.probe?.slashCommands ?? [],
    skills: input.probe?.skills ?? [],
  };
}

export function applyAcpRegistryAvailableCommands(
  provider: ServerProvider,
  commands: Option.Option<AcpRegistryAvailableCommands>,
): ServerProvider {
  return Option.match(commands, {
    onNone: () => provider,
    onSome: ({ slashCommands, skills }) => ({ ...provider, slashCommands, skills }),
  });
}

export function applyAcpRegistryLiveConfiguration(
  provider: ServerProvider,
  configuration: AcpRegistryLiveConfiguration,
  settings: Pick<AcpRegistrySettings, "customModels" | "agentId">,
): ServerProvider {
  const { message: _staleProbeMessage, ...snapshot } = provider;
  return {
    ...snapshot,
    status: provider.enabled ? "ready" : provider.status,
    models: modelsFromDiscovery(configuration, settings.customModels, settings.agentId),
  };
}

function applyAcpRegistryUrlAuthAction(
  provider: ServerProvider,
  action: Option.Option<NonNullable<ServerProvider["auth"]["action"]>>,
): ServerProvider {
  const { action: _previousAction, ...auth } = provider.auth;
  return {
    ...provider,
    auth: Option.match(action, {
      onNone: () => auth,
      onSome: (nextAction) => ({ ...auth, action: nextAction }),
    }),
  };
}

const buildInitialAcpRegistrySnapshot = Effect.fn("AcpRegistryDriver.buildInitialSnapshot")(
  function* (input: SnapshotIdentity & { readonly settings: AcpRegistrySettings }) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return baseSnapshot({
      ...input,
      checkedAt,
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: input.settings.enabled
        ? "Checking ACP Registry agent readiness..."
        : "ACP Registry is disabled in SpecWithCode settings.",
    });
  },
);

export function buildCheckedAcpRegistrySnapshot(
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly checkedAt: string;
    readonly inspection:
      | AcpRegistrySupport.AcpRegistryInspection
      | { readonly status: "failed"; readonly message: string };
    readonly probe?: AcpRegistryConfigurationProbeResult;
    readonly probeError?: AcpRegistryOperationError;
  },
): ServerProvider {
  const readiness = acpRegistrySnapshotReadiness(input.inspection);
  const probeFailed = input.probeError !== undefined;
  const advertisedAuthMethod =
    input.probeError?.reason === "authentication_failed"
      ? (input.probeError.authMethods?.find(
          (method) => method.id === input.settings.authMethodId,
        ) ?? input.probeError.authMethods?.[0])
      : undefined;
  const authenticationMessage = advertisedAuthMethod
    ? advertisedAuthMethod.type === "terminal" && advertisedAuthMethod.command
      ? `Sign in in provider settings using "${advertisedAuthMethod.name}". The login terminal runs on this environment.`
      : advertisedAuthMethod.type === "env_var" &&
          (advertisedAuthMethod.envVarNames?.length ?? 0) > 0
        ? `Set ${advertisedAuthMethod.envVarNames!.join(", ")} under this instance's environment variables in provider settings. SpecWithCode will detect it on the next provider refresh.`
        : `Sign in in provider settings using "${advertisedAuthMethod.name}".`
    : undefined;
  return baseSnapshot({
    ...input,
    ...(input.inspection.status === "ready" && input.inspection.documentationUrl
      ? { documentationUrl: input.inspection.documentationUrl }
      : {}),
    installed: readiness.installed,
    version: readiness.version,
    // A failed discovery probe on a ready installation is a warning, not an
    // outage: the agent binary is present and a real turn may still work
    // (for example after the user completes authentication).
    status: probeFailed ? "warning" : readiness.status,
    auth: input.probe
      ? {
          // Discovery sessions and an empty auth-method list do not prove sign-in.
          status: "unknown",
          canLogout: input.probe.probe.sessionManagement.canLogout,
          // The configured sign-in says how turns are billed: Gemini's
          // "vertex-ai" bills a Google Cloud project per token.
          ...(input.settings.authMethodId ? { type: input.settings.authMethodId } : {}),
        }
      : input.probeError?.reason === "authentication_failed"
        ? {
            status: "unauthenticated",
            ...(advertisedAuthMethod
              ? { type: advertisedAuthMethod.type, label: advertisedAuthMethod.name }
              : {}),
            ...(input.probeError.authAction === undefined
              ? {}
              : { action: input.probeError.authAction }),
          }
        : { status: "unknown" },
    ...(input.probeError
      ? { message: authenticationMessage ?? input.probeError.message }
      : readiness.message
        ? { message: readiness.message }
        : {}),
  });
}

export const checkAcpRegistryProviderStatus = Effect.fn("AcpRegistryDriver.checkProviderStatus")(
  function* <Requirements>(
    input: SnapshotIdentity & {
      readonly settings: AcpRegistrySettings;
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    },
    probeConfiguration: AcpRegistryConfigurationProbe<Requirements>,
  ): Effect.fn.Return<ServerProvider, never, AcpRegistrySupport.AcpRegistryCatalog | Requirements> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!input.settings.enabled) {
      return yield* buildInitialAcpRegistrySnapshot(input);
    }
    const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
    const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
    if (Result.isFailure(inspected)) {
      return buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: {
          status: "failed",
          message: `Could not inspect ACP Registry agent: ${inspected.failure.message}`,
        },
      });
    }
    if (inspected.success.status !== "ready") {
      return buildCheckedAcpRegistrySnapshot({
        ...input,
        checkedAt,
        inspection: inspected.success,
      });
    }
    const probed = yield* Effect.result(
      probeConfiguration({
        instanceId: input.instanceId,
        settings: input.settings,
        cwd: input.cwd,
        environment: input.environment,
      }),
    );
    return Result.isFailure(probed)
      ? buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probeError: probed.failure,
        })
      : buildCheckedAcpRegistrySnapshot({
          ...input,
          checkedAt,
          inspection: inspected.success,
          probe: probed.success,
        });
  },
);

/**
 * The readiness placeholder published before each background probe keeps a
 * sign-out the last probe found, so a signed-out agent never reads as ready
 * with an unknown sign-in while its next probe runs.
 */
export function withLastProbedSignOut(
  placeholder: ServerProvider,
  lastProbedAuth: ServerProvider["auth"]["status"] | null,
): ServerProvider {
  return placeholder.auth.status === "unknown" && lastProbedAuth === "unauthenticated"
    ? { ...placeholder, auth: { ...placeholder.auth, status: "unauthenticated" } }
    : placeholder;
}

/**
 * Shows the account a Copilot instance is signed in as. A signed-out
 * instance shows none, even when its CLI still remembers the last login.
 */
export function withCopilotLogin(
  provider: ServerProvider,
  login: string | undefined,
): ServerProvider {
  const trimmed = login?.trim();
  if (trimmed && provider.auth.status !== "unauthenticated") {
    return provider.auth.login === trimmed
      ? provider
      : { ...provider, auth: { ...provider.auth, login: trimmed } };
  }
  if (provider.auth.login === undefined) return provider;
  const { login: _login, ...auth } = provider.auth;
  return { ...provider, auth };
}

/**
 * Picks the Copilot login to show after a usage read. The login in the
 * CLI's config.json wins, because the usage read may be cached from before
 * the user switched accounts. Without one, the read's login is used, then
 * the last known one.
 */
export function resolveCopilotLogin(input: {
  readonly configLogin: string | undefined;
  readonly readingLogin: string | undefined;
  readonly known: string | undefined;
}): string | undefined {
  return input.configLogin ?? input.readingLogin ?? input.known;
}

/** How long a status check waits on a Copilot usage read before it moves on. */
export const COPILOT_USAGE_CHECK_BUDGET = "6 seconds";

/**
 * The cache key of a Copilot usage reading: the CLI's sign-in folder, the
 * login it last signed in as and a stamp of gh's sign-in. A switch to another
 * account, in the CLI or through gh, changes the key, so the previous
 * account's quota and subscription are never shown for it.
 */
export function copilotUsageCacheKey(input: {
  readonly copilotHome: string;
  readonly login: string | undefined;
  /** Changes when gh's sign-in changes (see `readCopilotAccountStamp`). */
  readonly accountStamp?: string | undefined;
}): string {
  return JSON.stringify([
    input.copilotHome,
    input.login?.trim().toLowerCase() ?? null,
    input.accountStamp ?? null,
  ]);
}

/**
 * Adds a Copilot instance's usage to its status. The reading is keyed by the
 * account the CLI signs in as, so a new sign-in or another COPILOT_HOME
 * reads afresh. The check waits at most `budget`; a slower read keeps
 * running and fills the cache for the next check, and until then the last
 * good bars stay (a probeFailed reading keeps them).
 */
export const withCopilotUsage = <R>(input: {
  readonly provider: ServerProvider;
  readonly cache: CachedCopilotUsage<CopilotUsageReading, R>;
  readonly copilotHome: string;
  /** The login in the CLI's config.json on this status check, if any. */
  readonly configLogin: Ref.Ref<string | undefined>;
  /** The login shown for the instance. */
  readonly login: Ref.Ref<string | undefined>;
  /** gh's sign-in stamp on this status check, if read. */
  readonly accountStamp?: Ref.Ref<string | undefined>;
  readonly budget?: Duration.Input;
}): Effect.Effect<ServerProvider, never, R> =>
  Effect.gen(function* () {
    const { provider } = input;
    if (!provider.enabled || !provider.installed || provider.auth.status === "unauthenticated") {
      return provider;
    }
    const configLogin = yield* Ref.get(input.configLogin);
    const accountStamp =
      input.accountStamp === undefined ? undefined : yield* Ref.get(input.accountStamp);
    const reading = yield* input.cache
      .get(
        copilotUsageCacheKey({ copilotHome: input.copilotHome, login: configLogin, accountStamp }),
      )
      .pipe(Effect.timeoutOption(input.budget ?? COPILOT_USAGE_CHECK_BUDGET));
    let usageLimits: ServerProvider["usageLimits"];
    if (Option.isSome(reading)) {
      yield* Ref.update(input.login, (known) =>
        resolveCopilotLogin({ configLogin, readingLogin: reading.value.login, known }),
      );
      usageLimits = reading.value.limits;
    } else {
      usageLimits = {
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        windows: [],
        unavailable: { reason: "probeFailed" },
      };
    }
    return withCopilotLogin({ ...provider, usageLimits }, yield* Ref.get(input.login));
  });

/**
 * What an explicit fresh refresh clears: the Copilot usage reading and the
 * agent probe (sign-in, models, commands), so a retry reads both again.
 */
export const invalidateAcpRegistryCaches = (input: {
  readonly copilotUsage: Effect.Effect<void>;
  readonly enrichment: Effect.Effect<void>;
}): Effect.Effect<void> => input.copilotUsage.pipe(Effect.andThen(input.enrichment));

/** Publishes local executable readiness without starting an ACP process. */
export const checkAcpRegistryProviderReadiness = Effect.fn(
  "AcpRegistryDriver.checkProviderReadiness",
)(function* (
  input: SnapshotIdentity & {
    readonly settings: AcpRegistrySettings;
    readonly environment: NodeJS.ProcessEnv;
  },
): Effect.fn.Return<ServerProvider, never, AcpRegistrySupport.AcpRegistryCatalog> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!input.settings.enabled) {
    return yield* buildInitialAcpRegistrySnapshot(input);
  }
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
  const snapshot = buildCheckedAcpRegistrySnapshot({
    ...input,
    checkedAt,
    inspection: Result.isFailure(inspected)
      ? {
          status: "failed",
          message: `Could not inspect ACP Registry agent: ${inspected.failure.message}`,
        }
      : inspected.success,
  });
  return inspected._tag === "Success" && inspected.success.status === "ready"
    ? {
        ...snapshot,
        message: "Checking ACP authentication, models, and commands in the background...",
      }
    : snapshot;
});

export type AcpRegistryDriverEnv =
  | AcpRegistryAdapterV2DriverEnv
  | HttpClient.HttpClient
  | BackgroundPolicy.BackgroundPolicy
  | ServerSettings.ServerSettingsService;

/** Canonical provider-instance wrapper for ACP Registry orchestration adapters. */
export const AcpRegistryDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "ACP Registry",
    supportsMultipleInstances: true,
  },
  configSchema: AcpRegistrySettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      const runtimeCoordinator = yield* Effect.serviceOption(
        AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
      );
      if (Option.isSome(runtimeCoordinator)) {
        yield* runtimeCoordinator.value.clearAvailableCommands(instanceId);
        yield* runtimeCoordinator.value.clearLiveConfiguration(instanceId);
        yield* Effect.addFinalizer(() =>
          runtimeCoordinator.value
            .clearAvailableCommands(instanceId)
            .pipe(Effect.andThen(runtimeCoordinator.value.clearLiveConfiguration(instanceId))),
        );
      }
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const hostEnvironment = yield* HostProcessEnvironment;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const identity = {
        instanceId,
        displayName,
        accentColor,
        continuationKey: continuationIdentity.continuationKey,
      };
      const effectiveConfig = { ...config, enabled } satisfies AcpRegistrySettings;
      const processEnvironment = mergeProviderInstanceEnvironment(environment, hostEnvironment);
      const orchestrationAdapter = yield* AcpRegistryAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build ACP Registry orchestration adapter.",
              cause,
            }),
        ),
      );
      const readinessInput = {
        ...identity,
        settings: effectiveConfig,
        environment: processEnvironment,
      };
      const confirmedAuthentication =
        yield* AcpRegistryAuthenticationState.makeAcpRegistryAuthenticationState({
          cacheDir: serverConfig.providerStatusCacheDir,
          instanceId,
          settings: effectiveConfig,
          environment,
          processEnvironment,
        });
      const isCopilotInstance =
        effectiveConfig.source !== "local" && effectiveConfig.agentId === COPILOT_USAGE_AGENT_ID;
      const copilotUsageInput = {
        instanceEnvironment: Object.fromEntries(
          (environment ?? []).map((variable) => [variable.name, variable.value]),
        ),
        processEnvironment,
      };
      // The GitHub account this Copilot instance's CLI is signed in as.
      const copilotLogin = yield* Ref.make<string | undefined>(undefined);
      // The login read from config.json on the latest status check, if any.
      const copilotConfigLogin = yield* Ref.make<string | undefined>(undefined);
      // gh's sign-in stamp on the latest status check, so a gh account switch reads afresh.
      const copilotAccountStamp = yield* Ref.make<string | undefined>(undefined);
      const refreshCopilotLogin = isCopilotInstance
        ? readCopilotSignedInLogin(copilotUsageInput).pipe(
            Effect.tap(() =>
              readCopilotAccountStamp(copilotUsageInput).pipe(
                Effect.flatMap((stamp) => Ref.set(copilotAccountStamp, stamp)),
              ),
            ),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.flatMap((signedIn) =>
              // A token in the environment decides the account; the usage
              // read reports its login.
              signedIn.fromEnvironmentToken
                ? Ref.set(copilotConfigLogin, undefined)
                : Ref.set(copilotConfigLogin, signedIn.login).pipe(
                    Effect.andThen(Ref.set(copilotLogin, signedIn.login)),
                  ),
            ),
          )
        : Effect.void;
      const withLiveRuntimeState = (input: ServerProvider) =>
        Effect.gen(function* () {
          if (input.auth.status === "unauthenticated") yield* confirmedAuthentication.set(false);
          const confirmed =
            input.enabled &&
            input.installed &&
            input.auth.status === "unknown" &&
            (yield* confirmedAuthentication.get)
              ? { ...input, auth: { ...input.auth, status: "authenticated" as const } }
              : input;
          const provider = isCopilotInstance
            ? withCopilotLogin(confirmed, yield* Ref.get(copilotLogin))
            : confirmed;
          return yield* Option.isNone(runtimeCoordinator)
            ? Effect.succeed(provider)
            : Effect.all({
                commands: runtimeCoordinator.value.getAvailableCommands(instanceId),
                configuration: runtimeCoordinator.value.getLiveConfiguration(instanceId),
                authAction: runtimeCoordinator.value.getUrlAuthAction(instanceId),
              }).pipe(
                Effect.map(({ commands, configuration, authAction }) => {
                  const withCommands = applyAcpRegistryAvailableCommands(provider, commands);
                  const withConfiguration = Option.match(configuration, {
                    onNone: () => withCommands,
                    onSome: (liveConfiguration) =>
                      applyAcpRegistryLiveConfiguration(
                        withCommands,
                        liveConfiguration,
                        effectiveConfig,
                      ),
                  });
                  return applyAcpRegistryUrlAuthAction(withConfiguration, authAction);
                }),
              );
        });
      const lastProbedAuth = yield* Ref.make<ServerProvider["auth"]["status"] | null>(null);
      const checkProvider = refreshCopilotLogin.pipe(
        Effect.andThen(checkAcpRegistryProviderReadiness(readinessInput)),
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.flatMap(withLiveRuntimeState),
        Effect.flatMap((provider) =>
          Ref.get(lastProbedAuth).pipe(Effect.map((auth) => withLastProbedSignOut(provider, auth))),
        ),
      );
      // Copilot's ACP agent reports no quota; read it from GitHub on each
      // status check, reusing a read for a few minutes. A failed read never
      // fails the check.
      const httpClient = yield* HttpClient.HttpClient;
      const cachedCopilotUsage = isCopilotInstance
        ? yield* makeCachedCopilotUsageLimits(
            readCopilotUsage(copilotUsageInput).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          )
        : undefined;
      const copilotHome = isCopilotInstance ? resolveCopilotHome(copilotUsageInput, path) : "";
      const invalidateCopilotUsage = cachedCopilotUsage?.invalidate ?? Effect.void;
      const checkProviderWithUsage =
        cachedCopilotUsage === undefined
          ? checkProvider
          : checkProvider.pipe(
              Effect.flatMap((provider) =>
                withCopilotUsage({
                  provider,
                  cache: cachedCopilotUsage,
                  copilotHome,
                  configLogin: copilotConfigLogin,
                  login: copilotLogin,
                  accountStamp: copilotAccountStamp,
                }),
              ),
            );
      const enrichProvider = checkAcpRegistryProviderStatus(
        {
          ...readinessInput,
          cwd: serverConfig.cwd,
        },
        probeAcpRegistryConfiguration,
      ).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      const enrichmentCache = yield* Ref.make<{
        readonly generation: number;
        readonly entry: {
          readonly provider: ServerProvider;
          readonly expiresAt: number;
        } | null;
      }>({ generation: 0, entry: null });
      const liveSnapshotSemaphore = yield* Semaphore.make(1);
      const invalidateEnrichmentCache = Ref.update(enrichmentCache, (current) => ({
        generation: current.generation + 1,
        entry: null,
      }));
      const enrichProviderCached = (baseSnapshot: ServerProvider) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const cacheState = yield* Ref.get(enrichmentCache);
          const cached = cacheState.entry;
          if (
            cached !== null &&
            cached.expiresAt > now &&
            cached.provider.version === baseSnapshot.version
          ) {
            return {
              provider: { ...cached.provider, checkedAt: baseSnapshot.checkedAt },
              generation: cacheState.generation,
            };
          }
          const enriched = yield* enrichProvider;
          if (enriched.status === "ready") {
            yield* Ref.update(enrichmentCache, (current) =>
              current.generation === cacheState.generation
                ? {
                    ...current,
                    entry: {
                      provider: enriched,
                      expiresAt: now + PROBE_SUCCESS_TTL_MS,
                    },
                  }
                : current,
            );
          }
          return { provider: enriched, generation: cacheState.generation };
        });
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<AcpRegistrySettings>
      >({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => checkProvider,
        checkProvider: checkProviderWithUsage,
        enrichSnapshot: (input) =>
          Effect.flatMap(currentTeamRules, (rules) => {
            // The probe starts the agent, and a hold must not revive one the rules blocked.
            if (teamRulesDriverRefusal(rules, "acpRegistry") !== null) return Effect.void;
            const { snapshot, getSnapshot, publishSnapshot } = input;
            if (!snapshot.installed) return Effect.void;
            const publishEnrichment = (
              Option.isSome(runtimeCoordinator)
                ? runtimeCoordinator.value.runBackgroundProbe(
                    effectiveConfig.source === "local"
                      ? `local:${instanceId}`
                      : effectiveConfig.agentId,
                    enrichProviderCached(snapshot),
                  )
                : enrichProviderCached(snapshot).pipe(Effect.map(Option.some))
            ).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: ({ provider, generation }) =>
                    liveSnapshotSemaphore.withPermit(
                      Ref.get(enrichmentCache).pipe(
                        Effect.flatMap((current) =>
                          current.generation === generation
                            ? Ref.set(lastProbedAuth, provider.auth.status).pipe(
                                Effect.andThen(withLiveRuntimeState(provider)),
                                Effect.flatMap(publishSnapshot),
                              )
                            : Effect.void,
                        ),
                      ),
                    ),
                }),
              ),
            );
            if (Option.isNone(runtimeCoordinator)) return publishEnrichment;

            const publishLiveCommands = runtimeCoordinator.value.watchAvailableCommands(
              instanceId,
              ({ slashCommands, skills }) =>
                liveSnapshotSemaphore.withPermit(
                  getSnapshot.pipe(
                    Effect.flatMap((current) =>
                      publishSnapshot({
                        ...current,
                        slashCommands,
                        skills,
                      }),
                    ),
                  ),
                ),
            );
            const publishLiveConfiguration = runtimeCoordinator.value.watchLiveConfiguration(
              instanceId,
              (configuration) =>
                liveSnapshotSemaphore.withPermit(
                  getSnapshot.pipe(
                    Effect.flatMap((current) =>
                      publishSnapshot(
                        applyAcpRegistryLiveConfiguration(current, configuration, effectiveConfig),
                      ),
                    ),
                  ),
                ),
            );
            const publishUrlAuthAction = runtimeCoordinator.value.watchUrlAuthAction(
              instanceId,
              (action) =>
                liveSnapshotSemaphore.withPermit(
                  getSnapshot.pipe(
                    Effect.flatMap((current) =>
                      publishSnapshot(
                        applyAcpRegistryUrlAuthAction(current, Option.fromNullishOr(action)),
                      ),
                    ),
                  ),
                ),
            );
            return Effect.all(
              [
                publishEnrichment,
                publishLiveCommands,
                publishLiveConfiguration,
                publishUrlAuthAction,
              ],
              {
                concurrency: "unbounded",
                discard: true,
              },
            );
          }),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build the ACP Registry provider snapshot.",
              cause,
            }),
        ),
      );

      // Each of these starts the agent, which rules can forbid outright.
      const refuseAcpManagementByTeamRules = Effect.gen(function* () {
        const rules = yield* currentTeamRules;
        const refusal = teamRulesDriverRefusal(rules, "acpRegistry");
        if (refusal !== null) {
          return yield* new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: refusal.message,
          });
        }
      });
      // An endpoint set inside the agent could send work outside the rules' list.
      const refuseAcpEndpointByTeamRules = Effect.gen(function* () {
        const rules = yield* currentTeamRules;
        if (teamRulesOwnsProviderLaunch(rules, "acpRegistry")) {
          return yield* new AcpRegistryOperationError({
            reason: "provider_configuration_failed",
            message: `${teamRulesSetByLabel(rules.status === "active" ? rules.rules.owner : undefined)}: this provider's endpoint comes from the team's rules.`,
          });
        }
      });
      // The management probes read the coordinator via serviceOption, so it is
      // provided only when this driver instance actually has one.
      const provideAcpManagementServices = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | AcpRegistrySupport.AcpRegistryCatalog
          | ChildProcessSpawner.ChildProcessSpawner
          | Crypto.Crypto
        >,
      ): Effect.Effect<A, E | AcpRegistryOperationError> => {
        const provided = refuseAcpManagementByTeamRules.pipe(
          Effect.andThen(effect),
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Crypto.Crypto, crypto),
        );
        return Option.isSome(runtimeCoordinator)
          ? provided.pipe(
              Effect.provideService(
                AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
                runtimeCoordinator.value,
              ),
            )
          : provided;
      };

      const clearLiveState = Option.isSome(runtimeCoordinator)
        ? runtimeCoordinator.value
            .clearLiveConfiguration(instanceId)
            .pipe(Effect.andThen(runtimeCoordinator.value.clearAvailableCommands(instanceId)))
        : Effect.void;
      const controller = yield* AcpRegistryAuth.makeAcpRegistryAuth({
        instanceId,
        settings: effectiveConfig,
        cwd: serverConfig.cwd,
        environment: processEnvironment,
        onChanged: (authenticated) =>
          confirmedAuthentication
            .set(authenticated)
            .pipe(
              Effect.andThen(authenticated ? Effect.void : clearLiveState),
              Effect.andThen(invalidateCopilotUsage),
              Effect.andThen(liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
              Effect.andThen(snapshot.refresh),
              Effect.asVoid,
            ),
        canSaveCredential: serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.providerInstances[instanceId] !== undefined),
          Effect.orElseSucceed(() => false),
        ),
        // The save rebuilds this instance; the note lets the rebuilt one
        // confirm sign-in for the same key.
        saveCredential: (credential) =>
          AcpRegistryAuthenticationState.rememberVerifiedCredential({
            cacheDir: serverConfig.providerStatusCacheDir,
            instanceId,
            authMethodId: credential.authMethodId,
            envName: credential.envName,
            value: credential.value,
          }).pipe(
            Effect.andThen(saveAcpRegistryCredential(serverSettings, instanceId, credential)),
            Effect.tapError(() =>
              AcpRegistryAuthenticationState.forgetVerifiedCredential({
                cacheDir: serverConfig.providerStatusCacheDir,
                instanceId,
              }),
            ),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
      );
      const auth = {
        ...controller,
        invalidate: (controller.invalidate ?? Effect.void).pipe(
          Effect.andThen(confirmedAuthentication.set(false)),
          Effect.andThen(clearLiveState),
          Effect.andThen(invalidateCopilotUsage),
          Effect.andThen(liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache)),
          Effect.andThen(snapshot.refresh),
          Effect.asVoid,
        ),
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        auth,
        // A fresh refresh (a person's retry or refresh) reads usage and the
        // agent's sign-in, models and commands again, past both caches.
        invalidateCaches: invalidateAcpRegistryCaches({
          copilotUsage: invalidateCopilotUsage,
          enrichment: liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache),
        }),
        snapshot: {
          ...snapshot,
          refresh: snapshot.refresh.pipe(
            Effect.tap(() => controller.refreshMethods ?? Effect.void),
          ),
        },
        skillsControl: {
          binaryPath: "",
          environment: processEnvironment,
          agentId: effectiveConfig.agentId,
        },
        orchestrationAdapter,
        textGeneration: makeUnsupportedTextGeneration(),
        acpSessionManagement: {
          listSessions: ({ cwd, cursor }) =>
            provideAcpManagementServices(
              listAcpRegistrySessions({
                instanceId,
                settings: effectiveConfig,
                cwd,
                environment: processEnvironment,
                ...(cursor === undefined ? {} : { cursor }),
              }),
            ),
          deleteSession: ({ cwd, sessionId }) =>
            provideAcpManagementServices(
              deleteAcpRegistrySession({
                instanceId,
                settings: effectiveConfig,
                cwd,
                environment: processEnvironment,
                sessionId,
              }),
            ),
          listProviders: (cwd) =>
            provideAcpManagementServices(
              listAcpRegistryProviders({
                instanceId,
                settings: effectiveConfig,
                cwd,
                environment: processEnvironment,
              }),
            ),
          setProvider: ({ cwd, providerId, apiType, baseUrl, headers }) =>
            refuseAcpEndpointByTeamRules
              .pipe(
                Effect.andThen(
                  provideAcpManagementServices(
                    setAcpRegistryProvider({
                      instanceId,
                      settings: effectiveConfig,
                      cwd,
                      environment: processEnvironment,
                      providerId,
                      apiType,
                      baseUrl,
                      ...(headers === undefined ? {} : { headers }),
                    }),
                  ),
                ),
              )
              .pipe(Effect.tap(() => liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache))),
          disableProvider: ({ cwd, providerId }) =>
            provideAcpManagementServices(
              disableAcpRegistryProvider({
                instanceId,
                settings: effectiveConfig,
                cwd,
                environment: processEnvironment,
                providerId,
              }),
            ).pipe(Effect.tap(() => liveSnapshotSemaphore.withPermit(invalidateEnrichmentCache))),
          logout: (cwd) => {
            const logout = logoutAcpRegistry({
              instanceId,
              settings: effectiveConfig,
              cwd,
              environment: processEnvironment,
            }).pipe(
              Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.tap(() => confirmedAuthentication.set(false)),
              Effect.tap(() => invalidateCopilotUsage),
              Effect.tap(() =>
                liveSnapshotSemaphore.withPermit(
                  invalidateEnrichmentCache.pipe(
                    Effect.andThen(
                      Option.isSome(runtimeCoordinator)
                        ? Effect.all(
                            [
                              runtimeCoordinator.value.clearAvailableCommands(instanceId),
                              runtimeCoordinator.value.clearLiveConfiguration(instanceId),
                            ],
                            { concurrency: "unbounded", discard: true },
                          )
                        : Effect.void,
                    ),
                  ),
                ),
              ),
            );
            return refuseAcpManagementByTeamRules.pipe(
              Effect.andThen(
                Option.isSome(runtimeCoordinator)
                  ? logout.pipe(
                      Effect.provideService(
                        AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
                        runtimeCoordinator.value,
                      ),
                    )
                  : logout,
              ),
            );
          },
        },
      } satisfies ProviderInstance;
    }),
};
