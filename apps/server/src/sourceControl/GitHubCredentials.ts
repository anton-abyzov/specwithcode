import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import {
  HostProcessEnvironment,
  HostProcessWorkingDirectory,
} from "@specweave-studio/shared/hostProcess";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";

/** How long a token is reused before `gh` is asked again, so a `gh auth switch` applies soon. */
const TOKEN_TTL = Duration.minutes(5);
/** No credential is retried sooner, so a fresh `gh auth login` takes effect on the next read. */
const MISSING_TTL = Duration.seconds(10);
/** An empty login list (no gh, a gh too old for `--json`, signed out) is asked again this often. */
const NO_LOGINS_TTL = Duration.minutes(1);

export const GitHubCredentialSource = Schema.Literals(["settings", "env", "gh"]);
export type GitHubCredentialSource = typeof GitHubCredentialSource.Type;

export interface GitHubCredential {
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly source: GitHubCredentialSource;
  /** A digest of host and token: safe for cache keys and rate-limit scopes, never the token. */
  readonly fingerprint: string;
  /** The gh login the token belongs to, set only when it was picked for a repository's owner. */
  readonly account?: string;
}

/** A login `gh` holds for a host and can hand a token for. */
export interface GitHubLogin {
  readonly login: string;
  /** The one `gh` and its git credential helper use when nothing names another. */
  readonly active: boolean;
}

export interface GitHubCredentialOptions {
  /**
   * The owner of the repository the request is about. A gh login with that name (any letter case)
   * is used ahead of the pinned account and the active login, never ahead of a token saved in
   * Settings or set in the environment.
   */
  readonly owner?: string | undefined;
}

/** Nothing in the environment, and no `gh` on PATH to ask. */
export class GitHubCliMissingError extends Schema.TaggedError<GitHubCliMissingError>()(
  "GitHubCliMissingError",
  { host: Schema.String },
) {
  override get message(): string {
    return `No GitHub credential for ${this.host}: set GH_TOKEN, or install the GitHub CLI and run \`gh auth login\`.`;
  }
}

/** `gh` is installed but holds no login for the host, or not the account chosen in Settings. */
export class GitHubNotSignedInError extends Schema.TaggedError<GitHubNotSignedInError>()(
  "GitHubNotSignedInError",
  { host: Schema.String, account: Schema.optional(Schema.String) },
) {
  override get message(): string {
    return this.account === undefined
      ? `No GitHub credential for ${this.host}: run \`gh auth login --hostname ${this.host}\`.`
      : `No GitHub credential for ${this.account} on ${this.host}: run \`gh auth login --hostname ${this.host}\` for that account or pick another in Settings → Source Control.`;
  }
}

/** The user turned the host off in Settings. */
export class GitHubHostDisabledError extends Schema.TaggedError<GitHubHostDisabledError>()(
  "GitHubHostDisabledError",
  { host: Schema.String },
) {
  override get message(): string {
    return `GitHub host ${this.host} is turned off in Settings → Source Control.`;
  }
}

/** `gh auth token` timed out or failed for a reason other than having no login. */
export class GitHubCliFailedError extends Schema.TaggedError<GitHubCliFailedError>()(
  "GitHubCliFailedError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The GitHub CLI could not hand over a credential for ${this.host}. Check \`gh auth status\` on the server.`;
  }
}

/** There is no token for the host. */
export type GitHubCredentialUnavailableError =
  | GitHubCliMissingError
  | GitHubNotSignedInError
  | GitHubHostDisabledError
  | GitHubCliFailedError;

export const isGitHubCredentialUnavailableError = Schema.is(
  Schema.Union([GitHubCliMissingError, GitHubNotSignedInError, GitHubHostDisabledError]),
);

/**
 * Where GitHub tokens come from. Callers ask per host and never see how the token was found,
 * so another source (an in-app OAuth login) slots in here without touching any of them.
 */
export class GitHubCredentials extends Context.Service<
  GitHubCredentials,
  {
    readonly get: (
      host: string,
      options?: GitHubCredentialOptions,
    ) => Effect.Effect<GitHubCredential, GitHubCredentialUnavailableError>;
    /** Drops the held tokens after GitHub refused one, so the next read asks its source again. */
    readonly invalidate: (host: string) => Effect.Effect<void>;
    /**
     * The logins gh holds for the host, from `gh auth status` (no token is read). Empty when gh
     * is missing, too old to list them, or signed out. `fresh` asks gh again now.
     */
    readonly logins: (
      host: string,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<ReadonlyArray<GitHubLogin>>;
  }
>()("specweave-studio/sourceControl/GitHubCredentials") {}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

const HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;

/**
 * API URLs are built from the host text, so anything but a bare `host[:port]` (a `#`, `/`, `?`,
 * a backslash or `user@`) could send a token to a different server than the one it was meant for.
 */
export function isGitHubHost(host: string): boolean {
  return HOSTNAME.test(host);
}

/** Hosts gh treats as GitHub.com-like for `GH_TOKEN`: github.com and GHE.com data residency. */
function isGitHubDotCom(host: string): boolean {
  return host === "github.com" || host.endsWith(".ghe.com");
}

/**
 * The environment token for a host, in gh's precedence order. gh hands `GH_ENTERPRISE_TOKEN` to
 * any non-github.com host; here it only goes to the host `GH_HOST` names, because a remote URL
 * picks the host and a hostile one must not receive an enterprise token.
 */
export function environmentToken(
  host: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (!isGitHubHost(host)) return null;
  const names = isGitHubDotCom(host)
    ? ["GH_TOKEN", "GITHUB_TOKEN"]
    : env.GH_HOST?.trim().toLowerCase() === host
      ? ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]
      : [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const environment = yield* HostProcessEnvironment;
  const workingDirectory = yield* HostProcessWorkingDirectory;

  /** `host:sha256(token)`, safe for cache keys and rate-limit scopes. */
  const fingerprintOf = (host: string, token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(
      Effect.map((digest) => `${host}:${Hex.encode(digest)}`),
      // Hashing a string in memory has no platform failure worth a typed error.
      Effect.orDie,
    );

  const fromGh = (host: string, account: string | undefined) =>
    process
      .run({
        operation: "GitHubCredentials.get",
        command: "gh",
        args: [
          "auth",
          "token",
          "--hostname",
          host,
          ...(account === undefined ? [] : ["--user", account]),
        ],
        cwd: workingDirectory,
        // Never let gh print the token into a debug log. gh also answers any host other than
        // github.com with an enterprise token from its environment, which this child inherits;
        // `environmentToken` already decided whether this host may have it, so gh must not.
        env: {
          GH_DEBUG: "",
          GH_PROMPT_DISABLED: "1",
          GH_ENTERPRISE_TOKEN: "",
          GITHUB_ENTERPRISE_TOKEN: "",
        },
        timeoutMs: 10_000,
      })
      .pipe(
        Effect.mapError((error) =>
          error._tag === "VcsProcessSpawnError" &&
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? new GitHubCliMissingError({ host })
            : // gh exits non-zero with "no oauth token" when it has no login for the host.
              error._tag === "VcsProcessExitError"
              ? new GitHubNotSignedInError({ host, ...(account === undefined ? {} : { account }) })
              : new GitHubCliFailedError({ host, cause: error }),
        ),
        Effect.map((output) => output.stdout.trim()),
        Effect.filterOrFail(
          (token) => token !== "",
          () => new GitHubNotSignedInError({ host, ...(account === undefined ? {} : { account }) }),
        ),
      );

  /** The Settings choice for a host; unreadable settings fall back to gh's own choice. */
  const hostChoice = (host: string) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.github.hosts[host]),
      Effect.orElseSucceed(() => undefined),
    );

  /** A token saved in Settings for the host, read fresh so a saved or removed one applies at once. */
  const savedToken = (host: string) =>
    serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.github.tokens[host]?.trim() || null),
      Effect.orElseSucceed(() => null),
    );

  /** Cache key: the host plus its pinned account, so a changed pin misses the cache. */
  const cacheKey = (host: string, account: string | undefined) =>
    account === undefined ? host : `${host}\u0000${account}`;
  /** Cache key for a login picked for a repository's owner: that login's token or nothing. */
  const ownerCacheKey = (host: string, login: string) => `${host}\u0000${login}\u0000owner`;

  const lookup = Effect.fn("GitHubCredentials.lookup")(function* (key: string) {
    const [host = key, choice, owner] = key.split("\u0000");
    if (owner !== undefined && choice !== undefined) {
      const token = yield* fromGh(host, choice);
      return {
        host,
        token: Redacted.make(token),
        source: "gh",
        fingerprint: yield* fingerprintOf(host, token),
        account: choice,
      } satisfies GitHubCredential;
    }
    // An environment token wins over a pinned account, exactly as it does in gh.
    const fromEnv = environmentToken(host, environment);
    // A pinned login gh no longer holds (logged out, expired) falls back to the active one,
    // which is what discovery reports as the account in use.
    const token =
      fromEnv ??
      (yield* fromGh(host, choice).pipe(
        Effect.catchTags({
          GitHubNotSignedInError: (error) =>
            choice === undefined ? Effect.fail(error) : fromGh(host, undefined),
        }),
      ));
    return {
      host,
      token: Redacted.make(token),
      source: fromEnv !== null ? "env" : "gh",
      fingerprint: yield* fingerprintOf(host, token),
    } satisfies GitHubCredential;
  });

  const cache = yield* Cache.makeWith(lookup, {
    capacity: 32,
    // A transient gh failure (a timeout, a locked keyring) is asked again on the next read.
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? TOKEN_TTL
        : Exit.findErrorOption(exit).pipe(
              Option.exists((error) => error._tag === "GitHubCliFailedError"),
            )
          ? Duration.zero
          : MISSING_TTL,
  });

  const loginCache = yield* Cache.makeWith(
    (host: string) =>
      process
        .run({
          operation: "GitHubCredentials.logins",
          command: "gh",
          args: ["auth", "status", "--json", "hosts"],
          cwd: workingDirectory,
          env: { GH_DEBUG: "", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
          // gh exits non-zero when any login is broken and still lists the others.
          allowNonZeroExit: true,
          timeoutMs: 15_000,
        })
        .pipe(
          Effect.map((output) =>
            parseGitHubAuthStatus(output.stdout)
              .accounts.filter(
                (account) =>
                  account.host === host &&
                  account.authenticated &&
                  // A token variable shows up as a login, but gh cannot hand it out by name.
                  account.environmentVariable === null,
              )
              .map(
                (account) =>
                  ({ login: account.account, active: account.active }) satisfies GitHubLogin,
              ),
          ),
          Effect.orElseSucceed((): ReadonlyArray<GitHubLogin> => []),
        ),
    {
      capacity: 8,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.length > 0 ? TOKEN_TTL : NO_LOGINS_TTL,
    },
  );

  // Owner keys read per host, so a refused token drops them along with the host's own.
  const ownerKeys = new Map<string, Set<string>>();

  /** The token of the gh login named like `owner`, or null: every failure falls back. */
  const forOwner = Effect.fn("GitHubCredentials.forOwner")(function* (host: string, owner: string) {
    const wanted = owner.trim().toLowerCase();
    if (wanted === "" || environmentToken(host, environment) !== null) return null;
    const held = (yield* Cache.get(loginCache, host)).find(
      (entry) => entry.login.toLowerCase() === wanted,
    );
    if (held === undefined) return null;
    // gh's own spelling of the login, never text taken from a URL or a path.
    const key = ownerCacheKey(host, held.login);
    let keys = ownerKeys.get(host);
    if (keys === undefined) {
      keys = new Set();
      ownerKeys.set(host, keys);
    }
    keys.add(key);
    return yield* Cache.get(cache, key).pipe(Effect.orElseSucceed(() => null));
  });

  return GitHubCredentials.of({
    get: Effect.fn("GitHubCredentials.get")(function* (rawHost, options) {
      const host = normalizeHost(rawHost);
      if (!isGitHubHost(host)) return yield* new GitHubNotSignedInError({ host });
      const choice = yield* hostChoice(host);
      if (choice?.enabled === false) {
        return yield* new GitHubHostDisabledError({ host });
      }
      // A token saved in Settings is the most deliberate choice, so it comes before the
      // environment and gh. It is read from the secret store each time, so it needs no cache.
      const saved = yield* savedToken(host);
      if (saved !== null) {
        return {
          host,
          token: Redacted.make(saved),
          source: "settings",
          fingerprint: yield* fingerprintOf(host, saved),
        } satisfies GitHubCredential;
      }
      if (options?.owner !== undefined) {
        const owned = yield* forOwner(host, options.owner);
        if (owned !== null) return owned;
      }
      return yield* Cache.get(cache, cacheKey(host, choice?.account));
    }),
    invalidate: (rawHost) => {
      const host = normalizeHost(rawHost);
      const owned = [...(ownerKeys.get(host) ?? [])];
      ownerKeys.delete(host);
      return hostChoice(host).pipe(
        Effect.flatMap((choice) => Cache.invalidate(cache, cacheKey(host, choice?.account))),
        Effect.andThen(Effect.forEach(owned, (key) => Cache.invalidate(cache, key))),
        Effect.andThen(Cache.invalidate(loginCache, host)),
      );
    },
    logins: (rawHost, options) => {
      const host = normalizeHost(rawHost);
      if (!isGitHubHost(host)) return Effect.succeed([]);
      return (options?.fresh === true ? Cache.invalidate(loginCache, host) : Effect.void).pipe(
        Effect.andThen(Cache.get(loginCache, host)),
      );
    },
  });
});

export const layer = Layer.effect(GitHubCredentials, make);
