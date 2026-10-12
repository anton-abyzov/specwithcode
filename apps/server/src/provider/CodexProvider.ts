import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Types from "effect/Types";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as CodexClient from "@specweave-studio/effect-codex-app-server/client";
import * as CodexSchema from "@specweave-studio/effect-codex-app-server/schema";
import * as CodexErrors from "@specweave-studio/effect-codex-app-server/errors";

import type {
  CodexSettings,
  CustomModelSetting,
  ServerProvider,
  ServerProviderState,
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderModel,
  ServerProviderSkill,
} from "@specweave-studio/contracts";
import { PREFERRED_DEFAULT_CODEX_MODELS, ServerSettingsError } from "@specweave-studio/contracts";

import {
  codexModelFamily,
  createModelCapabilities,
  formatCodexModelName,
  readCustomModelEntries,
} from "@specweave-studio/shared/model";
import { resolveSpawnCommand } from "@specweave-studio/shared/shell";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  type ServerProviderDraft,
} from "./providerSnapshot.ts";
import { expandHomePath } from "../pathExpansion.ts";
import { makeUnavailableUsageLimits } from "./providerUsageLimits.ts";
import {
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  type CodexRateLimitSnapshot,
  type CodexResetCreditsSummary,
} from "./codexUsageLimits.ts";
import packageJson from "../../package.json" with { type: "json" };
const isCodexAppServerSpawnError = Schema.is(CodexErrors.CodexAppServerSpawnError);
const RATE_LIMITS_PROBE_TIMEOUT_MS = 3_000;
const MODEL_CATALOG_RETENTION_MS = 60 * 60 * 1000;

type CodexRateLimitsProbe =
  | {
      readonly snapshot: CodexRateLimitSnapshot;
      readonly accountId?: string | null;
      readonly rateLimitsByLimitId?:
        | Readonly<Record<string, CodexRateLimitSnapshot>>
        | null
        | undefined;
      readonly resetCredits: CodexResetCreditsSummary | null | undefined;
      readonly ordinaryUsageAllowed?: boolean | null;
    }
  | { readonly failure: string };

const CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER = "2 seconds" as const;

const CODEX_PRESENTATION = {
  displayName: "Codex",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;

export interface CodexAppServerProviderSnapshot {
  readonly account: CodexSchema.V2GetAccountResponse;
  readonly nativeRouteVerified?: boolean;
  readonly rateLimits?: CodexRateLimitsProbe;
  readonly version: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly modelsDiscoveryFailed?: boolean;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const REASONING_EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
};

const DEFAULT_SERVICE_TIER_ID = "default";

/** Shorter copy for tiers whose catalog description wraps in the traits menu. */
const SERVICE_TIER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  ultrafast: "Even faster, more expensive",
};

function reasoningEffortLabel(reasoningEffort: string): string {
  return REASONING_EFFORT_LABELS[reasoningEffort] ?? reasoningEffort;
}

function codexAccountAuthLabel(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";
  if (account.type === "amazonBedrock") return "Amazon Bedrock";
  if (account.type !== "chatgpt") return undefined;
  return codexPlanLabel(account.planType);
}

/** Shared with usage-limit sources, which report the same `planType` slugs. */
export function codexPlanLabel(planType: string | null | undefined): string | undefined {
  switch (planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 20x Subscription";
    case "prolite":
      return "ChatGPT Pro 5x Subscription";
    case "promax":
      return "ChatGPT Pro Max Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_prolite":
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "ent26":
    case "enterprise_cbp_automation":
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
    case "edu_plus":
    case "edu_pro":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return undefined;
  }
}

function codexAccountEmail(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account || account.type !== "chatgpt") return undefined;
  return account.email;
}

export function mapCodexModelCapabilities(
  model: CodexSchema.V2ModelListResponse__Model,
): ModelCapabilities {
  const reasoningOptions = model.supportedReasoningEfforts.map(({ reasoningEffort }) =>
    reasoningEffort ===
    (codexModelFamily(model.model) === "gpt-6-astra" ? "medium" : model.defaultReasoningEffort)
      ? {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
          isDefault: true,
        }
      : {
          id: reasoningEffort,
          label: reasoningEffortLabel(reasoningEffort),
        },
  );
  const defaultReasoning = reasoningOptions.find((option) => option.isDefault)?.id;
  const serviceTiers =
    model.serviceTiers && model.serviceTiers.length > 0
      ? model.serviceTiers
      : (model.additionalSpeedTiers ?? []).map((id) => ({
          id,
          name: id === "fast" ? "Fast" : id,
          description: "",
        }));
  const catalogDefaultServiceTier = serviceTiers.some(
    (tier) => tier.id === model.defaultServiceTier,
  )
    ? model.defaultServiceTier
    : null;
  const defaultServiceTier = catalogDefaultServiceTier ?? DEFAULT_SERVICE_TIER_ID;
  const optionDescriptors: ProviderOptionDescriptor[] = [];

  if (reasoningOptions.length > 0) {
    optionDescriptors.push({
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: reasoningOptions,
      ...(defaultReasoning ? { currentValue: defaultReasoning } : {}),
    });
  }
  if (serviceTiers.length > 0) {
    optionDescriptors.push({
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        {
          id: DEFAULT_SERVICE_TIER_ID,
          label: "Standard",
          ...(defaultServiceTier === DEFAULT_SERVICE_TIER_ID ? { isDefault: true } : {}),
        },
        ...serviceTiers.map((tier) => {
          const description = SERVICE_TIER_DESCRIPTIONS[tier.id] ?? tier.description;
          return {
            id: tier.id,
            label: tier.name,
            ...(description ? { description } : {}),
            ...(defaultServiceTier === tier.id ? { isDefault: true } : {}),
          };
        }),
      ],
      currentValue: defaultServiceTier,
    });
  }

  return createModelCapabilities({
    optionDescriptors,
  });
}

function parseCodexModelListResponse(
  response: CodexSchema.V2ModelListResponse,
): ReadonlyArray<ServerProviderModel> {
  return response.data.map((model) => ({
    slug: model.model,
    name: formatCodexModelName(model.displayName),
    isCustom: false,
    ...(model.isDefault ? { isDefault: true } : {}),
    capabilities: mapCodexModelCapabilities(model),
  }));
}

/** Keep Codex's current default; the static ranking only fills an absent default. */
export function applyPreferredCodexDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
): ReadonlyArray<ServerProviderModel> {
  if (models.some((model) => !model.isCustom && model.isDefault)) return models;
  const preferredSlug = PREFERRED_DEFAULT_CODEX_MODELS.flatMap((slug) =>
    models.filter((model) => !model.isCustom && codexModelFamily(model.slug) === slug),
  )[0]?.slug;
  if (!preferredSlug) {
    return models;
  }
  return models.map((model) => {
    if (model.slug === preferredSlug) {
      return model.isDefault ? model : { ...model, isDefault: true };
    }
    if (!model.isDefault) {
      return model;
    }
    const { isDefault: _isDefault, ...rest } = model;
    return rest;
  });
}

/** A driver owns one cache. Never persist catalogs or reuse them across accounts. */
export function makeCodexModelCatalogCache() {
  let previous:
    | { identity: string; at: number; models: ReadonlyArray<ServerProviderModel> }
    | undefined;
  return {
    clear: () => {
      previous = undefined;
    },
    resolve: (
      snapshot: CodexAppServerProviderSnapshot,
      now: number,
    ): ReadonlyArray<ServerProviderModel> => {
      const account = snapshot.account.account;
      const limits =
        snapshot.rateLimits && !("failure" in snapshot.rateLimits)
          ? snapshot.rateLimits
          : undefined;
      const identity =
        account?.type === "chatgpt" && account.email
          ? JSON.stringify([
              account.email.trim().toLowerCase(),
              account.planType,
              limits?.accountId ?? null,
            ])
          : undefined;
      // Losing a previously observed account id also clears the cache. An
      // email can belong to multiple workspaces; do not guess their identity.
      if (
        !identity ||
        previous?.identity !== identity ||
        now < previous.at ||
        now - previous.at > MODEL_CATALOG_RETENTION_MS
      ) {
        previous = undefined;
      }
      if (!snapshot.modelsDiscoveryFailed) {
        if (identity) {
          previous = {
            identity,
            at: now,
            models: snapshot.models.filter((model) => !model.isCustom),
          };
        }
        return snapshot.models;
      }
      if (!previous) return snapshot.models;
      const slugs = new Set(previous.models.map((model) => model.slug));
      return [
        ...previous.models,
        ...snapshot.models.filter((model) => model.isCustom && !slugs.has(model.slug)),
      ];
    },
  };
}

/**
 * Codex has no static default capability set, so a bare custom slug borrows
 * the first built-in's descriptors; an entry with its own capabilities keeps
 * them.
 */
function appendCustomCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<CustomModelSetting>,
): ReadonlyArray<ServerProviderModel> {
  if (customModels.length === 0) {
    return models;
  }

  const seen = new Set(models.map((model) => model.slug));
  const fallbackCapabilities = models.find((model) => model.capabilities)?.capabilities ?? null;
  const customEntries: ServerProviderModel[] = [];
  for (const entry of readCustomModelEntries(customModels)) {
    if (seen.has(entry.slug)) {
      continue;
    }
    seen.add(entry.slug);
    customEntries.push({
      slug: entry.slug,
      name: entry.name,
      isCustom: true,
      capabilities: entry.capabilities ?? fallbackCapabilities,
    });
  }
  return customEntries.length === 0 ? models : [...models, ...customEntries];
}

function parseCodexSkillsListResponse(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);

  return skills.map((skill) => {
    const shortDescription =
      skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

    const parsedSkill: Types.Mutable<ServerProviderSkill> = {
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    };

    if (skill.description) {
      parsedSkill.description = skill.description;
    }
    if (skill.scope) {
      parsedSkill.scope = skill.scope;
    }
    if (skill.interface?.displayName) {
      parsedSkill.displayName = skill.interface.displayName;
    }
    if (shortDescription) {
      parsedSkill.shortDescription = shortDescription;
    }

    return parsedSkill;
  });
}

const requestAllCodexModels = Effect.fn("requestAllCodexModels")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined = undefined;

  do {
    const response: CodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );
    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
});

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    // Protocol identity, not display: Codex receives it as the client identity and the
    // recorded replay transcripts assert it. See docs/studio/naming.md.
    clientInfo: {
      name: "SpecWeave Studio",
      title: "SpecWeave Studio",
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

/**
 * Spawns a short-lived `codex app-server`, runs the initialize handshake, and
 * hands the caller a connected client. Scoped: the process is killed when
 * the caller's scope closes. Shared by the status probe, the skills probe,
 * and account-level requests such as reset-credit redemption.
 */
export const withCodexAppServerClient = Effect.fn("withCodexAppServerClient")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string | undefined;
  readonly launchArgs?: string | undefined;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}) {
  // `~` is not shell-expanded when env vars are set via `child_process.spawn`,
  // so `CODEX_HOME=~/.codex_work` would reach codex verbatim and trip
  // "CODEX_HOME points to '~/.codex_work', but that path does not exist".
  // Expand here for parity with `CodexTextGeneration`.
  const resolvedHomePath = input.homePath ? expandHomePath(input.homePath) : undefined;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = {
    ...input.environment,
    ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
  };
  const spawnCommand = yield* resolveSpawnCommand(
    input.binaryPath,
    codexAppServerArgs(input.launchArgs),
    { env: environment, extendEnv: true },
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: input.cwd,
        env: environment,
        extendEnv: true,
        forceKillAfter: CODEX_APP_SERVER_PROBE_FORCE_KILL_AFTER,
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new CodexErrors.CodexAppServerSpawnError({
            command: `${input.binaryPath} app-server`,
            cause,
          }),
      ),
    );
  const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );
  const initialize = yield* client.request("initialize", buildCodexInitializeParams());
  yield* client.notify("initialized", undefined);
  return { client, initialize };
});

/** Reduce supported effective config to a boolean; never return config or credentials. */
export function codexNativeRouteVerified(config: CodexSchema.V2ConfigReadResponse["config"]): boolean {
  if (config.model_provider != null && config.model_provider !== "openai") return false;
  if (config.forced_login_method != null && config.forced_login_method !== "chatgpt") return false;
  // Official config/read also reports this default when no endpoint was overridden.
  // Exact strings avoid URL normalization hiding userinfo, ports or path segments.
  if (config.chatgpt_base_url != null && config.chatgpt_base_url !== "https://chatgpt.com/backend-api" && config.chatgpt_base_url !== "https://chatgpt.com/backend-api/") return false;
  if (config.openai_base_url != null) return false;
  const providers = config.model_providers;
  if (providers == null) return true;
  if (!Predicate.isReadonlyObject(providers)) return false;
  const openai = providers.openai;
  if (openai == null) return true;
  if (!Predicate.isReadonlyObject(openai)) return false;
  // A custom OpenAI endpoint/auth route is an API lane even with ChatGPT auth.
  return openai.base_url == null && openai.websocket_base_url == null && openai.env_key == null && openai.http_headers == null && openai.env_http_headers == null && openai.experimental_bearer_token == null;
}

/** Explicit cwd resolves project layers; a global observation cannot admit another project. */
export const readCodexNativeRoute = (client: {
  readonly request: (method: "config/read", params: CodexSchema.V2ConfigReadParams) =>
    Effect.Effect<CodexSchema.V2ConfigReadResponse, CodexErrors.CodexAppServerError>;
}, cwd: string) =>
  client.request("config/read", { cwd, includeLayers: false }).pipe(
    Effect.map((response) => codexNativeRouteVerified(response.config)),
    Effect.timeoutOption(Duration.millis(RATE_LIMITS_PROBE_TIMEOUT_MS)),
    Effect.map(Option.getOrElse(() => false)),
    Effect.catch(() => Effect.succeed(false)),
  );

export const probeCodexNativeRoute = (input: Parameters<typeof withCodexAppServerClient>[0]) =>
  Effect.gen(function* () {
    const { client } = yield* withCodexAppServerClient(input);
    return yield* readCodexNativeRoute(client, input.cwd);
  }).pipe(Effect.scoped, Effect.timeoutOption(Duration.millis(AUTH_PROBE_TIMEOUT_MS)),
    Effect.map(Option.getOrElse(() => false)), Effect.catch(() => Effect.succeed(false)));

/** Optional catalogs must not erase a fresh account result when discovery stalls. */
export const readCodexProviderMetadata = Effect.fn("readCodexProviderMetadata")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  input: { readonly cwd: string; readonly skipNativeUsage?: boolean },
) {
  const optional = <A>(effect: Effect.Effect<A, CodexErrors.CodexAppServerError>, fallback: A) =>
    effect.pipe(
      Effect.timeoutOption(Duration.millis(RATE_LIMITS_PROBE_TIMEOUT_MS)),
      Effect.map(Option.getOrElse(() => fallback)),
      Effect.catch((error) =>
        Effect.logDebug("Optional Codex provider discovery failed.", { errorTag: error._tag }).pipe(
          Effect.as(fallback),
        ),
      ),
    );
  const [skillsResponse, models, rateLimits, nativeRouteVerified] = yield* Effect.all(
    [
      optional(client.request("skills/list", { cwds: [input.cwd] }), { data: [] }),
      optional<ReadonlyArray<ServerProviderModel> | undefined>(
        requestAllCodexModels(client),
        undefined,
      ),
      input.skipNativeUsage
        ? Effect.succeed(undefined)
        : client.request("account/rateLimits/read", null).pipe(
            Effect.map((response): CodexRateLimitsProbe => ({
              snapshot: response.rateLimits,
              ...(response.accountId === undefined ? {} : { accountId: response.accountId }),
              rateLimitsByLimitId: response.rateLimitsByLimitId,
              resetCredits: response.rateLimitResetCredits,
              ...(response.ordinaryUsageAllowed === undefined ? {} : { ordinaryUsageAllowed: response.ordinaryUsageAllowed }),
            })),
            Effect.timeoutOption(Duration.millis(RATE_LIMITS_PROBE_TIMEOUT_MS)),
            Effect.map(Option.getOrElse((): CodexRateLimitsProbe => ({
              failure: "Codex did not answer the usage request.",
            }))),
            Effect.catch((error) => Effect.succeed<CodexRateLimitsProbe>({
              failure: codexRateLimitsFailureMessage(error),
            })),
          ),
      readCodexNativeRoute(client, input.cwd),
    ],
    { concurrency: "unbounded" },
  );
  return {
    skillsResponse,
    models: models ?? [],
    modelsDiscoveryFailed: models === undefined,
    rateLimits,
    nativeRouteVerified,
  };
});

const probeCodexAppServerProvider = Effect.fn("probeCodexAppServerProvider")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly cwd: string;
  readonly customModels?: ReadonlyArray<CustomModelSetting>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly skipNativeUsage?: boolean;
}) {
  // Keep the existing authorization deadline separate from optional discovery.
  // A fresh account arriving near that deadline still receives bounded metadata
  // without being discarded by a timeout that includes both phases.
  const proof = yield* Effect.gen(function* () {
    const { client, initialize } = yield* withCodexAppServerClient(input);
    const accountResponse = yield* client.request("account/read", { refreshToken: false });
    return { client, initialize, accountResponse };
  }).pipe(Effect.timeoutOption(Duration.millis(AUTH_PROBE_TIMEOUT_MS)));
  if (Option.isNone(proof)) return yield* new CodexErrors.CodexAppServerRequestError({ code: -32000, errorMessage: "Timed out while checking native Codex account status" });
  const { client, initialize, accountResponse } = proof.value;

  // Extract the version string after the first '/' in userAgent, up to the next space or the end
  const versionMatch = initialize.userAgent.match(/\/([^\s]+)/);
  const version = versionMatch ? versionMatch[1] : undefined;

  if (!accountResponse.account && accountResponse.requiresOpenaiAuth) {
    return {
      account: accountResponse,
      version,
      models: appendCustomCodexModels([], input.customModels ?? []),
      skills: [],
    } satisfies CodexAppServerProviderSnapshot;
  }

  const { skillsResponse, models, modelsDiscoveryFailed, rateLimits, nativeRouteVerified } =
    yield* readCodexProviderMetadata(client, input);

  return {
    account: accountResponse,
    nativeRouteVerified,
    modelsDiscoveryFailed,
    ...(rateLimits ? { rateLimits } : {}),
    version,
    models: applyPreferredCodexDefaultModel(
      appendCustomCodexModels(models, input.customModels ?? []),
    ),
    skills: parseCodexSkillsListResponse(skillsResponse, input.cwd),
  } satisfies CodexAppServerProviderSnapshot;
});

export const probeCodexSkillsForCwd = Effect.fn("probeCodexSkillsForCwd")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  const { client } = yield* withCodexAppServerClient(input);
  const skillsResponse = yield* client.request("skills/list", { cwds: [input.cwd] });
  return parseCodexSkillsListResponse(skillsResponse, input.cwd);
});

const emptyCodexModelsFromSettings = (codexSettings: CodexSettings): ServerProvider["models"] =>
  appendCustomCodexModels([], codexSettings.customModels);

const makePendingCodexProvider = (
  codexSettings: CodexSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = emptyCodexModelsFromSettings(codexSettings);

    if (!codexSettings.enabled) {
      return buildServerProvider({
        presentation: CODEX_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        skills: [],
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Codex is disabled in SpecWithCode settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex provider status has not been checked in this session yet.",
      },
    });
  });

function accountProbeStatus(account: CodexAppServerProviderSnapshot["account"]): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} {
  const authLabel = codexAccountAuthLabel(account.account);
  const authEmail = codexAccountEmail(account.account);
  const auth = {
    status: account.account ? ("authenticated" as const) : ("unknown" as const),
    ...(account.account?.type ? { type: account.account?.type } : {}),
    ...(authLabel ? { label: authLabel } : {}),
    ...(authEmail ? { email: authEmail } : {}),
  } satisfies ServerProvider["auth"];

  if (account.account) {
    return { status: "ready", auth };
  }

  if (account.requiresOpenaiAuth) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  return { status: "ready", auth };
}

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  codexSettings: CodexSettings,
  probe: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly launchArgs?: string;
    readonly cwd: string;
    readonly customModels: ReadonlyArray<CustomModelSetting>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly skipNativeUsage?: boolean;
  }) => Effect.Effect<
    CodexAppServerProviderSnapshot,
    CodexErrors.CodexAppServerError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  > = probeCodexAppServerProvider,
  environment?: NodeJS.ProcessEnv,
  managedAuth?: ServerProvider["auth"],
  modelCatalogCache?: ReturnType<typeof makeCodexModelCatalogCache>,
): Effect.fn.Return<
  ServerProviderDraft,
  ServerSettingsError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const emptyModels = emptyCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    modelCatalogCache?.clear();
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: false,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in SpecWithCode settings.",
      },
    });
  }

  const probeResult = yield* probe({
    binaryPath: codexSettings.binaryPath,
    homePath: codexSettings.homePath,
    launchArgs: resolveCodexLaunchArgs(codexSettings.launchArgs, resolvedEnvironment),
    cwd: process.cwd(),
    customModels: codexSettings.customModels,
    environment: resolvedEnvironment,
    ...(managedAuth ? { skipNativeUsage: true } : {}),
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(AUTH_PROBE_TIMEOUT_MS + RATE_LIMITS_PROBE_TIMEOUT_MS)),
    Effect.result,
  );

  if (Result.isFailure(probeResult)) {
    modelCatalogCache?.clear();
    const error = probeResult.failure;
    const installed = !isCodexAppServerSpawnError(error);
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: installed
          ? `Codex app-server provider probe failed: ${error.message}.`
          : `Could not start Codex CLI (\`${codexSettings.binaryPath}\`). Check Settings → Providers → Codex → Binary path on the server.` +
            (codexSettings.binaryPath === "codex"
              ? " Installing ChatGPT or Codex desktop may not add codex to PATH."
              : " Make sure the configured executable exists and can be run."),
      },
    });
  }

  if (Option.isNone(probeResult.success)) {
    modelCatalogCache?.clear();
    return buildServerProvider({
      presentation: CODEX_PRESENTATION,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Timed out while checking Codex app-server provider status.",
      },
    });
  }

  const snapshot = probeResult.success.value;
  const accountStatus = managedAuth
    ? { status: "ready" as const, auth: managedAuth, message: undefined }
    : accountProbeStatus(snapshot.account);
  const usageLimits =
    snapshot.account.account?.type === "apiKey"
      ? makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" })
      : snapshot.rateLimits === undefined || "failure" in snapshot.rateLimits
        ? makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            ...(snapshot.rateLimits ? { message: snapshot.rateLimits.failure } : {}),
          })
        : codexRateLimitsToLimits({
            snapshot: snapshot.rateLimits.snapshot,
            ...(snapshot.rateLimits.accountId === undefined ? {} : { accountId: snapshot.rateLimits.accountId }),
            rateLimitsByLimitId: snapshot.rateLimits.rateLimitsByLimitId,
            resetCredits: snapshot.rateLimits.resetCredits,
            ...(snapshot.rateLimits.ordinaryUsageAllowed === undefined ? {} : { ordinaryUsageAllowed: snapshot.rateLimits.ordinaryUsageAllowed }),
            checkedAt,
          });

  return buildServerProvider({
    presentation: CODEX_PRESENTATION,
    enabled: codexSettings.enabled,
    checkedAt,
    models: modelCatalogCache?.resolve(snapshot, Date.parse(checkedAt)) ?? snapshot.models,
    skills: snapshot.skills,
    slashCommands: [
      COMPACT_SLASH_COMMAND,
      {
        name: "goal",
        description: "Set a goal Codex keeps working toward until it is done",
        input: { hint: "Objective, or pause, resume, clear" },
      },
      {
        name: "feedback",
        description: "Send this thread and Codex logs to OpenAI",
        input: { hint: "Describe the issue (optional)" },
      },
    ],
    probe: {
      installed: true,
      version: snapshot.version ?? null,
      status: accountStatus.status,
      auth: accountStatus.auth,
      ...(accountStatus.message ? { message: accountStatus.message } : {}),
      ...(managedAuth ? {} : { usageLimits: { ...usageLimits, nativeRouteVerified: snapshot.nativeRouteVerified === true, nativeRouteObservedAt: checkedAt } }),
    },
  });
});

// NOTE: the singleton `CodexProviderLive` Layer has been removed as part of
// the per-instance-driver refactor. `CodexDriver.create()` builds a managed
// snapshot per instance (each with its own `CodexSettings`) and hands the
// resulting `ServerProviderShape` back as `ProviderInstance.snapshot`.
//
// The `makePendingCodexProvider` and `checkCodexProviderStatus` helpers are
// re-exported for use by `CodexDriver`.
export { makePendingCodexProvider };
