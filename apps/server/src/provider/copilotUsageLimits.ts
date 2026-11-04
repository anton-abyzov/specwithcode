// @effect-diagnostics nodeBuiltinImport:off -- Hash the reported login; never persist it.
import { createHash } from "node:crypto";
import * as NodeOS from "node:os";
/**
 * GitHub Copilot quota for an ACP Registry Copilot instance.
 *
 * Copilot's ACP agent reports no usage, so the server reads the same quota the
 * Copilot CLI shows from `GET https://api.github.com/copilot_internal/user`.
 * The token comes from the instance's own environment (COPILOT_GITHUB_TOKEN,
 * GH_TOKEN, GITHUB_TOKEN, the order Copilot itself uses) or, failing that,
 * from the GitHub CLI for the account the Copilot CLI last signed in as. A
 * read for any other account than that sign-in is never published.
 *
 * @module provider/copilotUsageLimits
 */
import type {
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@specweave-studio/contracts";
import { resolveSpawnCommand } from "@specweave-studio/shared/shell";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "./providerUsageLimits.ts";
import { isCommandMissingCause, spawnAndCollect } from "./providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";

/** The ACP Registry agent whose quota this module reads. */
export const COPILOT_USAGE_AGENT_ID = "github-copilot-cli";

const COPILOT_USER_URL = "https://api.github.com/copilot_internal/user";
const GITHUB_HOST = "github.com";
const TOKEN_ENVIRONMENT_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
/** Kept out of the `gh` call so it hands over the stored login, not an environment token. */
const GH_ENVIRONMENT_TOKEN_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
] as const;
const HTTP_TIMEOUT = "10 seconds";
const GH_TIMEOUT_MS = 5_000;
/** How long one read is reused before GitHub is asked again. */
export const COPILOT_USAGE_CACHE_TTL_MS = 5 * 60 * 1_000;

const OptionalNumber = Schema.optional(Schema.NullOr(Schema.Number));
const OptionalBoolean = Schema.optional(Schema.NullOr(Schema.Boolean));
const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const CopilotQuotaSnapshot = Schema.Struct({
  entitlement: OptionalNumber,
  remaining: OptionalNumber,
  percent_remaining: OptionalNumber,
  unlimited: OptionalBoolean,
  has_quota: OptionalBoolean,
  overage_permitted: OptionalBoolean,
  timestamp_utc: OptionalString,
});
export type CopilotQuotaSnapshot = typeof CopilotQuotaSnapshot.Type;

export const CopilotUserResponse = Schema.Struct({
  login: OptionalString,
  copilot_plan: OptionalString,
  access_type_sku: OptionalString,
  quota_reset_date_utc: OptionalString,
  quota_snapshots: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        chat: Schema.optional(Schema.NullOr(CopilotQuotaSnapshot)),
        completions: Schema.optional(Schema.NullOr(CopilotQuotaSnapshot)),
        premium_interactions: Schema.optional(Schema.NullOr(CopilotQuotaSnapshot)),
      }),
    ),
  ),
});
export type CopilotUserResponse = typeof CopilotUserResponse.Type;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const normalizeLogin = (login: string | null | undefined) =>
  login?.trim().toLowerCase() || undefined;

function isoTimestamp(value: string | null | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const parsed = DateTime.make(value.trim());
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

const hasEntitlement = (quota: CopilotQuotaSnapshot | null | undefined) =>
  quota !== null &&
  quota !== undefined &&
  typeof quota.entitlement === "number" &&
  Number.isFinite(quota.entitlement) &&
  quota.entitlement > 0;

function usedPercentOf(quota: CopilotQuotaSnapshot): number | undefined {
  if (typeof quota.percent_remaining === "number" && Number.isFinite(quota.percent_remaining)) {
    return clampPercent(100 - quota.percent_remaining);
  }
  if (
    hasEntitlement(quota) &&
    typeof quota.remaining === "number" &&
    Number.isFinite(quota.remaining)
  ) {
    return clampPercent(100 * (1 - quota.remaining / quota.entitlement!));
  }
  return undefined;
}

/**
 * Turns one `copilot_internal/user` response into published usage.
 *
 * Premium requests are the quota that limits paid plans; Copilot Free has a
 * chat allowance instead. An unlimited quota publishes no window, so nothing
 * reads as spent. `expectedLogin`, when given, is the account the Copilot CLI
 * runs as; a response for another account is not published.
 */
export function copilotUserResponseToLimits(input: {
  readonly response: CopilotUserResponse;
  readonly checkedAt: string;
  readonly expectedLogin?: string | undefined;
}): ServerProviderUsageLimits {
  const { response, checkedAt } = input;
  const login = normalizeLogin(response.login);
  const expected = normalizeLogin(input.expectedLogin);
  if (expected !== undefined && login !== expected) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message:
        "The GitHub token found for Copilot usage belongs to another account than the Copilot CLI sign-in.",
    });
  }
  const plan = response.copilot_plan?.trim() || response.access_type_sku?.trim() || undefined;
  const subscriptionKey =
    login !== undefined
      ? `copilot:sha256:${sha256(JSON.stringify([login, plan?.toLowerCase() ?? null]))}`
      : undefined;
  const keyed = (limits: ServerProviderUsageLimits): ServerProviderUsageLimits =>
    subscriptionKey ? { ...limits, subscriptionKey } : limits;

  const snapshots = response.quota_snapshots;
  const premium = snapshots?.premium_interactions;
  const chat = snapshots?.chat;
  const chosen =
    premium && (premium.unlimited === true || hasEntitlement(premium))
      ? { id: "premium_interactions", label: "Premium requests", quota: premium }
      : chat && (chat.unlimited === true || hasEntitlement(chat))
        ? { id: "chat", label: "Chat", quota: chat }
        : undefined;
  if (chosen === undefined) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "GitHub reported no Copilot quota for this account.",
    });
  }
  if (chosen.quota.unlimited === true) {
    return keyed(makeUsageLimits({ checkedAt, windows: [] }));
  }
  const usedPercent = usedPercentOf(chosen.quota);
  if (usedPercent === undefined) {
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "unsupported",
      message: "GitHub reported no Copilot quota for this account.",
    });
  }
  const resetsAt = isoTimestamp(response.quota_reset_date_utc);
  const window: ServerProviderUsageWindow = {
    id: chosen.id,
    kind: "monthly",
    label: chosen.label,
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
  };
  const limits = keyed(makeUsageLimits({ checkedAt, windows: [window] }));
  // Spent premium requests do not stop Copilot: the included models keep
  // running, and paid overage may be on. Only a spent chat allowance without
  // overage really stops new turns.
  const stillRuns = chosen.id === "premium_interactions" || chosen.quota.overage_permitted === true;
  return usedPercent >= 100 && stillRuns ? { ...limits, ordinaryUsageAllowed: true } : limits;
}

/**
 * The account the Copilot CLI last signed in as, from its `config.json`.
 * The file carries comments and is not strict JSON, so only the
 * `lastLoggedInUser` object is read.
 */
export function parseCopilotLastLoggedInUser(
  text: string,
): { readonly host: string; readonly login: string } | undefined {
  const block = /"lastLoggedInUser"\s*:\s*\{([^{}]*)\}/u.exec(text)?.[1];
  if (block === undefined) return undefined;
  const field = (name: string) =>
    new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "u").exec(block)?.[1]?.trim();
  const login = field("login");
  if (!login) return undefined;
  const host = (field("host") ?? GITHUB_HOST)
    .replace(/^https?:\/\//iu, "")
    .replace(/\/+$/u, "")
    .toLowerCase();
  return { host: host || GITHUB_HOST, login };
}

export type CopilotGhTokenResult =
  | { readonly _tag: "token"; readonly token: string }
  | { readonly _tag: "missing" }
  | { readonly _tag: "notSignedIn" }
  | { readonly _tag: "failed" };

/**
 * `gh auth token` for one stored account, or for gh's active account when
 * `login` is undefined. The token never reaches a log.
 */
export const readGhToken = (
  login: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.Effect<CopilotGhTokenResult, never, ChildProcessSpawner.ChildProcessSpawner> => {
  const env: Record<string, string | undefined> = {
    ...environment,
    GH_DEBUG: "",
    GH_PROMPT_DISABLED: "1",
    NO_COLOR: "1",
  };
  for (const key of GH_ENVIRONMENT_TOKEN_KEYS) delete env[key];
  const args = [
    "auth",
    "token",
    "--hostname",
    GITHUB_HOST,
    ...(login === undefined ? [] : ["--user", login]),
  ];
  return Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand("gh", args, { env });
    return yield* spawnAndCollect(
      "gh",
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        extendEnv: false,
        shell: spawnCommand.shell,
        stdin: "ignore",
        forceKillAfter: "1 second",
      }),
    );
  }).pipe(
    Effect.timeoutOption(GH_TIMEOUT_MS),
    Effect.result,
    Effect.map((result): CopilotGhTokenResult => {
      if (Result.isFailure(result)) {
        return isCommandMissingCause(result.failure) ? { _tag: "missing" } : { _tag: "failed" };
      }
      if (Option.isNone(result.success)) return { _tag: "failed" };
      const { code, stdout } = result.success.value;
      const token = stdout.trim();
      if (code !== 0 || token === "") return { _tag: "notSignedIn" };
      return { _tag: "token", token };
    }),
  );
};

export interface CopilotUsageInput {
  /** The instance's own configured variables, not the server's. */
  readonly instanceEnvironment: Readonly<Record<string, string | undefined>>;
  /** The environment the Copilot CLI and `gh` run with (HOME, PATH, COPILOT_HOME). */
  readonly processEnvironment: NodeJS.ProcessEnv;
}

const environmentTokenOf = (input: CopilotUsageInput) =>
  [input.instanceEnvironment, input.processEnvironment]
    .flatMap((environment) => TOKEN_ENVIRONMENT_KEYS.map((key) => environment[key]?.trim()))
    .find((value): value is string => Boolean(value));

/**
 * The folder where the Copilot CLI keeps its sign-in: the COPILOT_HOME of the
 * environment the CLI launches with, else `~/.copilot` under that
 * environment's HOME. The launch environment comes from
 * `mergeProviderInstanceEnvironment`, so an instance's COPILOT_HOME gets the
 * same `expandHomePath` expansion the CLI receives. A server-level value the
 * merge passes through still starting with `~` resolves against the HOME the
 * CLI runs with, as the CLI's own home lookup does.
 */
export function resolveCopilotHome(
  input: CopilotUsageInput,
  path: { readonly join: (...segments: ReadonlyArray<string>) => string },
): string {
  const instanceVariables = Object.entries(input.instanceEnvironment).flatMap(([name, value]) =>
    name === "COPILOT_HOME" && value?.trim()
      ? [{ name, value: value.trim(), sensitive: false }]
      : [],
  );
  const launchEnvironment = mergeProviderInstanceEnvironment(
    instanceVariables,
    input.processEnvironment,
  );
  const configuredHome = launchEnvironment.COPILOT_HOME?.trim();
  const environmentHome = launchEnvironment.HOME?.trim() || NodeOS.homedir();
  if (!configuredHome) return path.join(environmentHome, ".copilot");
  if (configuredHome === "~") return environmentHome;
  return configuredHome.startsWith("~/") || configuredHome.startsWith("~\\")
    ? path.join(environmentHome, configuredHome.slice(2))
    : configuredHome;
}

const readCopilotConfigUser = (input: CopilotUsageInput) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* fs
      .readFileString(path.join(resolveCopilotHome(input, path), "config.json"))
      .pipe(Effect.orElseSucceed(() => ""));
    return parseCopilotLastLoggedInUser(config);
  });

/**
 * The GitHub CLI's sign-in file (`hosts.yml`) for the environment `gh` runs
 * with: GH_CONFIG_DIR, then XDG_CONFIG_HOME/gh, then `~/.config/gh`
 * (`%AppData%/GitHub CLI` on Windows).
 */
export function resolveGhHostsFile(
  environment: NodeJS.ProcessEnv,
  path: { readonly join: (...segments: ReadonlyArray<string>) => string },
  platform: NodeJS.Platform = process.platform,
): string {
  const configDir = environment.GH_CONFIG_DIR?.trim();
  if (configDir) return path.join(configDir, "hosts.yml");
  const xdg = environment.XDG_CONFIG_HOME?.trim();
  if (xdg) return path.join(xdg, "gh", "hosts.yml");
  const appData = environment.AppData?.trim() || environment.APPDATA?.trim();
  if (platform === "win32" && appData) return path.join(appData, "GitHub CLI", "hosts.yml");
  return path.join(environment.HOME?.trim() || NodeOS.homedir(), ".config", "gh", "hosts.yml");
}

/**
 * A stamp that changes when the account a usage read would use can change
 * without the CLI's `config.json` showing it: a `gh auth login`, `logout` or
 * `switch` rewrites gh's `hosts.yml`. A token in the environment is fixed for
 * the instance's lifetime, so it needs no stamp.
 */
export const readCopilotAccountStamp = Effect.fn("readCopilotAccountStamp")(function* (
  input: CopilotUsageInput,
) {
  if (environmentTokenOf(input) !== undefined) return undefined;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fs
    .stat(resolveGhHostsFile(input.processEnvironment, path))
    .pipe(Effect.option);
  if (Option.isNone(info)) return "gh:none";
  const modified = Option.getOrNull(info.value.mtime)?.getTime() ?? 0;
  return `gh:${modified}:${String(info.value.size)}`;
});

/**
 * The GitHub login the Copilot CLI signs in as, from its `config.json`.
 * `fromEnvironmentToken` is true when a token in the environment decides the
 * account instead; the login then comes from the usage read.
 */
export const readCopilotSignedInLogin = Effect.fn("readCopilotSignedInLogin")(function* (
  input: CopilotUsageInput,
) {
  if (environmentTokenOf(input) !== undefined) {
    return { login: undefined, fromEnvironmentToken: true } as const;
  }
  const user = yield* readCopilotConfigUser(input);
  return { login: user?.login, fromEnvironmentToken: false } as const;
});

/** One usage read, with the GitHub login it was read for when known. */
export interface CopilotUsageReading {
  readonly limits: ServerProviderUsageLimits;
  readonly login?: string | undefined;
}

export const readCopilotUsage = Effect.fn("readCopilotUsage")(function* (
  input: CopilotUsageInput,
  ghToken: typeof readGhToken = readGhToken,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  let knownLogin: string | undefined;
  return yield* Effect.gen(function* () {
    // The Copilot CLI runs with the instance's variables over the server's,
    // and a token there is the account it runs as.
    const environmentToken = environmentTokenOf(input);

    let token = environmentToken;
    let expectedLogin: string | undefined;
    if (token === undefined) {
      // With no stored sign-in the Copilot CLI falls back to gh's active
      // account, so its usage is that account's.
      const user = (yield* readCopilotConfigUser(input)) ?? {
        host: GITHUB_HOST,
        login: undefined,
      };
      knownLogin = user.login;
      const unavailable = (limits: ServerProviderUsageLimits): CopilotUsageReading => ({
        limits,
        login: user.login,
      });
      if (user.host !== GITHUB_HOST) {
        return unavailable(
          makeUnavailableUsageLimits({
            checkedAt,
            reason: "unsupported",
            message: "Copilot usage is read only for github.com sign-ins.",
          }),
        );
      }
      expectedLogin = user.login;
      const result = yield* ghToken(user.login, input.processEnvironment);
      switch (result._tag) {
        case "token":
          token = result.token;
          break;
        case "missing":
          return unavailable(
            makeUnavailableUsageLimits({
              checkedAt,
              reason: "unsupported",
              message: `Install the GitHub CLI and sign in${user.login ? ` as ${user.login}` : ""} to read Copilot usage.`,
            }),
          );
        case "notSignedIn":
          return unavailable(
            makeUnavailableUsageLimits({
              checkedAt,
              reason: "unsupported",
              message: `Sign in to the GitHub CLI${user.login ? ` as ${user.login}` : ""} to read Copilot usage (gh auth login).`,
            }),
          );
        case "failed":
          return unavailable(
            makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: "The GitHub CLI did not hand over a token for Copilot usage.",
            }),
          );
      }
    }

    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(COPILOT_USER_URL).pipe(
          HttpClientRequest.setHeaders({
            authorization: `token ${token}`,
            accept: "application/json",
            "user-agent": "SpecWithCode",
          }),
        ),
      )
      .pipe(Effect.timeout(HTTP_TIMEOUT));
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      return {
        limits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "unsupported",
          message: "GitHub did not report Copilot usage for this account.",
        }),
        login: expectedLogin,
      } satisfies CopilotUsageReading;
    }
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(CopilotUserResponse)),
      Effect.timeout(HTTP_TIMEOUT),
    );
    const limits = copilotUserResponseToLimits({ response: body, checkedAt, expectedLogin });
    // A response for another account says nothing about the CLI's sign-in.
    const responseLogin =
      expectedLogin === undefined ? body.login?.trim() || undefined : expectedLogin;
    return { limits, login: responseLogin } satisfies CopilotUsageReading;
  }).pipe(
    Effect.orElseSucceed((): CopilotUsageReading => ({
      limits: makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Copilot usage could not be read.",
      }),
      login: knownLogin,
    })),
  );
});

export const readCopilotUsageLimits = (
  input: CopilotUsageInput,
  ghToken: typeof readGhToken = readGhToken,
) => readCopilotUsage(input, ghToken).pipe(Effect.map((reading) => reading.limits));

const usageLimitsOf = (
  value: ServerProviderUsageLimits | CopilotUsageReading,
): ServerProviderUsageLimits => ("limits" in value ? value.limits : value);

/** How long a reading without usage is reused, so `gh` is not run on every status check. */
export const COPILOT_USAGE_UNAVAILABLE_TTL_MS = 60 * 1_000;

export interface CachedCopilotUsage<A, R> {
  /**
   * The reading for `key` (the account the CLI signs in as). A reading made
   * for another key is never returned. While a read is running, callers
   * wait on it instead of starting another; a caller that stops waiting
   * leaves the read running, and its result still fills the cache.
   */
  readonly get: (key: string) => Effect.Effect<A, never, R>;
  /** Drops the cached reading, so the next `get` reads afresh. */
  readonly invalidate: Effect.Effect<void>;
}

interface CopilotUsageCacheState<A> {
  readonly generation: number;
  /** Counts reads started, so an older read never replaces a newer reading. */
  readonly sequence: number;
  readonly entry?:
    | { readonly key: string; readonly at: number; readonly value: A; readonly sequence: number }
    | undefined;
  readonly inFlight?:
    | { readonly key: string; readonly generation: number; readonly done: Deferred.Deferred<A> }
    | undefined;
}

/**
 * Reuses one read per account: a reading with usage for `ttlMs`, one without
 * (a sign-in, account or network problem) for `unavailableTtlMs`. Reads run
 * in the scope this is made in, so a slow read outlives the status check that
 * started it.
 */
export const makeCachedCopilotUsageLimits = <
  A extends ServerProviderUsageLimits | CopilotUsageReading,
  R,
>(
  read: Effect.Effect<A, never, R>,
  options: { readonly ttlMs?: number; readonly unavailableTtlMs?: number } = {},
): Effect.Effect<CachedCopilotUsage<A, R>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ttlMs = options.ttlMs ?? COPILOT_USAGE_CACHE_TTL_MS;
    const unavailableTtlMs = options.unavailableTtlMs ?? COPILOT_USAGE_UNAVAILABLE_TTL_MS;
    const scope = yield* Effect.scope;
    const state = yield* Ref.make<CopilotUsageCacheState<A>>({ generation: 0, sequence: 0 });
    const admission = yield* Semaphore.make(1);
    const ttlOf = (value: A) =>
      usageLimitsOf(value).unavailable === undefined ? ttlMs : unavailableTtlMs;

    const start = (key: string) =>
      admission.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const current = yield* Ref.get(state);
          const { entry, inFlight } = current;
          if (entry !== undefined && entry.key === key && now - entry.at < ttlOf(entry.value)) {
            return { _tag: "cached", value: entry.value } as const;
          }
          if (inFlight !== undefined && inFlight.key === key) {
            return { _tag: "waiting", done: inFlight.done } as const;
          }
          const done = yield* Deferred.make<A>();
          const generation = current.generation;
          const sequence = current.sequence + 1;
          yield* Ref.set(state, { ...current, sequence, inFlight: { key, generation, done } });
          yield* read.pipe(
            Effect.onExit((exit) =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((at) =>
                  Ref.update(state, (latest) => ({
                    ...latest,
                    // Only a successful reading is kept, and never one started
                    // before an invalidation or before the reading already cached.
                    entry:
                      Exit.isSuccess(exit) &&
                      latest.generation === generation &&
                      (latest.entry === undefined || latest.entry.sequence < sequence)
                        ? { key, at, value: exit.value, sequence }
                        : latest.entry,
                    // A read that fails, dies or is interrupted frees its slot too.
                    inFlight: latest.inFlight?.done === done ? undefined : latest.inFlight,
                  })),
                ),
                Effect.andThen(Deferred.done(done, exit)),
              ),
            ),
            Effect.forkIn(scope),
          );
          return { _tag: "waiting", done } as const;
        }),
      );

    return {
      get: (key) =>
        Effect.flatMap(start(key), (started) =>
          started._tag === "cached" ? Effect.succeed(started.value) : Deferred.await(started.done),
        ),
      invalidate: Ref.update(state, (current) => ({
        generation: current.generation + 1,
        sequence: current.sequence,
      })),
    } satisfies CachedCopilotUsage<A, R>;
  });
