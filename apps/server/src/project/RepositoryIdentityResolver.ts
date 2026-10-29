import type { RepositoryIdentity, SourceControlProviderError } from "@specweave-studio/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@specweave-studio/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
// Background sweeps resolve every project each minute. A long TTL keeps them
// from spawning git each time. Clone, publish, and PR discovery (after a turn
// and before it saves links) resolve with `refresh: true`.
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(15);
// Short, so a folder that gains a repository or a remote shows up quickly.
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly refine?: (
    identity: RepositoryIdentity,
  ) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
  /**
   * Answers whether a folder is there before git is asked about it. A missing
   * folder resolves to `null` without spawning git. Spawning is synchronous on
   * the event loop and slowest when the machine is busy, and the server's
   * background sweeps ask about every project, including folders long deleted.
   */
  readonly cwdExists?: (cwd: string) => Effect.Effect<boolean>;
}

/** Git could not say which repository a folder belongs to: it failed or timed out. */
export class RepositoryIdentityReadError extends Schema.TaggedError<RepositoryIdentityReadError>()(
  "RepositoryIdentityReadError",
  { cwd: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Git could not read the repository of ${this.cwd}: ${this.detail}`;
  }
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (
      cwd: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<RepositoryIdentity | null>;
    /**
     * A fresh read that tells a git failure from a folder without a repository.
     * `null` means git answered: the folder is in no repository, its repository
     * has no remote, or git is not installed. A failed or timed-out git command
     * fails instead, where `resolve` would answer `null`. Uncached. Optional so
     * test doubles of `resolve` alone still type-check.
     */
    readonly resolveStrict?: (
      cwd: string,
    ) => Effect.Effect<RepositoryIdentity | null, RepositoryIdentityReadError>;
  }
>()("specweave-studio/project/RepositoryIdentityResolver") {}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // Partial clones append their filter, e.g. `(fetch) [blob:none]`.
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)(?:\s+\[[^[\]\r\n]+\])?$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function repositoryPathOf(canonicalKey: string): string {
  return canonicalKey.split("/").slice(1).join("/");
}

function buildRepositoryOrigin(
  originUrl: string | undefined,
  canonicalKey: string,
): RepositoryIdentity["origin"] {
  if (!originUrl) return undefined;
  const originKey = normalizeGitRemoteUrl(originUrl);
  if (originKey === canonicalKey) return undefined;
  const displayName = repositoryPathOf(originKey);
  return { canonicalKey: originKey, remoteUrl: originUrl, ...(displayName ? { displayName } : {}) };
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly originUrl: string | undefined;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
  const repositoryPath = repositoryPathOf(canonicalKey);
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);
  const origin = buildRepositoryOrigin(input.originUrl, canonicalKey);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
    ...(origin ? { origin } : {}),
  };
}

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;

    // git is a real executable on every platform — no cmd.exe shell mode, which
    // would split paths containing spaces during cmd's re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.code !== 0) {
      return null;
    }

    const candidate = topLevelResult.value.stdout.trim();
    return candidate.length > 0 ? candidate : null;
  },
);

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (
  cacheKey: string,
): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const remoteResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", cacheKey, "remote", "-v"],
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  const remotes = parseRemoteFetchUrls(remoteResult.value.stdout);
  const remote = pickPrimaryRemote(remotes);
  return remote
    ? buildRepositoryIdentity({ ...remote, originUrl: remotes.get("origin"), rootPath: cacheKey })
    : null;
});

/** The spawn failed because git is not installed (or not on PATH). */
function isCommandNotFound(error: ProcessRunner.ProcessRunError): boolean {
  if (error._tag !== "ProcessSpawnError") return false;
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 4 && typeof cause === "object" && cause !== null; depth++) {
    if ("code" in cause && cause.code === "ENOENT") return true;
    if ("reason" in cause && cause.reason === "NotFound") return true;
    cause = "cause" in cause ? cause.cause : undefined;
  }
  return false;
}

/** stderr's first line, or the exit code when git printed nothing. */
function gitFailureDetail(output: ProcessRunner.ProcessRunOutput): string {
  if (output.timedOut) return "git timed out";
  const line = output.stderr
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text.length > 0);
  return line ?? `git exited with code ${output.code ?? "unknown"}`;
}

const resolveRepositoryIdentityStrict = Effect.fn("RepositoryIdentityResolver.resolveStrict")(
  function* (
    cwd: string,
  ): Effect.fn.Return<
    RepositoryIdentity | null,
    RepositoryIdentityReadError,
    ProcessRunner.ProcessRunner
  > {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const fail = (detail: string) => new RepositoryIdentityReadError({ cwd, detail });
    const git = (args: ReadonlyArray<string>) =>
      processRunner
        .run({
          command: "git",
          args,
          // English messages, so "not a git repository" reads the same in every locale.
          env: { LC_ALL: "C" },
          timeoutBehavior: "timedOutResult",
        })
        .pipe(
          Effect.map((output) => ({ output, missing: false as const })),
          Effect.catch((error) =>
            isCommandNotFound(error)
              ? Effect.succeed({ output: null, missing: true as const })
              : Effect.fail(fail(error.message)),
          ),
        );
    const topLevel = yield* git(["-C", cwd, "rev-parse", "--show-toplevel"]);
    if (topLevel.missing) return null;
    const top = topLevel.output;
    if (top.timedOut || top.code !== 0) {
      if (!top.timedOut && /not a git repository/i.test(top.stderr)) return null;
      return yield* fail(gitFailureDetail(top));
    }
    const root = top.stdout.trim();
    if (root.length === 0) return null;
    const remoteResult = yield* git(["-C", root, "remote", "-v"]);
    if (remoteResult.missing) return null;
    const remote = remoteResult.output;
    if (remote.timedOut || remote.code !== 0) return yield* fail(gitFailureDetail(remote));
    const remotes = parseRemoteFetchUrls(remote.stdout);
    const primary = pickPrimaryRemote(remotes);
    return primary
      ? buildRepositoryIdentity({ ...primary, originUrl: remotes.get("origin"), rootPath: root })
      : null;
  },
);

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;
  const refine = options.refine ?? Effect.succeed;
  // Git errors and timeouts resolve to null, so they use the negative TTL like
  // "no repository" or "no remote". Only interrupts and defects skip the cache.
  const timeToLive = (exit: Exit.Exit<unknown>) =>
    Exit.match(exit, {
      onSuccess: (value) =>
        value === null
          ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
          : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
      onFailure: () => Duration.zero,
    });

  const cwdExists = options.cwdExists;
  const repositoryRootCache = yield* Cache.makeWith<string, string | null>(
    (cwd) =>
      (cwdExists === undefined ? Effect.succeed(true) : cwdExists(cwd)).pipe(
        Effect.flatMap((exists) =>
          exists
            ? resolveRepositoryIdentityCacheKey(cwd).pipe(
                Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
              )
            : Effect.succeed(null),
        ),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.filterOrElse(
          (identity): identity is null => identity === null,
          (identity) => refine(identity).pipe(Effect.orElseSucceed(() => identity)),
        ),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  // Untraced because almost every call is a cache hit. The lookups that spawn
  // git keep their own spans.
  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fnUntraced(
    function* (cwd, options) {
      if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
      const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
      if (cacheKey === null) return null;
      if (options?.refresh) yield* Cache.invalidate(repositoryIdentityCache, cacheKey);
      return yield* Cache.get(repositoryIdentityCache, cacheKey);
    },
  );

  const resolveStrict: NonNullable<RepositoryIdentityResolver["Service"]["resolveStrict"]> = (
    cwd,
  ) =>
    (cwdExists === undefined ? Effect.succeed(true) : cwdExists(cwd)).pipe(
      Effect.flatMap((exists) =>
        exists
          ? resolveRepositoryIdentityStrict(cwd).pipe(
              Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
              Effect.flatMap((identity) =>
                identity === null
                  ? Effect.succeed(null)
                  : refine(identity).pipe(Effect.orElseSucceed(() => identity)),
              ),
            )
          : Effect.succeed(null),
      ),
    );

  return RepositoryIdentityResolver.of({ resolve, resolveStrict });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
