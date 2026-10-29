import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  SourceControlProviderError,
  SourceControlRepositoryError,
  type SourceControlCloneRepositoryInput,
  type SourceControlCloneRepositoryResult,
  type SourceControlCloneProtocol,
  type SourceControlProviderKind,
  type SourceControlPublishRepositoryInput,
  type SourceControlPublishRepositoryResult,
  type SourceControlInspectDestinationInput,
  type SourceControlInspectDestinationResult,
  type SourceControlRemoteAccessInput,
  type SourceControlRemoteAccessResult,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryInfo,
  type SourceControlRepositoryLookupInput,
} from "@specweave-studio/contracts";

import * as ServerConfig from "../config.ts";
import { canonicalOrigin } from "../fleet/handoffGitTypes.ts";
import { expandHomePathWith } from "../pathExpansion.ts";
import {
  parseGitCloneProgressLine,
  type GitCloneProgressLine,
} from "../project/gitCloneProgress.ts";
import { originUrlFromConfig } from "../project/projectFingerprint.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as BitbucketApi from "./BitbucketApi.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import { cloneUrlForProtocol, cloneUrlProtocol } from "@specweave-studio/shared/cloneUrl";
const isSourceControlRepositoryError = Schema.is(SourceControlRepositoryError);
const isSourceControlProviderError = Schema.is(SourceControlProviderError);
const isGitCommandError = Schema.is(GitCommandError);
const isBitbucketRepositoryLocatorError = Schema.is(BitbucketApi.BitbucketRepositoryLocatorError);

export class SourceControlRepositoryService extends Context.Service<
  SourceControlRepositoryService,
  {
    readonly lookupRepository: (
      input: SourceControlRepositoryLookupInput,
    ) => Effect.Effect<SourceControlRepositoryInfo, SourceControlRepositoryError>;
    /**
     * Everything `cloneRepository` checks before running git: the resolved
     * remote, the normalized destination, and that the destination is empty.
     * Lets a caller create the project first and clone afterwards.
     */
    readonly prepareClone: (
      input: SourceControlCloneRepositoryInput,
    ) => Effect.Effect<SourceControlPreparedClone, SourceControlRepositoryError>;
    readonly cloneRepository: (
      input: SourceControlCloneRepositoryInput,
      options?: SourceControlCloneOptions,
    ) => Effect.Effect<SourceControlCloneRepositoryResult, SourceControlRepositoryError>;
    /**
     * `git ls-remote` against a URL with this machine's own credentials, never
     * prompting. Answers whether a clone here would get past sign-in; an SSH
     * URL whose key is refused is asked again in its HTTPS form, as a clone is.
     */
    readonly checkRemoteAccess: (
      input: SourceControlRemoteAccessInput,
    ) => Effect.Effect<SourceControlRemoteAccessResult, SourceControlRepositoryError>;
    /**
     * What a folder holds before a clone or a folder copy lands there. Reads
     * only the folder's own `.git`, never a parent's, and never runs Git.
     */
    readonly inspectDestination: (
      input: SourceControlInspectDestinationInput,
    ) => Effect.Effect<SourceControlInspectDestinationResult, SourceControlRepositoryError>;
    /**
     * Removes a partial or failed clone so the destination is empty again.
     * With `removeDestination` the emptied directory goes too: for a
     * destination the clone created whose project is being deleted.
     */
    readonly discardClone: (
      destinationPath: string,
      options?: SourceControlDiscardCloneOptions,
    ) => Effect.Effect<void, SourceControlRepositoryError>;
    readonly publishRepository: (
      input: SourceControlPublishRepositoryInput,
    ) => Effect.Effect<SourceControlPublishRepositoryResult, SourceControlRepositoryError>;
  }
>()("specweave-studio/sourceControl/SourceControlRepositoryService") {}

export interface SourceControlPreparedClone {
  readonly destinationPath: string;
  /** Credential-free; safe to show and to store in snapshots. */
  readonly remoteUrl: string;
  /** What git is given; may carry embedded credentials. */
  readonly cloneUrl: string;
  readonly repository: SourceControlRepositoryInfo | null;
  /** False when the destination did not exist, so the clone is what creates it. */
  readonly destinationExisted: boolean;
}

export interface SourceControlDiscardCloneOptions {
  readonly removeDestination?: boolean;
}

export interface SourceControlCloneOptions {
  readonly onProgress?: (line: GitCloneProgressLine) => Effect.Effect<void>;
  /** Overrides the default clone budget; `null` disables the deadline. */
  readonly timeoutMs?: number | null;
}

// The synchronous RPC (older clients, mobile) keeps a deadline: nothing else
// tells the user a clone stalled. The tracked path passes null and relies on
// progress and Cancel instead.
const CLONE_TIMEOUT_MS = 120_000;
const CLONE_ENV = {
  // `--progress` forces the transfer counters through the pipe; the delay env
  // makes the checkout counter start immediately. No tty means a credential
  // prompt would hang forever, so tell git to fail instead.
  GIT_PROGRESS_DELAY: "0",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
} satisfies NodeJS.ProcessEnv;

function mapRepositoryError(operation: string, provider: SourceControlProviderKind) {
  return Effect.mapError((cause: unknown) =>
    isSourceControlRepositoryError(cause)
      ? cause
      : new SourceControlRepositoryError({
          operation,
          provider,
          detail:
            isSourceControlProviderError(cause) &&
            cause.provider === "bitbucket" &&
            isBitbucketRepositoryLocatorError(cause.cause)
              ? BitbucketApi.BitbucketRepositoryLocatorError.detail
              : "The source control operation could not be completed.",
          cause,
        }),
  );
}

function toRepositoryInfo(
  provider: SourceControlProviderKind,
  urls: SourceControlRepositoryCloneUrls,
): SourceControlRepositoryInfo {
  return {
    provider,
    nameWithOwner: urls.nameWithOwner,
    url: urls.url,
    sshUrl: urls.sshUrl,
  };
}

/**
 * The URL clients see. A pasted `https://user:token@host/…` must not travel
 * back over `subscribeProjectClones` to every reader; git still gets the
 * original.
 */
function redactRemoteUrl(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    // Clone URLs have no legitimate query; when one is present it is a token.
    if (url.username.length === 0 && url.password.length === 0 && url.search.length === 0) {
      return remoteUrl;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

// Userinfo may itself contain `@`; everything up to the last one before the
// host boundary goes.
const URL_WITH_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/gi;

/** Drops `user:token@` from any URL embedded in free text. */
function redactUrlCredentials(text: string): string {
  return text.replace(URL_WITH_USERINFO, "$1");
}

const REMOTE_ACCESS_TIMEOUT_MS = 20_000;
// No tty: every prompt (password, passphrase, host key, credential manager)
// must fail at once instead of hanging the check.
const REMOTE_ACCESS_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  LC_ALL: "C",
} satisfies NodeJS.ProcessEnv;

/** Canonical origins of one repository; hosted paths compare without case, local paths exactly. */
export function sameOrigin(left: string, right: string): boolean {
  if (left.startsWith("file://") || right.startsWith("file://")) return left === right;
  return left.toLowerCase() === right.toLowerCase();
}

/** Transports that run commands (`ext::`, `fd::`) or URLs git would read as options. */
export function isUnsafeRemoteUrl(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  return (
    trimmed.length === 0 ||
    trimmed.startsWith("-") ||
    /^(ext|fd)::/i.test(trimmed) ||
    /[\0\r\n]/.test(trimmed)
  );
}

/** Git's last meaningful lines, credential-free, for a person to read. */
export function remoteAccessDetail(stderr: string): string | null {
  const text = redactUrlCredentials(stderr)
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g, "[redacted]")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" ")
    .slice(0, 1000);
  return text.length > 0 ? text : null;
}

/**
 * Adding a project clones over SSH for most hosts, and a machine with no SSH
 * key there would fail every time, while the host's HTTPS credential helper
 * may be set up. A clone whose SSH login was refused is retried once over
 * HTTPS, unless the caller asked for SSH. A looked-up repository has the
 * provider's own HTTPS URL; any other URL is rewritten, which is refused
 * where it would have to guess (a custom port).
 */
function httpsFallbackUrl(
  input: SourceControlCloneRepositoryInput,
  prepared: SourceControlPreparedClone,
): string | null {
  if (input.protocol === "ssh" || cloneUrlProtocol(prepared.cloneUrl) !== "ssh") return null;
  if (prepared.repository?.sshUrl === prepared.cloneUrl) return prepared.repository.url;
  return cloneUrlForProtocol(prepared.cloneUrl, "https");
}

const isSshRejection = (error: SourceControlRepositoryError) =>
  isGitCommandError(error.cause) &&
  (error.cause.reason === "authentication_failed" || error.cause.reason === "host_key_unverified");

function selectRemoteUrl(
  urls: SourceControlRepositoryCloneUrls,
  protocol: SourceControlCloneProtocol | undefined,
): string {
  switch (protocol ?? "auto") {
    case "https":
      return urls.url;
    case "ssh":
    case "auto":
      return urls.sshUrl;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const path = yield* Path.Path;
  const providers = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const ensureConcreteProvider = (input: {
    readonly operation: string;
    readonly provider: SourceControlProviderKind;
  }) => {
    if (input.provider !== "unknown") {
      return Effect.succeed(input.provider);
    }

    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  };

  const lookupRepository = Effect.fn("SourceControlRepositoryService.lookupRepository")(function* (
    input: SourceControlRepositoryLookupInput,
  ) {
    const providerKind = yield* ensureConcreteProvider({
      operation: "lookupRepository",
      provider: input.provider,
    });
    const provider = yield* providers.get(providerKind);
    const urls = yield* provider.getRepositoryCloneUrls({
      cwd: input.cwd ?? config.cwd,
      repository: input.repository.trim(),
    });
    return toRepositoryInfo(providerKind, urls);
  });

  const normalizeDestinationPath = Effect.fn("SourceControlRepositoryService.normalizeDestination")(
    function* (destinationPath: string) {
      const trimmed = destinationPath.trim();
      if (trimmed.length === 0) {
        return yield* new SourceControlRepositoryError({
          operation: "cloneRepository",
          provider: "unknown",
          detail: "Choose a destination path before cloning.",
        });
      }

      return path.resolve(expandHomePathWith(trimmed, path));
    },
  );

  const prepareDestination = Effect.fn("SourceControlRepositoryService.prepareDestination")(
    function* (destinationPath: string) {
      const normalizedDestination = yield* normalizeDestinationPath(destinationPath);
      const existed = yield* fileSystem.exists(normalizedDestination);
      if (existed) {
        const entries = yield* fileSystem
          .readDirectory(normalizedDestination, { recursive: false })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlRepositoryError({
                  operation: "cloneRepository",
                  provider: "unknown",
                  detail: "Destination path already exists and is not a directory.",
                  cause,
                }),
            ),
          );
        if (entries.length > 0) {
          return yield* new SourceControlRepositoryError({
            operation: "cloneRepository",
            provider: "unknown",
            detail: "Destination path already exists and is not empty.",
          });
        }
      } else {
        yield* fileSystem.makeDirectory(path.dirname(normalizedDestination), { recursive: true });
      }

      return {
        destinationPath: normalizedDestination,
        parentPath: path.dirname(normalizedDestination),
        directoryName: path.basename(normalizedDestination),
        existed,
      };
    },
  );

  const prepareClone = Effect.fn("SourceControlRepositoryService.prepareClone")(function* (
    input: SourceControlCloneRepositoryInput,
  ) {
    const preparedDestination = yield* prepareDestination(input.destinationPath);
    let repository: SourceControlRepositoryInfo | null = null;
    let remoteUrl = input.remoteUrl?.trim() ?? null;
    let provider: SourceControlProviderKind = input.provider ?? "unknown";

    if (input.provider && input.repository) {
      repository = yield* lookupRepository({
        provider: input.provider,
        repository: input.repository,
        cwd: preparedDestination.parentPath,
      });
      remoteUrl = selectRemoteUrl(repository, input.protocol);
      provider = input.provider;
    }

    if (!remoteUrl) {
      return yield* new SourceControlRepositoryError({
        operation: "cloneRepository",
        provider,
        detail: "Enter a repository path or clone URL before cloning.",
      });
    }

    return {
      destinationPath: preparedDestination.destinationPath,
      destinationExisted: preparedDestination.existed,
      remoteUrl: redactRemoteUrl(remoteUrl),
      cloneUrl: remoteUrl,
      repository,
    } satisfies SourceControlPreparedClone;
  });

  const runClone = Effect.fn("SourceControlRepositoryService.runClone")(function* (
    input: SourceControlCloneRepositoryInput,
    destinationPath: string,
    cloneUrl: string,
    options?: SourceControlCloneOptions,
  ) {
    const onProgress = options?.onProgress;
    // Git interleaves progress redraws with its real messages on stderr. The
    // last non-progress lines are what explain a failure ("Repository not
    // found", "Permission denied"), so keep them for the error detail.
    const stderrTail: Array<string> = [];
    const onStderrLine = (line: string) => {
      const parsed = parseGitCloneProgressLine(line);
      if (parsed) return onProgress ? onProgress(parsed) : Effect.void;
      return Effect.sync(() => {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("Cloning into")) return;
        // Git echoes the remote in some failures; the tail becomes user-facing text.
        stderrTail.push(redactUrlCredentials(trimmed));
        if (stderrTail.length > 4) stderrTail.shift();
      });
    };
    yield* git
      .execute({
        operation: "SourceControlRepositoryService.cloneRepository",
        cwd: path.dirname(destinationPath),
        args: ["clone", "--progress", "--", cloneUrl, path.basename(destinationPath)],
        timeoutMs: options?.timeoutMs === undefined ? CLONE_TIMEOUT_MS : options.timeoutMs,
        // Progress redraws add up on a slow multi-GB clone. The buffered copy
        // is never read (the tail is kept by hand above), so keep it small
        // and let the line callbacks keep flowing past the cap.
        maxOutputBytes: 256 * 1024,
        appendTruncationMarker: true,
        keepLineCallbacksAfterTruncation: true,
        env: CLONE_ENV,
        progress: { onStderrLine },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              operation: "cloneRepository",
              provider: input.provider ?? "unknown",
              detail:
                stderrTail.length > 0
                  ? stderrTail.join(" ")
                  : "The repository could not be cloned.",
              cause,
            }),
        ),
      );
  });

  const cloneRepository = Effect.fn("SourceControlRepositoryService.cloneRepository")(function* (
    input: SourceControlCloneRepositoryInput,
    options?: SourceControlCloneOptions,
  ) {
    const prepared = yield* prepareClone(input);
    const httpsUrl = httpsFallbackUrl(input, prepared);
    const remoteUrl = yield* runClone(
      input,
      prepared.destinationPath,
      prepared.cloneUrl,
      options,
    ).pipe(
      Effect.as(prepared.remoteUrl),
      Effect.catch((sshError) =>
        httpsUrl === null || !isSshRejection(sshError)
          ? Effect.fail(sshError)
          : runClone(input, prepared.destinationPath, httpsUrl, options).pipe(
              // The clone's own remote is the HTTPS URL now; report that one.
              Effect.as(redactRemoteUrl(httpsUrl)),
              Effect.mapError(
                (httpsError) =>
                  new SourceControlRepositoryError({
                    operation: "cloneRepository",
                    provider: sshError.provider,
                    detail: `${sshError.detail} Cloning over HTTPS instead also failed: ${httpsError.detail}`,
                    cause: httpsError.cause,
                  }),
              ),
            ),
      ),
    );

    return {
      cwd: prepared.destinationPath,
      remoteUrl,
      repository: prepared.repository,
    };
  });

  /** One `git ls-remote` against `remoteUrl`, never prompting. */
  const probeRemoteAccess = Effect.fn("SourceControlRepositoryService.probeRemoteAccess")(
    function* (remoteUrl: string) {
      const sshCommand = globalThis.process.env.GIT_SSH_COMMAND
        ? {}
        : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=10" };
      return yield* git
        .execute({
          operation: "SourceControlRepositoryService.checkRemoteAccess",
          cwd: config.cwd,
          args: ["ls-remote", "--heads", "--quiet", "--", remoteUrl],
          env: { ...REMOTE_ACCESS_ENV, ...sshCommand },
          allowNonZeroExit: true,
          timeoutMs: REMOTE_ACCESS_TIMEOUT_MS,
          maxOutputBytes: 64 * 1024,
          appendTruncationMarker: true,
        })
        .pipe(
          Effect.map((result): SourceControlRemoteAccessResult =>
            result.exitCode === 0
              ? { status: "ok", detail: null }
              : { status: "no-access", detail: remoteAccessDetail(result.stderr) },
          ),
          Effect.catch((cause) =>
            Effect.succeed<SourceControlRemoteAccessResult>(
              cause.detail === "Git command timed out."
                ? {
                    status: "timeout",
                    detail: "The remote did not answer within 20 seconds.",
                  }
                : { status: "error", detail: "git could not run on this machine." },
            ),
          ),
        );
    },
  );

  const checkRemoteAccess = Effect.fn("SourceControlRepositoryService.checkRemoteAccess")(
    function* (input: SourceControlRemoteAccessInput) {
      const remoteUrl = input.remoteUrl.trim();
      if (isUnsafeRemoteUrl(remoteUrl)) {
        return yield* new SourceControlRepositoryError({
          operation: "checkRemoteAccess",
          provider: "unknown",
          detail: "That clone URL is not allowed.",
        });
      }
      const first = yield* probeRemoteAccess(remoteUrl);
      if (first.status !== "no-access" || cloneUrlProtocol(remoteUrl) !== "ssh") return first;
      // A clone retries over HTTPS when the SSH key is refused (cloneRepository),
      // so the precheck asks the same question: does either form answer? A
      // timeout is not retried; the network, not the key, is what failed.
      const httpsUrl = cloneUrlForProtocol(remoteUrl, "https");
      if (httpsUrl === null) return first;
      const https = yield* probeRemoteAccess(httpsUrl);
      return https.status === "ok" ? https : first;
    },
  );

  /** The Git config of `folder`'s own `.git` (a directory, or a worktree's `gitdir:` file). */
  const ownGitConfig = (folder: string) =>
    Effect.gen(function* () {
      const dotGit = path.join(folder, ".git");
      const info = yield* fileSystem.stat(dotGit);
      if (info.type === "Directory")
        return yield* fileSystem.readFileString(path.join(dotGit, "config"));
      const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(yield* fileSystem.readFileString(dotGit))?.[1];
      if (!pointer) return null;
      const gitDir = path.resolve(folder, pointer);
      const common = yield* fileSystem
        .readFileString(path.join(gitDir, "commondir"))
        .pipe(Effect.orElseSucceed(() => ""));
      const commonDir = common.trim() ? path.resolve(gitDir, common.trim()) : gitDir;
      return yield* fileSystem.readFileString(path.join(commonDir, "config"));
    }).pipe(Effect.orElseSucceed(() => null));

  /** HEAD names a commit, the index exists and no git process holds its lock. */
  const isCheckedOut = (folder: string) =>
    Effect.gen(function* () {
      const run = (operation: string, args: ReadonlyArray<string>) =>
        git.execute({
          operation: `SourceControlRepositoryService.inspectDestination.${operation}`,
          cwd: folder,
          args: [...args],
          allowNonZeroExit: true,
          timeoutMs: 10_000,
          maxOutputBytes: 16 * 1024,
        });
      const head = yield* run("head", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
      if (head.exitCode !== 0) return false;
      const paths = yield* run("index", [
        "rev-parse",
        "--git-path",
        "index",
        "--git-path",
        "index.lock",
      ]);
      const [index, lock] = paths.stdout.split("\n").map((line) => line.trim());
      if (paths.exitCode !== 0 || !index || !lock) return false;
      const exists = (file: string) =>
        fileSystem.exists(path.resolve(folder, file)).pipe(Effect.orElseSucceed(() => false));
      return (yield* exists(index)) && !(yield* exists(lock));
    }).pipe(Effect.orElseSucceed(() => false));

  const inspectDestination = Effect.fn("SourceControlRepositoryService.inspectDestination")(
    function* (input: SourceControlInspectDestinationInput) {
      const target = path.resolve(expandHomePathWith(input.path.trim(), path));
      const wanted = input.remoteUrl ? canonicalOrigin(input.remoteUrl.trim()) : null;
      const result = (
        state: SourceControlInspectDestinationResult["state"],
        originKey: string | null = null,
        checkedOut = false,
      ): SourceControlInspectDestinationResult => ({
        path: target,
        state,
        originKey,
        sameRepository: wanted !== null && originKey !== null && sameOrigin(wanted, originKey),
        checkedOut,
      });
      if (!path.isAbsolute(target)) return result("unreadable");
      if (!(yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))))
        return result("missing");
      const entries = yield* fileSystem
        .readDirectory(target, { recursive: false })
        .pipe(Effect.orElseSucceed(() => null));
      if (entries === null) return result("unreadable");
      if (entries.length === 0) return result("empty");
      if (!entries.includes(".git")) return result("not-repository");
      const config = yield* ownGitConfig(target);
      if (config === null) return result("not-repository");
      const url = originUrlFromConfig(config);
      return result(
        "repository",
        url === null ? null : canonicalOrigin(url),
        yield* isCheckedOut(target),
      );
    },
  );

  const discardClone = Effect.fn("SourceControlRepositoryService.discardClone")(function* (
    destinationPath: string,
    options?: SourceControlDiscardCloneOptions,
  ) {
    const normalized = yield* normalizeDestinationPath(destinationPath);
    // Only what git left behind may go. The destination was empty when the
    // clone started, so anything without a `.git` inside was put there by
    // someone else since; refuse rather than delete their files.
    // A missing destination is already discarded; any other read failure
    // (a file in its place, permissions) is not something to remove through.
    const entries = yield* fileSystem.readDirectory(normalized).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed<ReadonlyArray<string>>([]),
      ),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: "unknown",
            detail: "The clone destination could not be inspected.",
            cause,
          }),
      ),
    );
    if (entries.length > 0 && !entries.includes(".git")) {
      return yield* new SourceControlRepositoryError({
        operation: "discardClone",
        provider: "unknown",
        detail: "Destination path contains files that are not from the clone.",
      });
    }
    // The directory itself is the project's workspace root and stays unless
    // the caller says the clone created it and the project is going away;
    // only git's partial contents go. An interrupted git may still be closing
    // files, so removal retries briefly.
    yield* fileSystem.remove(normalized, { recursive: true, force: true }).pipe(
      Effect.andThen(
        options?.removeDestination
          ? Effect.void
          : fileSystem.makeDirectory(normalized, { recursive: true }),
      ),
      Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 5 }),
      Effect.mapError(
        (cause) =>
          new SourceControlRepositoryError({
            operation: "discardClone",
            provider: "unknown",
            detail: "The partial clone could not be removed.",
            cause,
          }),
      ),
    );
  });

  const publishRepository = Effect.fn("SourceControlRepositoryService.publishRepository")(
    function* (input: SourceControlPublishRepositoryInput) {
      const providerKind = yield* ensureConcreteProvider({
        operation: "publishRepository",
        provider: input.provider,
      });
      const provider = yield* providers.get(providerKind);
      const urls = yield* provider.createRepository({
        cwd: input.cwd,
        repository: input.repository.trim(),
        visibility: input.visibility,
      });
      const remoteUrl = selectRemoteUrl(urls, input.protocol);
      const remoteName = yield* git.ensureRemote({
        cwd: input.cwd,
        preferredName: input.remoteName?.trim() || "origin",
        url: remoteUrl,
      });

      // An empty local repo (no commits) would make `git push HEAD:...` fail
      // with an opaque "src refspec HEAD does not match any". Treat this as a
      // partial success: the remote was created and wired up, but there is
      // nothing to push yet.
      const hasCommits = yield* git
        .execute({
          operation: "SourceControlRepositoryService.publishRepository.headCheck",
          cwd: input.cwd,
          args: ["rev-parse", "--verify", "HEAD"],
        })
        .pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        );
      if (!hasCommits) {
        const details = yield* git.statusDetails(input.cwd).pipe(Effect.orElseSucceed(() => null));
        return {
          repository: toRepositoryInfo(providerKind, urls),
          remoteName,
          remoteUrl,
          branch: details?.branch ?? "main",
          status: "remote_added" as const,
        };
      }

      const pushResult = yield* git.pushCurrentBranch(input.cwd, null, { remoteName });

      return {
        repository: toRepositoryInfo(providerKind, urls),
        remoteName,
        remoteUrl,
        branch: pushResult.branch,
        ...(pushResult.upstreamBranch ? { upstreamBranch: pushResult.upstreamBranch } : {}),
        status: "pushed" as const,
      };
    },
  );

  return SourceControlRepositoryService.of({
    lookupRepository: (input) =>
      lookupRepository(input).pipe(mapRepositoryError("lookupRepository", input.provider)),
    prepareClone: (input) =>
      prepareClone(input).pipe(mapRepositoryError("cloneRepository", input.provider ?? "unknown")),
    cloneRepository: (input, options) =>
      cloneRepository(input, options).pipe(
        mapRepositoryError("cloneRepository", input.provider ?? "unknown"),
      ),
    checkRemoteAccess: (input) =>
      checkRemoteAccess(input).pipe(mapRepositoryError("checkRemoteAccess", "unknown")),
    inspectDestination: (input) =>
      inspectDestination(input).pipe(mapRepositoryError("inspectDestination", "unknown")),
    discardClone: (destinationPath, options) =>
      discardClone(destinationPath, options).pipe(mapRepositoryError("discardClone", "unknown")),
    publishRepository: (input) =>
      publishRepository(input).pipe(mapRepositoryError("publishRepository", input.provider)),
  });
});

export const layer = Layer.effect(SourceControlRepositoryService, make);

// The clone pre-checks register in ws.ts as single handlers, like `PullRequestCheckFailureLogRpc`:
// more methods in the core group's `toLayer` trip TypeScript's instantiation limit. They live here
// because a new import in ws.ts reorders its checking and trips the same limit.

/** `sourceControl.checkRemoteAccess`: can this machine read the remote? */
export const checkRemoteAccessHandler = Effect.gen(function* () {
  const repositories = yield* SourceControlRepositoryService;
  return repositories.checkRemoteAccess;
});

/** `sourceControl.inspectDestination`: what is already at a clone destination? */
export const inspectDestinationHandler = Effect.gen(function* () {
  const repositories = yield* SourceControlRepositoryService;
  return repositories.inspectDestination;
});
