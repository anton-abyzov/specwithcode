/**
 * PiProvider — snapshot/probe layer for the Pi coding agent.
 *
 * Health is probed with `pi --version`. Models, the user's default model, and
 * the user's commands (extension slash commands, prompt templates, skills)
 * are discovered through a short-lived ephemeral RPC session
 * (`pi --mode rpc --no-session`), so everything the user configured in
 * `~/.pi/agent` — custom providers, models.json entries, extensions, skills —
 * shows up in Studio without any hardcoded catalog.
 */
import {
  type CustomModelSetting,
  type ModelBilling,
  type PiSettings,
  type ServerProvider,
  type ServerProviderModel,
} from "@specweave-studio/contracts";
import { classifyBaseUrlBilling, isLoopbackBaseUrl } from "@specweave-studio/shared/modelBilling";
import { causeErrorTag } from "@specweave-studio/shared/observability";
import { resolveSpawnCommand } from "@specweave-studio/shared/shell";
import { compareSemverVersions } from "@specweave-studio/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  buildPiRpcLaunch,
  resolvePiLaunchArgs,
} from "../orchestration-v2/Adapters/piStudioMcpInjection.ts";
import {
  makePiRpcConnection,
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
} from "../orchestration-v2/Adapters/PiRpc.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "./providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "./providerMaintenance.ts";
import {
  EMPTY_PI_MODEL_CAPABILITIES,
  thinkingCapabilitiesForPiModel,
} from "./piThinkingCapabilities.ts";
import {
  parsePiDiscoveredCommands,
  withPiBuiltinSlashCommands,
  type PiDiscoveredCommands,
} from "./PiCommands.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  // The adapter reports context usage from Pi's streaming usage while a
  // turn runs, so clients can reserve the meter before the first settle.
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const PI_RPC_DISCOVERY_TIMEOUT_MS = 15_000;
/**
 * get_entries arrived in 0.80.3 and agent_settled landed in source at 0.80.4.
 * Version 0.80.5 was the first published package containing both hooks. Studio
 * needs them for rollback boundaries and reliable turn terminalization.
 */
export const MINIMUM_PI_VERSION = "0.80.5";

/** Deferring to the user's own settings.json default model. */
const PI_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Pi default",
  isCustom: false,
  capabilities: EMPTY_PI_MODEL_CAPABILITIES,
};

interface PiDiscovery extends PiDiscoveredCommands {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly defaultModel: ServerProviderModel;
  readonly authenticated: boolean;
}

/** @internal Exported for tests. */
export function piModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
  defaultModel: ServerProviderModel = PI_DEFAULT_MODEL,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [defaultModel, ...discovered],
    customModels ?? [],
    EMPTY_PI_MODEL_CAPABILITIES,
  );
}

/**
 * Providers Pi signs in to with an account rather than a key. Claude Pro/Max
 * shares the `anthropic` id and base URL with an Anthropic API key, and the
 * RPC does not say which one a remote model uses, so it stays `unknown`.
 */
const PI_ACCOUNT_LOGIN_PROVIDERS: ReadonlySet<string> = new Set([
  "anthropic",
  "github-copilot",
  "google-antigravity",
  "google-gemini-cli",
  "openai-codex",
]);

/**
 * Who pays for a Pi model. OpenCode Go is a subscription. A keyed cloud API
 * reads as `api` only when the model has a price and its provider has no
 * account sign-in. Loopback API ids stay `api`, and advertised prices
 * override local inference, as in the OpenCode inventory.
 */
function piModelBilling(model: unknown, provider: string): ModelBilling {
  if (provider === "opencode-go") return "subscription";
  const baseUrl = recordString(model, "baseUrl");
  const billing = classifyBaseUrlBilling(baseUrl, provider);
  const cost = recordField(model, "cost");
  const priced = (recordNumber(cost, "input") ?? 0) > 0 || (recordNumber(cost, "output") ?? 0) > 0;
  if (billing === "local" && priced) return "api";
  if (billing !== "api" || isLoopbackBaseUrl(baseUrl)) return billing;
  return priced && !PI_ACCOUNT_LOGIN_PROVIDERS.has(provider) ? "api" : "unknown";
}

function positiveInt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Pi's model data has no tool-call flag, so `toolCalls` stays unset. */
function piModelFacts(
  model: unknown,
  provider: string,
): Pick<
  ServerProviderModel,
  "billing" | "reasoning" | "imageInput" | "contextWindow" | "maxOutput"
> {
  const reasoning = recordField(model, "reasoning");
  const input = recordField(model, "input");
  const contextWindow = positiveInt(recordNumber(model, "contextWindow"));
  const maxOutput = positiveInt(recordNumber(model, "maxTokens"));
  return {
    billing: piModelBilling(model, provider),
    ...(typeof reasoning === "boolean" ? { reasoning: reasoning ? "optional" : "none" } : {}),
    ...(Array.isArray(input) ? { imageInput: input.includes("image") } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutput === undefined ? {} : { maxOutput }),
  };
}

/** @internal Exported for tests. */
export function parseDiscoveredModels(
  data: unknown,
  defaultThinkingLevel: unknown,
): ReadonlyArray<ServerProviderModel> {
  const models = recordField(data, "models");
  if (!Array.isArray(models)) return [];
  const seen = new Set<string>();
  const parsed: Array<ServerProviderModel> = [];
  for (const model of models) {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    if (provider === undefined || id === undefined) continue;
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    parsed.push({
      slug,
      name: recordString(model, "name") ?? slug,
      subProvider: provider,
      isCustom: false,
      capabilities: thinkingCapabilitiesForPiModel(model, defaultThinkingLevel),
      ...piModelFacts(model, provider),
    });
  }
  return parsed;
}

/**
 * The "default" entry carrying the billing and facts of the model Pi's own
 * settings name (`get_state`'s `model`), so a default that is an OpenRouter or
 * keyed API model reads as paid like the same model picked by slug.
 *
 * @internal Exported for tests.
 */
export function piDefaultModel(
  stateData: unknown,
  discovered: ReadonlyArray<ServerProviderModel>,
): ServerProviderModel {
  const stateModel = recordField(stateData, "model");
  const provider = recordString(stateModel, "provider");
  const id = recordString(stateModel, "id");
  if (provider === undefined || id === undefined) return PI_DEFAULT_MODEL;
  const known = discovered.find((model) => model.slug === `${provider}/${id}`);
  const { billing, reasoning, imageInput, contextWindow, maxOutput } =
    known ?? piModelFacts(stateModel, provider);
  return {
    ...PI_DEFAULT_MODEL,
    ...(billing === undefined ? {} : { billing }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(imageInput === undefined ? {} : { imageInput }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutput === undefined ? {} : { maxOutput }),
  };
}

const discoverPiViaRpc = (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd?: string,
) =>
  Effect.gen(function* () {
    const launch = buildPiRpcLaunch({
      launchArgs,
      environment,
      mcpSession: undefined,
      extensionPath: undefined,
      ephemeral: true,
    });
    const connection = yield* makePiRpcConnection({
      command: piSettings.binaryPath || "pi",
      args: launch.args,
      cwd,
      env: launch.env,
    });
    yield* Stream.fromQueue(connection.events).pipe(
      Stream.runDrain,
      Effect.ignore,
      Effect.forkScoped,
    );
    const stateData = yield* connection.request({ type: "get_state" });
    const modelsData = yield* connection.request({ type: "get_available_models" });
    const commandsData = yield* connection
      .request({ type: "get_commands" })
      .pipe(Effect.orElseSucceed(() => undefined));
    const discoveredModels = parseDiscoveredModels(
      modelsData,
      recordString(stateData, "thinkingLevel"),
    );
    const { slashCommands, skills } = parsePiDiscoveredCommands(commandsData);
    return {
      models: discoveredModels,
      defaultModel: piDefaultModel(stateData, discoveredModels),
      slashCommands: withPiBuiltinSlashCommands(slashCommands),
      skills,
      authenticated: discoveredModels.length > 0,
    } satisfies PiDiscovery;
  }).pipe(Effect.scoped);

const runPiVersionCommand = (piSettings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = piSettings.binaryPath || "pi";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export function buildInitialPiProviderSnapshot(
  piSettings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = piModelsFromSettings(piSettings.customModels);
    if (!piSettings.enabled) {
      return buildServerProvider({
        presentation: PI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Pi is disabled in SpecWithCode settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Pi CLI availability...",
      },
    });
  });
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = piModelsFromSettings(piSettings.customModels);

  if (!piSettings.enabled) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in SpecWithCode settings.",
      },
    });
  }

  const versionResult = yield* runPiVersionCommand(piSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Pi CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Pi CLI (`pi`) is not installed or not on PATH. Install with `npm install -g @earendil-works/pi-coding-agent`."
          : "Failed to execute Pi CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but timed out while running `pi --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run.",
      },
    });
  }

  if (version === null) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `SpecWithCode could not determine the Pi version. Pi ${MINIMUM_PI_VERSION} or newer is required.`,
      },
    });
  }

  if (compareSemverVersions(version, MINIMUM_PI_VERSION) < 0) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Pi ${version} is unsupported. Update to Pi ${MINIMUM_PI_VERSION} or newer.`,
      },
    });
  }

  const resolvedLaunchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
  if (!resolvedLaunchArgs.ok) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: resolvedLaunchArgs.message,
      },
    });
  }

  const discoveryExit = yield* discoverPiViaRpc(
    piSettings,
    environment,
    resolvedLaunchArgs.args,
    cwd,
  ).pipe(Effect.timeoutOption(PI_RPC_DISCOVERY_TIMEOUT_MS), Effect.exit);
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Pi RPC discovery failed.", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "Pi CLI is installed, but RPC startup failed. SpecWithCode could not verify its models and commands. Check Pi in a terminal, then refresh the provider.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: piSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message:
          "Pi CLI is installed, but RPC discovery timed out. Run Pi in a terminal to resolve startup prompts, then refresh the provider.",
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const models = piModelsFromSettings(
    piSettings.customModels,
    discovery.models,
    discovery.defaultModel,
  );
  return buildServerProvider({
    presentation: PI_PRESENTATION,
    enabled: piSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    skills: discovery.skills,
    probe: {
      installed: true,
      version,
      status: discovery.authenticated ? "ready" : "warning",
      auth: { status: discovery.authenticated ? "authenticated" : "unauthenticated", type: "pi" },
      ...(discovery.authenticated
        ? {}
        : {
            message:
              "Pi has no usable models. Run `pi` in a terminal and use /login, or configure an API key in ~/.pi/agent.",
          }),
    },
  });
});

export const enrichPiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;
  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
