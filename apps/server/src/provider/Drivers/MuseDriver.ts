import * as DateTime from "effect/DateTime";
import {
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
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
} from "../../orchestration-v2/Adapters/AcpAdapterV2.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { ProviderDriverError } from "../Errors.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildServerProvider } from "../providerSnapshot.ts";
import { MuseSettings } from "@specweave-studio/contracts";
import { connectMuse, museCheckFailure, museControl } from "../muse/MuseConnection.ts";
import { museModels, museUsage, museSubscription } from "../muse/MuseDiscovery.ts";
import { makeMuseRuntime } from "../muse/MuseRuntime.ts";
import { fromRunner } from "../../textGeneration/TextGenerationOperations.ts";
import type { BackgroundPolicy } from "../../background/BackgroundPolicy.ts";
import type { ServerSettingsService } from "../../serverSettings.ts";

const driver = ProviderDriverKind.make("muse");
export type MuseDriverEnv =
  | Crypto.Crypto
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
      const checkProvider = Effect.tryPromise({
        try: async () => {
          if (!input.enabled) return initial();
          const { host, client } = await connectMuse(settings, environment, serverConfig.cwd);
          try {
            const [catalog, usage] = await museControl(
              Promise.all([
                host.connection.request("model/list", {}),
                host.connection.request("usage/read", {}),
              ]),
              () => client.close(),
            );
            const limits = museUsage(usage);
            const apiKey = Boolean(environment.META_API_KEY?.trim());
            const models = museModels(catalog, museSubscription(usage), apiKey);
            const authenticated = limits !== undefined;
            return {
              ...initial(),
              installed: true,
              version: host.initializeResult.serverInfo.version,
              status: models.length ? ("ready" as const) : ("warning" as const),
              auth: {
                status: authenticated ? ("authenticated" as const) : ("unknown" as const),
                ...(apiKey ? { type: "api_key" } : { type: "subscription" }),
              },
              models,
              ...(limits ? { usageLimits: limits } : {}),
              message: authenticated
                ? "Muse Code native subscription. Wonder Full requires an eligible plan and account model availability."
                : "Sign in with muse and refresh. Subscription capacity is not yet verified; this provider will not be suggested as a fallback.",
            };
          } finally {
            await client.close();
          }
        },
        catch: (cause) => ({
          ...initial(),
          status: "error" as const,
          message: museCheckFailure(cause),
        }),
      }).pipe(Effect.orElseSucceed((value) => value));
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
        flavor: {
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
              environment: {
                ...environment,
                ...runtime.processEnvironment,
                ...runtime.agentEnvironment,
              },
              cwd: runtime.cwd,
              ...(runtime.resumeSessionId ? { resumeSessionId: runtime.resumeSessionId } : {}),
              runtimeMode: runtime.runtimePolicy.runtimeMode,
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
              if (typeof effort === "string")
                yield* runtime.setConfigOption("reasoningEffort", effort);
              return modelSelection.model;
            }),
        },
      });
      const textGeneration = fromRunner("Muse Code", (request) =>
        Effect.fail(
          new TextGenerationError({
            operation: request.operation,
            detail:
              "Muse Code background text generation is not enabled. Choose another provider for automatic titles and commit messages.",
          }),
        ),
      );
      return {
        instanceId: input.instanceId,
        driverKind: driver,
        continuationIdentity,
        displayName: input.displayName,
        enabled: input.enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration,
      };
    }),
};
