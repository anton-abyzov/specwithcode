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
import {
  loginFileMark,
  museAccountConfigPath,
  museLoginIdentity,
  watchLoginChanges,
} from "../loginWatch.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildServerProvider, noAnswerMessage } from "../providerSnapshot.ts";
import { MuseSettings } from "@specweave-studio/contracts";
import {
  connectMuse,
  MuseCheckError,
  museControl,
  museFailure,
  type MuseFailure,
} from "../muse/MuseConnection.ts";
import { museCatalogDownloadArgs, museCliAccount, museReadiness } from "../muse/MuseAccount.ts";
import { museModels, museUsage, museFullEntitled } from "../muse/MuseDiscovery.ts";
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
/** How long Muse Code's host gets to answer its handshake or a request (`MuseConnection.ts`). */
const MUSE_ANSWER_LIMIT_MS = 10_000;
/** What the connection throws when the handshake or a request ran out of time. */
const MUSE_NO_ANSWER = /^Muse Code (?:handshake|control request) timed out$/;

/**
 * Whether a failed check is the host giving no answer in time: one of the two
 * limits the connection itself reports. A launcher's own last line that happens
 * to say "timed out" (a download, say) is a reason to show, not a silence.
 */
export const museGaveNoAnswer = (cause: unknown): boolean =>
  cause instanceof Error && MUSE_NO_ANSWER.test(cause.message);

/**
 * The row for a check that failed. A launcher that is missing or does not
 * start is not installed, which leads to the install step; one that started
 * and refused the account, or speaks another protocol, is installed.
 */
export function museFailedSnapshot(initial: ServerProvider, failure: MuseFailure): ServerProvider {
  const failed = { ...initial, status: "error" as const, message: failure.message };
  if (failure.kind === "signedOut") {
    return {
      ...failed,
      installed: true,
      auth: { status: "unauthenticated", type: "subscription" },
    };
  }
  return failure.kind === "protocol" ? { ...failed, installed: true } : failed;
}

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
      const path = yield* Path.Path;
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
                ? "Checking Muse Code on this machine."
                : "Muse Code is disabled.",
            },
          }),
        );
      // A `muse serve` host started for a check has observed no usage (it is
      // empty until one of its turns lands) and cannot say whether the account
      // is signed in (see `MuseAccount.ts`). `muse usage --json` reads both
      // live without a model turn.
      const readCliAccount = Effect.gen(function* () {
        const now = yield* DateTime.now;
        const child = yield* spawner.spawn(
          ChildProcess.make(settings.binaryPath || "muse", ["usage", "--json"], {
            env: environment,
            extendEnv: true,
            stdin: "ignore",
          }),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText(), Stream.mkString),
            child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return museCliAccount({ exitCode, stdout, stderr }, DateTime.toEpochMillis(now));
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption("15 seconds"),
        Effect.map(Option.getOrElse(() => undefined)),
        Effect.orElseSucceed(() => undefined),
      );
      // Asked once per server run, and again when a person chooses Check again
      // or the login changes: each ask leaves one empty session in Muse Code's
      // own list, so it is never repeated on a timer.
      let modelListAsked = false;
      const modelListFolder = path.join(serverConfig.stateDir, "muse-model-list");
      const downloadModelList = Effect.gen(function* () {
        // Its own empty folder, so the run can touch no project.
        yield* fileSystem.makeDirectory(modelListFolder, { recursive: true });
        const child = yield* spawner.spawn(
          ChildProcess.make(settings.binaryPath || "muse", [...museCatalogDownloadArgs], {
            cwd: modelListFolder,
            env: environment,
            extendEnv: true,
            stdin: "ignore",
          }),
        );
        yield* Effect.all(
          [child.stdout.pipe(Stream.runDrain), child.stderr.pipe(Stream.runDrain), child.exitCode],
          { concurrency: "unbounded", discard: true },
        );
      }).pipe(Effect.scoped, Effect.timeoutOption("30 seconds"), Effect.ignoreCause({ log: true }));
      const checkProvider = Effect.gen(function* () {
        if (!input.enabled) return initial();
        const probe = Effect.result(
          Effect.tryPromise({
            try: async () => {
              const { host, client } = await connectMuse(settings, environment, serverConfig.cwd);
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
            catch: (cause) =>
              new MuseCheckError({
                detail: museFailure(cause, settings.binaryPath || "muse").message,
                cause,
              }),
          }),
        );
        let probed = yield* probe;
        const silent = () => probed._tag === "Failure" && museGaveNoAnswer(probed.failure.cause);
        // A host that gave no answer is asked once more before anything is shown.
        if (silent()) probed = yield* probe;
        if (probed._tag === "Failure") {
          const failed: ServerProvider = silent()
            ? {
                ...initial(),
                // It started and then said nothing: it is here, and what was
                // known about its sign-in stays on the row.
                installed: true,
                status: "error" as const,
                message: noAnswerMessage("Muse Code", MUSE_ANSWER_LIMIT_MS),
              }
            : museFailedSnapshot(
                initial(),
                museFailure(probed.failure.cause, settings.binaryPath || "muse"),
              );
          return failed;
        }
        const { usage, version } = probed.success;
        const apiKey = Boolean(environment.META_API_KEY?.trim());
        // An API key is its own route: the subscription's sign-in says nothing about it.
        const account = apiKey ? undefined : yield* readCliAccount;
        const limits = museUsage(usage) ?? account?.limits;
        const listed = (catalog: unknown) =>
          museModels(catalog, limits !== undefined || museFullEntitled(usage, apiKey), apiKey);
        let models = listed(probed.success.catalog);
        // Signed in and no list: the host has no catalog on disk yet. A host
        // reads the catalog when it starts, so a new one is asked afterwards.
        if (models.length > 0) {
          // A list that was here and goes later is not fetched by a timed check:
          // the row then says to choose Check again. A list left on disk by an
          // account that is signed out says nothing about the next sign-in.
          if (account?.signedIn !== false) modelListAsked = true;
        } else if (account?.signedIn === true && !modelListAsked) {
          modelListAsked = true;
          yield* downloadModelList;
          const again = yield* probe;
          if (again._tag === "Success") models = listed(again.success.catalog);
        }
        const ready: ServerProvider = {
          ...initial(),
          installed: true,
          version,
          ...museReadiness({ models, limits, account, apiKey }),
          models,
          ...(limits ? { usageLimits: limits } : {}),
        };
        return ready;
      });
      const accountConfigPath = yield* museAccountConfigPath({ ...process.env, ...environment });
      const snapshot = yield* makeManagedServerProvider({
        getSettings: Effect.succeed(settings),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () => Effect.succeed(initial()),
        checkProvider,
        // The launcher keeps its program beside itself and names it in this
        // file, so a repair can land without the launcher changing.
        installProbe: {
          command: settings.binaryPath || "muse",
          environment,
          beside: [".muse-version"],
        },
        // `muse login` in a terminal shows on a row that is on screen.
        signInProbe: {
          mark: loginFileMark(accountConfigPath).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          ),
        },
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
      // `muse login` and `muse logout` in a terminal change the account under
      // this instance; the row follows without a manual refresh.
      if (input.enabled) {
        yield* watchLoginChanges({
          filePath: accountConfigPath,
          readIdentity: museLoginIdentity,
          // Another account has another model list.
          onChange: Effect.sync(() => {
            modelListAsked = false;
          }).pipe(Effect.andThen(snapshot.refresh), Effect.ignoreCause({ log: true })),
        }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      }
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
        // Check again asks for the model list once more.
        invalidateCaches: Effect.sync(() => {
          modelListAsked = false;
        }),
        readUsageLimitsNow: checkProvider.pipe(
          Effect.map((probed) => probed.usageLimits),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ),
        orchestrationAdapter,
        textGeneration,
      };
    }),
};
