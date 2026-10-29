import * as DateTime from "effect/DateTime";
import { ProviderDriverKind, type ServerProvider } from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { resolveSelfInvocation } from "@specweave-studio/shared/nodeRuntime";
import { ServerConfig } from "../../config.ts";
import { IdAllocatorV2 } from "../../orchestration-v2/IdAllocator.ts";
import {
  makeAcpAdapterV2,
  AcpProviderCapabilitiesV2,
  type AcpAdapterV2Flavor,
} from "../../orchestration-v2/Adapters/AcpAdapterV2.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { ProviderDriverError } from "../Errors.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { MuseSettings } from "@specweave-studio/contracts";
import {
  connectMuse,
  MuseCheckError,
  museCheckFailure,
  museControl,
} from "../muse/MuseConnection.ts";
import {
  museModels,
  museUsage,
  museFullEntitled,
  museUsageFromCliJson,
} from "../muse/MuseDiscovery.ts";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { makeMuseRuntime } from "../muse/MuseRuntime.ts";
import { makeMuseTextGeneration } from "../../textGeneration/MuseTextGeneration.ts";
import { makeMetaTextGeneration, metaApiKey } from "../../textGeneration/MetaTextGeneration.ts";
import type { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";
import { withGitHubSpawnEnvironment } from "../../sourceControl/gitHubSpawnEnvironment.ts";

const driver = ProviderDriverKind.make("muse");

/** How SpecWithCode threads drive Muse; the driver and its adapter tests share it. */
export const museAdapterFlavor = (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv,
): AcpAdapterV2Flavor => ({
  driver,
  runtimeHarness: "Muse Code",
  capabilities: {
    ...AcpProviderCapabilitiesV2,
    sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
    threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: false },
    planning: {
      ...AcpProviderCapabilitiesV2.planning,
      emitsPlanUpdated: false,
      emitsTodoList: false,
      supportsStructuredQuestions: false,
    },
  },
  makeRuntime: (runtime) =>
    makeMuseRuntime({
      settings,
      environment: withGitHubSpawnEnvironment({
        ...environment,
        ...runtime.processEnvironment,
        ...runtime.agentEnvironment,
      }),
      cwd: runtime.cwd,
      ...(runtime.resumeSessionId ? { resumeSessionId: runtime.resumeSessionId } : {}),
      runtimeMode: runtime.runtimePolicy.runtimeMode,
      mcpServers: runtime.mcpServers,
      ...(runtime.onOutgoingResponse ? { onOutgoingResponse: runtime.onOutgoingResponse } : {}),
      ...(runtime.onOutgoingResponseFailure
        ? { onOutgoingResponseFailure: runtime.onOutgoingResponseFailure }
        : {}),
    }),
  preferResumeSession: true,
  supportsImagePrompts: false,
  supportsCompaction: false,
  applyModelSelection: ({ runtime, modelSelection }) =>
    Effect.gen(function* () {
      yield* runtime.setModel(modelSelection.model);
      const effort = modelSelection.options?.find(
        (option) => option.id === "reasoningEffort",
      )?.value;
      if (typeof effort === "string") yield* runtime.setConfigOption("reasoningEffort", effort);
      return modelSelection.model;
    }),
});
export type MuseDriverEnv =
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | Path.Path
  | FileSystem.FileSystem
  | IdAllocatorV2
  | ServerConfig
  | BackgroundPolicy
  | ServerSettingsService;
export const MuseDriver: ProviderDriver<MuseSettings, MuseDriverEnv> = {
  driverKind: driver,
  metadata: { displayName: "Muse Code", supportsMultipleInstances: true },
  configSchema: MuseSettings,
  defaultConfig: () => Schema.decodeSync(MuseSettings)({}),
  create: (input) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocatorV2;
      const serverConfig = yield* ServerConfig;
      const selfInvocation = yield* resolveSelfInvocation();
      const environment = mergeProviderInstanceEnvironment(input.environment);
      const settings = { ...input.config, enabled: input.enabled };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: driver,
        instanceId: input.instanceId,
      });
      const stamp = (snapshot: ReturnType<typeof buildServerProvider>): ServerProvider => ({
        ...snapshot,
        instanceId: input.instanceId,
        driver,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const initial = () =>
        stamp(
          buildServerProvider({
            presentation: {
              displayName: "Muse Code",
              showInteractionModeToggle: false,
              supportedRuntimeModes: ["approval-required", "full-access"],
              supportsConversationRollback: false,
            },
            enabled: input.enabled,
            checkedAt: DateTime.formatIso(DateTime.nowUnsafe()),
            models: [],
            probe: {
              installed: false,
              version: null,
              status: "warning",
              auth: { status: "unknown" },
              message: input.enabled
                ? "Refresh Providers after installing Muse Code and signing in with muse."
                : "Muse Code is disabled.",
            },
          }),
        );
      // A cold `muse serve` host has observed no usage until one of its
      // turns lands, so `usage/read` is empty in a provider check.
      // `muse usage --json` reads the account allowance live without a
      // model turn; it is the check's fallback, never a replacement for an
      // observed MSP read.
      const readCliUsage = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const child = yield* spawner.spawn(
          ChildProcess.make(settings.binaryPath || "muse", ["usage", "--json"], {
            env: environment,
            extendEnv: true,
          }),
        );
        const [output, , exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.runDrain),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return exitCode === 0
          ? museUsageFromCliJson(output, DateTime.toEpochMillis(now))
          : undefined;
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption("15 seconds"),
        Effect.map(Option.getOrElse(() => undefined)),
        Effect.orElseSucceed(() => undefined),
      );
      const checkProvider = Effect.gen(function* () {
        if (!input.enabled) return initial();
        const probed = yield* Effect.result(
          Effect.tryPromise({
            try: async () => {
              const { host, client } = await connectMuse(
                settings,
                environment,
                serverConfig.cwd,
              );
              try {
                const [catalog, usage] = await museControl(
                  Promise.all([
                    host.connection.request("model/list", {}),
                    host.connection.request("usage/read", {}),
                  ]),
                  () => client.close(),
                );
                return { catalog, usage, version: host.initializeResult.serverInfo.version };
              } finally {
                await client.close();
              }
            },
            catch: (cause) => new MuseCheckError({ detail: museCheckFailure(cause), cause }),
          }),
        );
        if (probed._tag === "Failure") {
          const failed: ServerProvider = {
            ...initial(),
            status: "error" as const,
            message: probed.failure.detail,
          };
          return failed;
        }
        const { catalog, usage, version } = probed.success;
        const apiKey = Boolean(environment.META_API_KEY?.trim());
        const limits = museUsage(usage) ?? (yield* readCliUsage);
        const models = museModels(
          catalog,
          limits !== undefined || museFullEntitled(usage, apiKey),
          apiKey,
        );
        // The host only serves its provider catalog to a signed-in
        // account; a cold host has simply observed no usage yet, which
        // is not a sign-out. Capacity (and fallback eligibility) still
        // requires an observed usage read.
        const authenticated = models.length > 0;
        const ready: ServerProvider = {
          ...initial(),
          installed: true,
          version,
          status: models.length ? ("ready" as const) : ("warning" as const),
          auth: {
            status: authenticated ? ("authenticated" as const) : ("unknown" as const),
            ...(apiKey ? { type: "api_key" } : { type: "subscription" }),
          },
          models,
          ...(limits ? { usageLimits: limits } : {}),
          message: limits
            ? "Muse Code native subscription. Wonder Full requires an eligible plan and account model availability."
            : authenticated
              ? "Signed in to Muse Code. Usage limits appear after this provider runs a turn; until then it will not be suggested as a fallback."
              : "Sign in with muse and refresh. Subscription capacity is not yet verified; this provider will not be suggested as a fallback.",
        };
        return ready;
      });
      const snapshot = yield* makeManagedServerProvider({
        getSettings: Effect.succeed(settings),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () => Effect.succeed(initial()),
        checkProvider,
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: driver,
              packageName: "Muse Code",
            }),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver,
              instanceId: input.instanceId,
              detail: "Could not create Muse provider",
              cause,
            }),
        ),
      );
      const orchestrationAdapter = makeAcpAdapterV2({
        instanceId: input.instanceId,
        crypto,
        fileSystem,
        idAllocator,
        serverConfig,
        selfInvocation,
        flavor: museAdapterFlavor(settings, environment),
      });
      // With a Meta API key the per-token API is the text-generation route
      // (no durable CLI session per title); the subscription route runs an
      // ephemeral Muse session. Agentic turns stay on the driver either way.
      const textGeneration =
        metaApiKey(environment) === undefined
          ? makeMuseTextGeneration(settings, environment)
          : makeMetaTextGeneration(environment);
      return {
        instanceId: input.instanceId,
        driverKind: driver,
        continuationIdentity,
        displayName: input.displayName,
        enabled: input.enabled,
        snapshot,
        readUsageLimitsNow: checkProvider.pipe(
          Effect.map((probed) => probed.usageLimits),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
        orchestrationAdapter,
        textGeneration,
      };
    }),
};
