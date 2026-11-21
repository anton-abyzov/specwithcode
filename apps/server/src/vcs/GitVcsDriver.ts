import * as NodeBuffer from "node:buffer";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  VcsProcessExitError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
  type WorktreeSubmodules,
} from "@specweave-studio/contracts";
import { STUDIO_NAME } from "@specweave-studio/shared/studioIdentity";
import {
  makeGitVcsDriverCore,
  PATCH_RENDER_PREFIX_ARGS,
  splitNullSeparatedGitStdoutPaths,
} from "./GitVcsDriverCore.ts";
import {
  checkpointHeadOid,
  checkpointIgnoredPaths,
  checkpointMessage,
  headMoveOnlyPaths,
  localCommitsSince,
  parseCommitPaths,
} from "../checkpointing/headMoveAttribution.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

/**
 * Address of the commits Studio makes under its own name: checkpoints, and a
 * stack rebase on a host with no git identity. The reserved `.invalid` domain
 * cannot receive mail.
 */
export const STUDIO_GIT_EMAIL = "noreply@specweave-studio.invalid";

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number | null;
  readonly maxOutputBytes?: number;
  readonly appendTruncationMarker?: boolean;
  /**
   * With `appendTruncationMarker`, keep invoking the line callbacks after the
   * buffered copy is full. For long-running commands whose output is only
   * consumed through `progress`.
   */
  readonly keepLineCallbacksAfterTruncation?: boolean;
  readonly progress?: ExecuteGitProgress;
  /** Writes .git/config, which every worktree shares and Git locks without waiting. */
  readonly writesSharedConfig?: boolean;
}

export interface ExecuteGitResult {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface GitStatusDetails {
  isRepo: boolean;
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasWorkingTreeChanges: boolean;
  workingTree: VcsStatusResult["workingTree"];
  branchChanges?: VcsStatusResult["branchChanges"];
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitLocalStatusOptions {
  /** Skip revision walks and return zero divergence counts for local-only consumers. */
  readonly includeDivergence?: boolean;
  /** Also read the diff panel's Changes totals. Failures leave them out. */
  readonly includeBranchChanges?: boolean;
}

export interface GitRemoteStatusDetails {
  isRepo: boolean;
  defaultBranch: string | null;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

/**
 * Progress callbacks for `createWorktree`. Git prints `Updating files: 78% (2104/2700)`
 * to stderr during checkout, and `Submodule path 'x': checked out` during
 * submodule init. The tracker uses these to drive the worktree setup card.
 */
export interface CreateWorktreeProgress {
  /**
   * Fires once `git worktree add` has created and registered the directory,
   * before the (possibly long) submodule step. Git refuses an existing path,
   * so a path reported here belongs to this call and is safe to remove on
   * cancel.
   */
  readonly onWorktreeClaimed?: (path: string) => Effect.Effect<void, never>;
  readonly onCheckoutProgress?: (input: {
    percent: number;
    completed: number;
    total: number;
  }) => Effect.Effect<void, never>;
  readonly onSubmodulesStarted?: () => Effect.Effect<void, never>;
  /** Fires when `.gitmodules` exists but the resolved submodule mode is `"none"`. */
  readonly onSubmodulesDisabled?: (input: {
    source: "settings" | "specweave-studio.json";
  }) => Effect.Effect<void, never>;
  readonly onSubmoduleLine?: (line: string) => Effect.Effect<void, never>;
  readonly onSubmodulesFinished?: (input: {
    ok: boolean;
    detail: string | null;
  }) => Effect.Effect<void, never>;
}

export interface CreateWorktreeOptions {
  readonly progress?: CreateWorktreeProgress;
  /**
   * The project-over-environment `worktreeSubmodules` setting. Null (or
   * omitted, for callers without settings access) defers to the checkout's
   * own specweave-studio.json.
   */
  readonly submodules?: WorktreeSubmodules | null;
  /** The `worktreesDirectory` setting, used when the input has no explicit path. */
  readonly worktreesDirectory?: string;
  readonly worktreeLocationMode?: "managed" | "project" | "custom";
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number;
  readonly progress?: GitCommitProgress;
  /** Stage the current working tree immediately before committing. */
  readonly stage?: { readonly filePaths?: readonly string[] };
}

export interface GitDeleteLocalBranchInput {
  readonly cwd: string;
  readonly refName: string;
  readonly force?: boolean;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitRenameBranchInput {
  /** Fail on a name collision instead of appending a numeric suffix. */
  exactName?: boolean;
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitFetchPullRequestBranchInput {
  cwd: string;
  prNumber: number;
  branch: string;
}

export interface GitFetchPullRequestHeadCommitInput {
  cwd: string;
  prNumber: number;
}

export interface GitResolveCommitInput {
  cwd: string;
  revision: string;
}

export interface GitResolveCommitResult {
  commitSha: string;
}

export interface GitRefreshCheckedOutBranchInput {
  cwd: string;
  targetCommit: string;
  /**
   * Commit the checkout is allowed to be hard-reset away from: the upstream commit read before
   * the fetch. HEAD sitting there means the checkout holds no work of its own.
   */
  resetWhenHeadCommit?: string | null | undefined;
}

export interface GitRefreshCheckedOutBranchResult {
  headCommit: string;
  moved: boolean;
  onTarget: boolean;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitFetchRemoteTrackingBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitFetchRemoteInput {
  cwd: string;
  remoteName: string;
  refName?: string;
}

export interface GitRemoteExistsInput {
  cwd: string;
  remoteName: string;
}

export interface GitRemoteBranchExistsInput extends GitRemoteExistsInput {
  refName: string;
}

export interface GitResolveRemoteTrackingCommitInput {
  cwd: string;
  refName: string;
  fallbackRemoteName: string;
}

export interface GitResolveRemoteTrackingCommitResult {
  commitSha: string;
  remoteRefName: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitRemoteStatusOptions {
  readonly refreshUpstream?: boolean;
}

export class GitVcsDriver extends Context.Service<
  GitVcsDriver,
  {
    readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
    readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>;
    readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsLocal: (
      cwd: string,
      options?: GitLocalStatusOptions,
    ) => Effect.Effect<GitStatusDetails, GitCommandError>;
    readonly statusDetailsRemote: (
      cwd: string,
      options?: GitRemoteStatusOptions,
    ) => Effect.Effect<GitRemoteStatusDetails, GitCommandError>;
    readonly prepareCommitContext: (
      cwd: string,
      filePaths?: readonly string[],
    ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
    readonly commit: (
      cwd: string,
      subject: string,
      body: string,
      options?: GitCommitOptions,
    ) => Effect.Effect<{ commitSha: string }, GitCommandError>;
    readonly pushCurrentBranch: (
      cwd: string,
      fallbackBranch: string | null,
      options?: { readonly remoteName?: string | null },
    ) => Effect.Effect<GitPushResult, GitCommandError>;
    readonly readRangeContext: (
      cwd: string,
      baseRef: string,
    ) => Effect.Effect<GitRangeContext, GitCommandError>;
    /** False only when `baseRef` and HEAD provably share no commit (complete history). */
    readonly sharesHistoryWithHead: (cwd: string, baseRef: string) => Effect.Effect<boolean>;
    readonly getReviewDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, GitCommandError>;
    readonly getReviewDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, GitCommandError>;
    readonly readConfigValue: (
      cwd: string,
      key: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
      options?: CreateWorktreeOptions,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly fetchPullRequestBranch: (
      input: GitFetchPullRequestBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    /** Fetches `refs/pull/<n>/head` without writing a branch, for heads that exist nowhere else. */
    readonly fetchPullRequestHeadCommit: (
      input: GitFetchPullRequestHeadCommitInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    readonly resolveCommit: (
      input: GitResolveCommitInput,
    ) => Effect.Effect<GitResolveCommitResult, GitCommandError>;
    /** Moves the branch checked out in `cwd` onto `targetCommit`, from inside that worktree. */
    readonly refreshCheckedOutBranch: (
      input: GitRefreshCheckedOutBranchInput,
    ) => Effect.Effect<GitRefreshCheckedOutBranchResult, GitCommandError>;
    readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;
    readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
    readonly resolveDefaultBranchName: (
      cwd: string,
      remoteName: string,
    ) => Effect.Effect<string | null, GitCommandError>;
    readonly fetchRemote: (input: GitFetchRemoteInput) => Effect.Effect<void, GitCommandError>;
    readonly remoteExists: (input: GitRemoteExistsInput) => Effect.Effect<boolean, GitCommandError>;
    readonly remoteBranchExists: (
      input: GitRemoteBranchExistsInput,
    ) => Effect.Effect<boolean, GitCommandError>;
    readonly resolveRemoteTrackingCommit: (
      input: GitResolveRemoteTrackingCommitInput,
    ) => Effect.Effect<GitResolveRemoteTrackingCommitResult, GitCommandError>;
    readonly fetchRemoteBranch: (
      input: GitFetchRemoteBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly fetchRemoteTrackingBranch: (
      input: GitFetchRemoteTrackingBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly setBranchUpstream: (
      input: GitSetBranchUpstreamInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput & {
        /**
         * Git can drop a worktree's registration and still fail to delete its
         * files. By default the folder is then deleted, since a person asked
         * for the removal. Unattended cleanup sets this: files Git left are
         * files nobody checked, so they stay and the call fails.
         */
        readonly keepLeftBehind?: boolean;
      },
    ) => Effect.Effect<void, GitCommandError>;
    /** Drops worktree admin entries whose directory is already gone (`git worktree prune`). */
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    /**
     * Absolute paths of every live worktree of the repository at `cwd`, the
     * main checkout included. Worktrees whose directory is gone are left out.
     */
    readonly listWorktreePaths: (cwd: string) => Effect.Effect<string[], GitCommandError>;
    readonly deleteLocalBranch: (
      input: GitDeleteLocalBranchInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly renameBranch: (
      input: GitRenameBranchInput,
    ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
    /** Create without implicit tracking writes, then record tracking with retry. */
    readonly createBranch: (input: {
      readonly cwd: string;
      readonly branch: string;
      readonly startPoint: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly initRepo: (input: VcsInitInput) => Effect.Effect<void, GitCommandError>;
    readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
  }
>()("specweave-studio/vcs/GitVcsDriver") {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_RECOVERY_MAX_CANDIDATES = 64;
const CHECKPOINT_RECOVERY_TIMEOUT = "5 seconds";
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
// Larger pre-turn ignored lists are not recorded; Revert then cleans only once.
const CHECKPOINT_IGNORED_MAX_BYTES = 512 * 1024;
// Exposed ignored paths are passed to git clean as arguments.
const CHECKPOINT_EXCLUDES_MAX_CHARS = 16 * 1024;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function chunkPathsForGitCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

function parseGitRemoteVerboseOutput(
  output: string,
): Map<string, { url?: string; pushUrl?: string }> {
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
    const match = /^(\S+)\s+(.+)\s+\((fetch|push)\)(?:\s+\[[^[\]\r\n]+\])?$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const name = match[1];
    const url = match[2];
    const direction = match[3];
    if (!name || !url || !direction) {
      continue;
    }
    const remote = remotes.get(name) ?? {};
    if (direction === "fetch") {
      remote.url = url;
    } else {
      remote.pushUrl = url;
    }
    remotes.set(name, remote);
  }
  return remotes;
}

const gitCommand = (
  process: VcsProcess.VcsProcess["Service"],
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly outputMode?: VcsProcess.VcsProcessInput["outputMode"];
    readonly appendTruncationMarker?: boolean;
  },
) =>
  process.run({
    operation,
    command: "git",
    args: ["-C", cwd, ...args],
    cwd,
    spawnCwd: globalThis.process.cwd(),
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
    ...(options?.appendTruncationMarker !== undefined
      ? { appendTruncationMarker: options.appendTruncationMarker }
      : {}),
  });

/**
 * Whether `git clean` output lists a path inside the workspace. Git for Windows removes an
 * emptied nested workspace directory itself and lists it as "./". The restore recreates
 * that directory, so a pass that removed only it made no progress. A dry run lists "./"
 * alone for a workspace it could remove whole, so there the caller also checks for files.
 */
export const gitCleanListsWorkspacePath = (
  stdout: string,
  verb: "Removing" | "Would remove",
): boolean =>
  stdout.split("\n").some((line) => {
    if (!line.startsWith(`${verb} `)) return false;
    const listed = line.slice(verb.length + 1).replace(/\r$/, "");
    return listed !== "./" && listed !== ".";
  });

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const crypto = yield* Crypto.Crypto;
  const capabilities = {
    kind: "git" as const,
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "native" as const,
  };

  const isInsideWorkTree: VcsDriver.VcsDriver["Service"]["isInsideWorkTree"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.isInsideWorkTree",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"));

  const execute: VcsDriver.VcsDriver["Service"]["execute"] = (input) =>
    gitCommand(vcsProcess, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
      ...(input.appendTruncationMarker !== undefined
        ? { appendTruncationMarker: input.appendTruncationMarker }
        : {}),
    });

  const detectRepository: VcsDriver.VcsDriver["Service"]["detectRepository"] = Effect.fn(
    "detectRepository",
  )(function* (cwd) {
    if (!(yield* isInsideWorkTree(cwd))) {
      return null;
    }

    const root = yield* gitCommand(vcsProcess, "GitVcsDriver.detectRepository.root", cwd, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const gitCommonDir = yield* gitCommand(
      vcsProcess,
      "GitVcsDriver.detectRepository.commonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
    ).pipe(Effect.orElseSucceed(() => null));

    return {
      kind: "git" as const,
      rootPath: root.stdout.trim(),
      metadataPath: gitCommonDir?.stdout.trim() || null,
      freshness: yield* nowFreshness(),
    };
  });

  const listWorkspaceFiles: VcsDriver.VcsDriver["Service"]["listWorkspaceFiles"] = (cwd) =>
    gitCommand(
      vcsProcess,
      "GitVcsDriver.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        appendTruncationMarker: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              const freshness = yield* nowFreshness();
              return {
                paths: splitNullSeparatedGitStdoutPaths(result),
                truncated: result.stdoutTruncated,
                freshness,
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listWorkspaceFiles",
                command: "git ls-files",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );

  const listRemotes: VcsDriver.VcsDriver["Service"]["listRemotes"] = Effect.fn("listRemotes")(
    function* (cwd) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.listRemotes",
        cwd,
        ["remote", "-v"],
        {
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64 * 1024,
        },
      );

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.listRemotes",
          command: "git remote -v",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git remote -v failed",
        });
      }

      const parsed = parseGitRemoteVerboseOutput(result.stdout);
      const remotes = Array.from(parsed.entries()).flatMap(([name, remote]) => {
        if (!remote.url) {
          return [];
        }
        return [
          {
            name,
            url: remote.url,
            pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none(),
            isPrimary: name === "origin",
          },
        ];
      });

      return {
        remotes,
        freshness: yield* nowFreshness(),
      };
    },
  );

  const filterIgnoredPaths: VcsDriver.VcsDriver["Service"]["filterIgnoredPaths"] = Effect.fn(
    "filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const ignoredPaths = new Set<string>();
    const chunks = chunkPathsForGitCheckIgnore(relativePaths);

    for (const chunk of chunks) {
      const result = yield* gitCommand(
        vcsProcess,
        "GitVcsDriver.filterIgnoredPaths",
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: 20_000,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          appendTruncationMarker: true,
        },
      );

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.filterIgnoredPaths",
          command: "git check-ignore",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git check-ignore failed",
        });
      }

      for (const ignoredPath of splitNullSeparatedGitStdoutPaths(result)) {
        ignoredPaths.add(ignoredPath);
      }
    }

    if (ignoredPaths.size === 0) {
      return relativePaths;
    }

    return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriver["Service"]["initRepository"] = (input) =>
    gitCommand(vcsProcess, "GitVcsDriver.initRepository", input.cwd, ["init"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid);

  const resolveHeadCommit = (cwd: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const hasHeadCommit = (cwd: string, env?: NodeJS.ProcessEnv) =>
    execute({
      operation: "GitVcsDriver.checkpoints.hasHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
      ...(env !== undefined ? { env } : {}),
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveCheckpointCommit = (cwd: string, checkpointRef: string) =>
    execute({
      operation: "GitVcsDriver.checkpoints.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const resolveGitCommonDir = (cwd: string) =>
    Effect.gen(function* () {
      const result = yield* execute({
        operation: "GitVcsDriver.checkpoints.resolveGitCommonDir",
        cwd,
        args: ["rev-parse", "--git-common-dir"],
      });
      const gitCommonDir = result.stdout.trim();
      return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
    });

  // Names the root the way cwd names it, so paths under a symlinked folder
  // (macOS /var and /tmp, a linked project) still lie inside it.
  const resolveRepositoryRoot = (operation: string, cwd: string) =>
    execute({
      operation,
      cwd,
      args: ["rev-parse", "--show-toplevel", "--show-prefix"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        const [toplevel = "", prefix = ""] = result.stdout.split("\n");
        if (result.exitCode !== 0 || toplevel.length === 0) return null;
        const segments = prefix.split("/").filter((segment) => segment.length > 0);
        let root = path.resolve(cwd);
        for (const segment of segments.toReversed()) {
          if (path.basename(root) !== segment) return toplevel;
          root = path.dirname(root);
        }
        return root;
      }),
      Effect.orElseSucceed(() => null),
    );

  const resolveCheckedOutBranch = (operation: string, cwd: string) =>
    execute({
      operation,
      cwd,
      // The full ref, because --short prints heads/<name> when a tag shares the branch's name.
      args: ["symbolic-ref", "--quiet", "HEAD"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        const ref = result.stdout.trim();
        const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
        if (result.exitCode === 0 && branch.length > 0) return branch;
        // --quiet exits 1 without a message only when HEAD is detached.
        return result.exitCode === 1 ? null : undefined;
      }),
      Effect.orElseSucceed(() => undefined),
    );

  // Git renames loose objects and refs into place without fsync by default, so
  // an unclean restart can leave 0-byte files under refs/studio/** that break every
  // later fetch and push. Checkpoint writes flush before they are published;
  // macOS defaults to writeout-only, which does not reach the disk either.
  const durableWrite = [
    "-c",
    "core.fsync=objects,reference",
    "-c",
    "core.fsyncMethod=fsync",
  ] as const;

  const diffCheckpointsAt = Effect.fn("GitVcsDriver.checkpoints.diffCheckpoints")(function* (
    input: VcsDriver.VcsDiffCheckpointsInput,
  ) {
    const operation = "GitVcsDriver.checkpoints.diffCheckpoints";
    yield* Effect.annotateCurrentSpan({
      "checkpoint.cwd": input.cwd,
      "checkpoint.from_ref": input.fromCheckpointRef,
      "checkpoint.to_ref": input.toCheckpointRef,
      "checkpoint.ignore_whitespace": input.ignoreWhitespace,
      "checkpoint.format": input.format ?? "patch",
      "checkpoint.fallback_from_to_head": input.fallbackFromToHead,
    });

    let fromRevision: string = input.fromCheckpointRef;
    if (input.fallbackFromToHead === true) {
      const resolvedFromCommit = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
      if (resolvedFromCommit) {
        fromRevision = resolvedFromCommit;
      } else {
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (!headCommit) {
          return yield* new VcsProcessExitError({
            operation,
            command: "git diff",
            cwd: input.cwd,
            exitCode: 1,
            detail: "Checkpoint ref is unavailable for diff operation.",
          });
        }
        fromRevision = headCommit;
      }
    }

    const result = yield* execute({
      operation,
      cwd: input.cwd,
      args: [
        "diff",
        ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--patch"]),
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        ...PATCH_RENDER_PREFIX_ARGS,
        ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
        `${fromRevision}^{commit}`,
        `${input.toCheckpointRef}^{commit}`,
      ],
      allowNonZeroExit: true,
      maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      outputMode: input.format === "numstat" ? "error" : "truncate",
    });

    if (result.exitCode !== 0) {
      return yield* new VcsProcessExitError({
        operation,
        command: "git diff",
        cwd: input.cwd,
        exitCode: result.exitCode,
        detail: result.stderr.trim() || "Checkpoint ref is unavailable for diff operation.",
      });
    }

    return { diff: result.stdout, truncated: result.stdoutTruncated };
  });

  const captureCheckpointAt = Effect.fn("GitVcsDriver.checkpoints.captureCheckpoint")(function* (
    input: VcsDriver.VcsCaptureCheckpointInput,
    locate: boolean,
  ) {
    const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
    const indexConfig = [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "sparse.expectFilesOutsideOfPatterns=false",
    ];
    const gitCommonDir = yield* resolveGitCommonDir(input.cwd);
    const indexId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const tempIndexPath = path.join(gitCommonDir, `studio-checkpoint-index-${indexId}`);
    const commitEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_INDEX_FILE: tempIndexPath,
      GIT_AUTHOR_NAME: STUDIO_NAME,
      GIT_AUTHOR_EMAIL: STUDIO_GIT_EMAIL,
      GIT_COMMITTER_NAME: STUDIO_NAME,
      GIT_COMMITTER_EMAIL: STUDIO_GIT_EMAIL,
    };

    // Forced process termination can leave Git's private index lock behind.
    const cleanupTempIndex = Effect.forEach(
      [tempIndexPath, `${tempIndexPath}.lock`],
      (indexFile) => fileSystem.remove(indexFile, { force: true }).pipe(Effect.ignore),
      { discard: true },
    );

    return yield* Effect.gen(function* () {
      const headExists = yield* hasHeadCommit(input.cwd);
      const sparseConfig = yield* execute({
        operation,
        cwd: input.cwd,
        args: ["config", "--bool", "core.sparseCheckout"],
        allowNonZeroExit: true,
      });
      let sparseCheckout = sparseConfig.stdout.trim() === "true";
      if (sparseCheckout) {
        const help = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["add", "-h"],
          allowNonZeroExit: true,
        });
        sparseCheckout = /--(?:\[no-\])?sparse\b/.test(`${help.stdout}${help.stderr}`);
      }
      if (headExists) {
        const reusedIndex = yield* Effect.gen(function* () {
          const indexPath = yield* execute({
            operation,
            cwd: input.cwd,
            args: ["rev-parse", "--path-format=absolute", "--git-path", "index"],
          });
          const { mtime } = yield* fileSystem.stat(indexPath.stdout.trim());
          if (Option.isNone(mtime)) return false;
          // Stay below the source timestamp even if Date rounded up, preserving Git's racy check.
          const indexTime = Math.floor((mtime.value.getTime() - 1) / 1000);
          if (indexTime <= 0) return false;
          yield* fileSystem.copyFile(indexPath.stdout.trim(), tempIndexPath);
          // Retain stat data only where the copied index already matches HEAD.
          yield* execute({
            operation,
            cwd: input.cwd,
            args: [...indexConfig, "read-tree", "--reset", "HEAD"],
            env: commitEnv,
          });
          // read-tree can rewrite the index, so restore its racy timestamp afterward.
          yield* fileSystem.utimes(tempIndexPath, indexTime, indexTime);
          let specialFlags = false;
          let recordStart = true;
          let skipped = false;
          let skippedRecord: number[] = [];
          const skippedPaths: string[] = [];
          yield* vcsProcess.run({
            operation,
            command: "git",
            cwd: input.cwd,
            args: [...indexConfig, "ls-files", "--full-name", "--sparse", "-v", "-z"],
            env: commitEnv,
            maxOutputBytes: 4_096,
            outputMode: "truncate",
            // Inspect every tag; retain only skipped file paths for checking sparse rules.
            onStdoutChunk: (chunk) => {
              for (const byte of chunk) {
                if (recordStart) skipped = byte === 83;
                if (skipped && sparseCheckout) {
                  if (byte !== 0) skippedRecord.push(byte);
                  else {
                    if (skippedRecord.at(-1) !== 47) {
                      const name = Buffer.from(skippedRecord).subarray(2);
                      if (!NodeBuffer.isUtf8(name)) specialFlags = true;
                      else skippedPaths.push(name.toString("utf8"));
                    }
                    skippedRecord = [];
                  }
                }
                if (
                  recordStart &&
                  ((byte >= 97 && byte <= 122) || (!sparseCheckout && byte === 83))
                ) {
                  specialFlags = true;
                }
                recordStart = byte === 0;
              }
            },
          });
          if (skippedPaths.length > 0 && !specialFlags) {
            const selected = yield* execute({
              operation,
              cwd: input.cwd,
              args: [...indexConfig, "sparse-checkout", "check-rules", "-z"],
              stdin: skippedPaths.join("\0") + "\0",
              env: commitEnv,
              maxOutputBytes: 1,
              outputMode: "truncate",
            });
            // Any selected skipped file has a manual flag, not a sparse exclusion.
            specialFlags = selected.stdout.length > 0 || selected.stdoutTruncated;
          }
          // Sparse Git clears skip-worktree for present files. Manual flags still need a reset.
          return !specialFlags;
        }).pipe(Effect.orElseSucceed(() => false));
        if (!reusedIndex) {
          if (sparseCheckout) {
            const cone = yield* execute({
              operation,
              cwd: input.cwd,
              args: ["config", "--bool", "core.sparseCheckoutCone"],
              allowNonZeroExit: true,
            });
            // Rebuilding a non-cone index loses exclusions; do not publish false deletions.
            if (cone.stdout.trim() !== "true") {
              return yield* new VcsProcessExitError({
                operation,
                command: "git read-tree",
                cwd: input.cwd,
                exitCode: 1,
                detail: "Cannot rebuild a checkpoint index for non-cone sparse checkout.",
              });
            }
          }
          yield* cleanupTempIndex;
          yield* execute({
            operation,
            cwd: input.cwd,
            // A fresh sparse index represents excluded directories without marking them deleted.
            args: sparseCheckout
              ? [...indexConfig, "-c", "index.sparse=true", "read-tree", "--reset", "HEAD"]
              : ["read-tree", "HEAD"],
            env: commitEnv,
          });
        }
      }

      const stageFiles = (exclusions: ReadonlyArray<string>) =>
        execute({
          operation,
          cwd: input.cwd,
          // Preserve absent skipped entries, but capture present nonignored files outside the cone.
          args: [
            ...indexConfig,
            ...durableWrite,
            "add",
            ...(sparseCheckout ? ["--sparse"] : []),
            "-A",
            "--",
            ".",
            ...exclusions,
          ],
          env: commitEnv,
        });
      yield* stageFiles([]).pipe(
        Effect.catchTags({
          VcsProcessExitError: (error) =>
            Effect.gen(function* () {
              // Git cannot stage an embedded repository until it has a commit. Discover these
              // only after staging fails so ordinary checkpoints do not need another file scan.
              const untracked = yield* execute({
                operation,
                cwd: input.cwd,
                args: ["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
                env: commitEnv,
                maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
              });
              if (untracked.stdoutTruncated) return yield* error;
              const candidates = splitNullSeparatedGitStdoutPaths(untracked).filter((entry) =>
                entry.endsWith("/"),
              );
              // Refuse excessive recovery work before probing any nested repositories.
              if (candidates.length > CHECKPOINT_RECOVERY_MAX_CANDIDATES) return yield* error;
              // Discover each child's repository instead of inheriting the server's Git bindings.
              const nestedRepoEnv: NodeJS.ProcessEnv = {
                ...process.env,
                GIT_DIR: undefined,
                GIT_WORK_TREE: undefined,
                GIT_COMMON_DIR: undefined,
                GIT_INDEX_FILE: undefined,
                GIT_OBJECT_DIRECTORY: undefined,
                GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
              };
              const exclusions: Array<string> = [];
              for (const entry of candidates) {
                const nestedCwd = path.join(input.cwd, entry);
                if (
                  (yield* fileSystem
                    .exists(path.join(nestedCwd, ".git"))
                    .pipe(Effect.mapError(() => error))) &&
                  !(yield* hasHeadCommit(nestedCwd, nestedRepoEnv))
                ) {
                  exclusions.push(`:(exclude,literal)${entry}`);
                }
              }
              if (exclusions.length === 0) return yield* error;
              return yield* stageFiles(exclusions);
            }).pipe(
              // One budget covers discovery, queued Git admission, probes, and the staging retry.
              Effect.timeoutOrElse({
                duration: CHECKPOINT_RECOVERY_TIMEOUT,
                orElse: () => Effect.fail(error),
              }),
            ),
        }),
      );

      const writeTreeResult = yield* execute({
        operation,
        cwd: input.cwd,
        args: [...indexConfig, ...durableWrite, "write-tree"],
        env: commitEnv,
      });
      const treeOid = writeTreeResult.stdout.trim();
      if (treeOid.length === 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git write-tree",
          cwd: input.cwd,
          exitCode: 0,
          detail: "git write-tree returned an empty tree oid.",
        });
      }

      // The HEAD it was taken at lets a later diff tell edits from a checkout or pull.
      const headOid = headExists ? yield* resolveHeadCommit(input.cwd) : null;
      const branch = locate ? yield* resolveCheckedOutBranch(operation, input.cwd) : undefined;
      // Revert must never delete what was ignored before the turn, so record it when it fits.
      const ignoredListing = yield* execute({
        operation,
        cwd: input.cwd,
        args: [
          ...indexConfig,
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "--full-name",
          "-z",
          "--",
          ".",
        ],
        env: commitEnv,
        allowNonZeroExit: true,
        maxOutputBytes: CHECKPOINT_IGNORED_MAX_BYTES,
        outputMode: "truncate",
      });
      const ignoredEntries = splitNullSeparatedGitStdoutPaths(ignoredListing).toSorted();
      // Git also lists an untracked directory holding only ignored files, then each file;
      // record the files so new files in that directory are not protected with them.
      const ignoredPaths =
        ignoredListing.exitCode === 0 &&
        !ignoredListing.stdoutTruncated &&
        !ignoredListing.stdout.includes("\uFFFD")
          ? ignoredEntries.filter(
              (entry, index) =>
                !entry.endsWith("/") || !ignoredEntries[index + 1]?.startsWith(entry),
            )
          : null;
      const message = checkpointMessage(input.checkpointRef, headOid, ignoredPaths);
      const commitTreeResult = yield* execute({
        operation,
        cwd: input.cwd,
        // The message can be large, so it goes through stdin.
        args: [...durableWrite, "commit-tree", treeOid],
        stdin: `${message}\n`,
        env: commitEnv,
      });
      const commitOid = commitTreeResult.stdout.trim();
      if (commitOid.length === 0) {
        return yield* new VcsProcessExitError({
          operation,
          command: "git commit-tree",
          cwd: input.cwd,
          exitCode: 0,
          detail: "git commit-tree returned an empty commit oid.",
        });
      }

      yield* execute({
        operation,
        cwd: input.cwd,
        args: [...durableWrite, "update-ref", input.checkpointRef, commitOid],
      });
      return {
        repoRoot: locate ? yield* resolveRepositoryRoot(operation, input.cwd) : null,
        branch,
        headOid,
      } satisfies VcsDriver.VcsCheckpointCaptureReport;
    }).pipe(Effect.ensuring(cleanupTempIndex));
  });

  const checkpoints: VcsDriver.VcsCheckpointOps = {
    captureCheckpoint: (input) => captureCheckpointAt(input, false).pipe(Effect.asVoid),
    captureCheckpointReport: (input) => captureCheckpointAt(input, true),

    headMovePaths: Effect.fn("GitVcsDriver.checkpoints.headMovePaths")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.headMovePaths";
      const none: ReadonlySet<string> = new Set();
      const readCheckpoint = (checkpointRef: string) =>
        execute({
          operation,
          cwd: input.cwd,
          args: ["log", "-1", "--format=%ct%n%B", `${checkpointRef}^{commit}`],
          allowNonZeroExit: true,
        }).pipe(
          Effect.map((result) => {
            if (result.exitCode !== 0) return null;
            const [time, ...body] = result.stdout.split("\n");
            const head = checkpointHeadOid(body.join("\n"));
            return head === null ? null : { time: Number(time), head };
          }),
        );
      const from = yield* readCheckpoint(input.fromCheckpointRef);
      const to = yield* readCheckpoint(input.toCheckpointRef);
      if (from === null || to === null || from.head === to.head) return none;
      const listing = (args: ReadonlyArray<string>) =>
        execute({
          operation,
          cwd: input.cwd,
          args: ["-c", "core.quotePath=false", ...args],
          allowNonZeroExit: true,
          maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        });
      const log = yield* listing([
        "log",
        "--no-renames",
        "--max-count=5000",
        "--format=@@%H",
        "--name-only",
        `${from.head}...${to.head}`,
      ]);
      const reflog = yield* listing([
        "reflog",
        "show",
        "--date=unix",
        "--format=%H%x09%gd%x09%gs",
        "--max-count=2000",
        "HEAD",
      ]);
      const dirtyBefore = yield* listing([
        "diff",
        "--name-only",
        "--no-renames",
        `${input.fromCheckpointRef}^{commit}`,
        from.head,
      ]);
      const dirtyAfter = yield* listing([
        "diff",
        "--name-only",
        "--no-renames",
        `${input.toCheckpointRef}^{commit}`,
        to.head,
      ]);
      // Without the whole picture, keep every file rather than hide real edits.
      const results = [log, reflog, dirtyBefore, dirtyAfter];
      if (results.some((result) => result.exitCode !== 0 || result.stdoutTruncated)) return none;
      const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);
      return headMoveOnlyPaths({
        commits: parseCommitPaths(log.stdout),
        localCommits: localCommitsSince(reflog.stdout, from.time),
        dirtyBefore: lines(dirtyBefore.stdout),
        dirtyAfter: lines(dirtyAfter.stdout),
      });
    }),

    hasCheckpointRef: (input) =>
      resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
        Effect.map((commit) => commit !== null),
      ),

    restoreCheckpoint: Effect.fn("GitVcsDriver.checkpoints.restoreCheckpoint")(function* (input) {
      const operation = "GitVcsDriver.checkpoints.restoreCheckpoint";

      const checkpointOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);
      const commitOid =
        checkpointOid ??
        (input.fallbackToHead === true ? yield* resolveHeadCommit(input.cwd) : null);

      if (!commitOid) {
        return false;
      }

      // Paths ignored before the turn, which no clean may remove. Only a checkpoint commit
      // carries the record; a fallback HEAD commit's message is never trusted.
      const checkpointBody =
        checkpointOid === null
          ? null
          : yield* execute({
              operation,
              cwd: input.cwd,
              args: ["log", "-1", "--format=%B", checkpointOid],
              allowNonZeroExit: true,
              maxOutputBytes: 2 * CHECKPOINT_IGNORED_MAX_BYTES,
            });
      const preserved =
        checkpointBody !== null && checkpointBody.exitCode === 0 && !checkpointBody.stdoutTruncated
          ? checkpointIgnoredPaths(checkpointBody.stdout)
          : null;
      const preservedSet = new Set(preserved ?? []);
      // Git prints the prefix with one trailing newline; directory names may have spaces.
      const workspacePrefix = (yield* execute({
        operation,
        cwd: input.cwd,
        args: ["rev-parse", "--show-prefix"],
      })).stdout.replace(/\n$/, "");
      const indexEntries = execute({
        operation,
        cwd: input.cwd,
        args: ["ls-files", "--stage", "--full-name", "-z", "--", "."],
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
      }).pipe(
        Effect.map((result) => {
          if (result.stdoutTruncated) return null;
          const entries = new Map<string, string>();
          for (const record of splitNullSeparatedGitStdoutPaths(result)) {
            const tab = record.indexOf("\t");
            entries.set(record.slice(tab + 1), record);
          }
          return entries;
        }),
      );
      // The recorded entry that is or contains this path, if any.
      const preservedEntry = (fullName: string) => {
        for (let slash = fullName.indexOf("/"); slash !== -1; ) {
          const directory = fullName.slice(0, slash + 1);
          if (preservedSet.has(directory)) return directory;
          slash = fullName.indexOf("/", slash + 1);
        }
        return preservedSet.has(fullName) ? fullName : null;
      };
      const failBeforeRestore = (detail: string) =>
        Effect.fail(
          new VcsProcessExitError({
            operation,
            command: "git restore",
            cwd: input.cwd,
            exitCode: 0,
            detail,
          }),
        );
      // Without a HEAD there is nothing to reset to, so keep the user's index entries.
      const indexBefore = (yield* hasHeadCommit(input.cwd)) ? null : yield* indexEntries;
      // git restore deletes files staged since the checkpoint, intent-to-add entries included.
      // With a record, one that was ignored before the turn only leaves the index.
      let keepOnDisk: ReadonlyArray<string> = [];
      if (preserved !== null && preserved.length > 0) {
        const staged = indexBefore ?? (yield* indexEntries);
        const checkpointFiles = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["ls-tree", "-r", "-z", "--name-only", "--full-name", commitOid],
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        });
        if (staged === null || checkpointFiles.stdoutTruncated) {
          return yield* failBeforeRestore("Could not list the files staged since the checkpoint.");
        }
        const inCheckpoint = new Set(splitNullSeparatedGitStdoutPaths(checkpointFiles));
        keepOnDisk = [...staged.keys()].filter(
          (name) => !inCheckpoint.has(name) && preservedEntry(name) !== null,
        );
      }
      const zeroOid = "0".repeat(commitOid.length);
      // Before the first commit, the paths git restore will write into the index.
      const checkpointPaths =
        indexBefore === null
          ? null
          : yield* execute({
              operation,
              cwd: input.cwd,
              args: ["ls-tree", "-r", "-z", "--name-only", "--full-name", commitOid],
              maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            }).pipe(
              Effect.map((result) =>
                result.stdoutTruncated ? null : splitNullSeparatedGitStdoutPaths(result),
              ),
            );
      // Intent-to-add entries carry the empty blob but, unlike a staged empty file, are left
      // out of `git diff --cached`. None of the entries checked here can be in HEAD.
      const intentToAdd = (entries: ReadonlyMap<string, string>, names: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          if (names.length === 0) return new Set<string>();
          const emptyBlob = (yield* execute({
            operation,
            cwd: input.cwd,
            args: ["hash-object", "-t", "blob", "--stdin"],
            stdin: "",
          })).stdout.replace(/\n$/, "");
          const candidates = names.filter((name) =>
            entries.get(name)?.split(" ")[1] === emptyBlob,
          );
          if (candidates.length === 0) return new Set<string>();
          const staged = yield* execute({
            operation,
            cwd: input.cwd,
            // Repository-relative names, like ls-files --full-name, whatever diff.relative says.
            args: [
              "-c",
              "diff.relative=false",
              "diff",
              "--cached",
              "--name-only",
              "--no-renames",
              "-z",
              "--",
              ".",
            ],
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          });
          const listed = new Set(splitNullSeparatedGitStdoutPaths(staged));
          return new Set(candidates.filter((name) => !listed.has(name)));
        });
      // Index entries, as recorded before the revert, that it may change.
      const recordedEntries = new Map(indexBefore ?? []);
      if (indexBefore === null && keepOnDisk.length > 0) {
        const staged = yield* indexEntries;
        for (const name of keepOnDisk) {
          const entry = staged?.get(name);
          if (entry !== undefined) recordedEntries.set(name, entry);
        }
      }
      const recordedIntent = yield* intentToAdd(recordedEntries, [...recordedEntries.keys()]);
      // Writes back the recorded entries for these paths through Git, which takes the index
      // lock; paths with no recorded entry are removed from the index.
      // Returns the intent-to-add entries left out because their file is gone; Git can only
      // mark a file that exists.
      const writeEntries = (names: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          if (names.length === 0) return [];
          yield* execute({
            operation,
            cwd: input.cwd,
            args: ["update-index", "-z", "--index-info"],
            stdin: names
              .map((name) =>
                recordedEntries.has(name) && !recordedIntent.has(name)
                  ? `${recordedEntries.get(name)}\0`
                  : `0 ${zeroOid}\t${name}\0`,
              )
              .join(""),
          });
          const intent: Array<string> = [];
          const missing: Array<string> = [];
          for (const name of names.filter((entry) => recordedIntent.has(entry))) {
            const exists = yield* fileSystem
              .exists(path.join(input.cwd, name.slice(workspacePrefix.length)))
              .pipe(Effect.orElseSucceed(() => false));
            (exists ? intent : missing).push(name);
          }
          if (intent.length === 0) return missing;
          yield* execute({
            operation,
            cwd: input.cwd,
            args: [
              "--literal-pathspecs",
              "add",
              "--force",
              "--intent-to-add",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ],
            stdin: intent.map((name) => `${name.slice(workspacePrefix.length)}\0`).join(""),
          });
          return missing;
        });
      yield* Effect.gen(function* () {
        if (keepOnDisk.length > 0) {
          yield* execute({
            operation,
            cwd: input.cwd,
            args: ["update-index", "-z", "--index-info"],
            stdin: keepOnDisk.map((name) => `0 ${zeroOid}\t${name}\0`).join(""),
          });
        }
        const tracked = yield* execute({
          operation,
          cwd: input.cwd,
          args: ["ls-files", "--cached", `--with-tree=${commitOid}`, "-z", "--", "."],
        });
        // An empty index and checkpoint have nothing for git restore's pathspec to match.
        if (tracked.stdout.length > 0) {
          yield* execute({
            operation,
            cwd: input.cwd,
            args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
          });
        }
      }).pipe(
        // A failed restore must not leave the files it set aside unstaged.
        Effect.catch((error) =>
          keepOnDisk.length === 0
            ? Effect.fail(error)
            : writeEntries(keepOnDisk).pipe(
                Effect.matchEffect({
                  onSuccess: (missing) =>
                    Effect.fail(
                      missing.length === 0
                        ? error
                        : new VcsProcessExitError({
                            operation,
                            command: "git restore",
                            cwd: input.cwd,
                            exitCode: 0,
                            detail:
                              `${error.message} Left out of the index because the file is ` +
                              `gone: ${missing.join(", ")}.`,
                          }),
                    ),
                  onFailure: (rollbackError) =>
                    Effect.fail(
                      new VcsProcessExitError({
                        operation,
                        command: "git restore",
                        cwd: input.cwd,
                        exitCode: 0,
                        detail:
                          `${error.message} Putting the index back also failed: ` +
                          rollbackError.message,
                      }),
                    ),
                }),
              ),
        ),
      );
      const recreateWorkspace = (command: string) =>
        fileSystem.makeDirectory(input.cwd, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new VcsProcessExitError({
                operation,
                command,
                cwd: input.cwd,
                exitCode: 0,
                detail: `Could not recreate the checkpoint workspace: ${cause.message}`,
              }),
          ),
        );
      // Restoring the checkpoint stages its tree; put the index back as it was.
      const resetIndex = Effect.gen(function* () {
        // Git for Windows removes an emptied nested workspace directory itself.
        yield* recreateWorkspace("git clean");
        if (indexBefore === null || checkpointPaths === null) {
          yield* execute({
            operation,
            cwd: input.cwd,
            args: ["reset", "--quiet", "--", "."],
          });
          return;
        }
        // Only paths the restore wrote, the checkpoint's: the user's entries come back as they
        // were and the rest are removed. Anything staged since then is left alone.
        yield* writeEntries([...new Set([...checkpointPaths, ...keepOnDisk])]);
      });
      // Report why the workspace is not clean even if unstaging fails too.
      const failRestore = (exitCode: number, detail: string) =>
        resetIndex.pipe(
          Effect.as(detail),
          Effect.catch((resetError) =>
            Effect.succeed(
              `${detail} Unstaging the restored files also failed: ${resetError.message}`,
            ),
          ),
          Effect.flatMap((fullDetail) =>
            Effect.fail(
              new VcsProcessExitError({
                operation,
                command: "git clean",
                cwd: input.cwd,
                exitCode,
                detail: fullDetail,
              }),
            ),
          ),
        );
      const workspaceIsEmpty = fileSystem.readDirectory(input.cwd).pipe(
        Effect.map((entries) => entries.length === 0),
        Effect.orElseSucceed(() => false),
      );
      // Git cannot list with NUL separators while cleaning, so list first.
      const listUntracked = (ignored: boolean) =>
        execute({
          operation,
          cwd: input.cwd,
          args: [
            "ls-files",
            "--others",
            // Visible files are listed one by one, so each exposed recorded path shows.
            ...(ignored ? ["--ignored", "--directory"] : []),
            "--exclude-standard",
            "--full-name",
            "-z",
            "--",
            ".",
          ],
          allowNonZeroExit: true,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        }).pipe(
          Effect.map((result) =>
            result.exitCode !== 0 || result.stdoutTruncated
              ? null
              : splitNullSeparatedGitStdoutPaths(result),
          ),
        );
      // Pre-turn ignored paths a turn's negation made visible, as command-line excludes, which
      // outrank every .gitignore. Null when they cannot be listed or passed safely.
      const preservedExcludes = Effect.gen(function* () {
        const exposed = new Set<string>();
        if (preserved !== null && preserved.length > 0) {
          const visible = yield* listUntracked(false);
          if (visible === null) return null;
          for (const entry of visible) {
            const kept = preservedEntry(entry);
            if (kept !== null) exposed.add(kept);
          }
        }
        const args = [...exposed].flatMap((entry) => {
          const literal = entry.replace(/[\\*?[]/g, "\\$&");
          return ["-e", `/${literal.replace(/ +$/, (spaces) => spaces.replaceAll(" ", "\\ "))}`];
        });
        return args.join(" ").length > CHECKPOINT_EXCLUDES_MAX_CHARS ? null : args;
      });
      const cannotProtect =
        "Could not clean the checkpoint workspace without risking ignored files.";
      const clean = (dryRun: boolean) =>
        Effect.gen(function* () {
          const excludes = yield* preservedExcludes;
          if (excludes === null) return yield* failRestore(0, cannotProtect);
          return yield* execute({
            operation,
            cwd: input.cwd,
            args: ["clean", dryRun ? "-dn" : "-fd", ...excludes, "--", "."],
            env: { LC_ALL: "C" },
            allowNonZeroExit: true,
          });
        });
      // A .gitignore the turn created can hide itself ("*"). Remove such ignored ignore files
      // when the record proves they are new; then clean exposes what they hid.
      const removeNewIgnoreFiles = Effect.gen(function* () {
        if (preserved === null) return false;
        yield* recreateWorkspace("git clean");
        const ignored = yield* listUntracked(true);
        if (ignored === null) return false;
        const created = ignored.filter(
          (entry) =>
            (entry === ".gitignore" || entry.endsWith("/.gitignore")) &&
            entry.startsWith(workspacePrefix) &&
            preservedEntry(entry) === null,
        );
        for (const entry of created) {
          const relative = entry.slice(workspacePrefix.length);
          const removed = yield* fileSystem.remove(path.join(input.cwd, relative)).pipe(
            Effect.as(null),
            Effect.catch((cause) => Effect.succeed(cause.message)),
          );
          if (removed !== null) {
            return yield* failRestore(0, `Could not remove ${relative}: ${removed}`);
          }
        }
        return created.length > 0;
      });
      const removedSomething = (stdout: string) => gitCleanListsWorkspacePath(stdout, "Removing");
      // Restoring away the last tracked file can remove a nested workspace directory.
      yield* recreateWorkspace("git restore");
      let cleaned = yield* clean(false);
      // Removing a .gitignore the turn created exposes the files it hid; clean again until a
      // pass removes nothing. Only a checkpoint that recorded its ignored files allows a second
      // pass; otherwise one pass runs and anything it exposed fails the restore below.
      let settled = false;
      for (let pass = 1; pass < 64 && cleaned.exitCode === 0; pass++) {
        if (!removedSomething(cleaned.stdout)) {
          settled = !(yield* removeNewIgnoreFiles);
          if (settled) break;
        } else if (preserved === null) break;
        yield* recreateWorkspace("git clean");
        cleaned = yield* clean(false);
      }
      if (cleaned.exitCode === 0 && !settled) {
        yield* recreateWorkspace("git clean");
        const remaining = yield* clean(true);
        // A dry run lists a nested workspace Git could remove whole as "./" alone, whatever
        // is in it, so that line means files remain unless the workspace is empty.
        const untrackedRemain =
          gitCleanListsWorkspacePath(remaining.stdout, "Would remove") ||
          (/^Would remove /m.test(remaining.stdout) && !(yield* workspaceIsEmpty));
        if (remaining.exitCode !== 0 || untrackedRemain) {
          return yield* failRestore(
            remaining.exitCode,
            remaining.exitCode !== 0
              ? remaining.stderr.trim() || "Could not check the checkpoint workspace."
              : "Could not clean the checkpoint workspace: untracked files remain.",
          );
        }
      }
      if (cleaned.exitCode !== 0) {
        // Git can remove every child, then fail trying to remove './' itself.
        const emptiedWorkspace =
          cleaned.exitCode === 1 &&
          /^warning: failed to remove \.\/: [^\n]+$/.test(cleaned.stderr.trim()) &&
          (yield* workspaceIsEmpty);
        if (!emptiedWorkspace) {
          return yield* failRestore(
            cleaned.exitCode,
            cleaned.stderr.trim() || "Could not clean the checkpoint workspace.",
          );
        }
      }
      yield* resetIndex;

      return true;
    }),

    diffCheckpoints: (input) => diffCheckpointsAt(input).pipe(Effect.map((report) => report.diff)),
    diffCheckpointsReport: diffCheckpointsAt,

    deleteCheckpointRefs: Effect.fn("GitVcsDriver.checkpoints.deleteCheckpointRefs")(
      function* (input) {
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            execute({
              operation: "GitVcsDriver.checkpoints.deleteCheckpointRefs",
              cwd: input.cwd,
              args: ["update-ref", "-d", checkpointRef],
              allowNonZeroExit: true,
            }),
          { discard: true },
        );
      },
    ),
  };

  return {
    capabilities,
    execute,
    checkpoints,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  };
});

export const makeVcsDriver = Effect.gen(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});

export const make = Effect.gen(function* () {
  const git = yield* makeGitVcsDriverCore();
  return GitVcsDriver.of(git);
});

export const layerVcs = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver);
export const layer = Layer.effect(GitVcsDriver, make);
