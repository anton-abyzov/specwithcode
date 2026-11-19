/**
 * What one member of a chat folder says about itself, for the chat worktree
 * sweep (worktreeCleanupSweep.ts): its Git state and files, whether its HEAD is
 * on the default branch, its pull request on the host, and repositories nested
 * in it. Each reading fails closed: what cannot be read is null, and null keeps
 * the folder.
 *
 * @module worktreeCleanupMemberFacts
 */
import type {
  OrchestrationV2AppThreadJson,
  OrchestrationV2ThreadShell,
  ProjectId,
  ServerSettings,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type {
  FinishedMemberGit,
  FinishedPullRequest,
  FinishedWorktreeDecision,
} from "./finishedWorktrees.ts";
import type * as GitManager from "./git/GitManager.ts";
import { worktreeHasNoAdditionalChanges } from "./git/worktreeIntegration.ts";
import type { WorktreeBindings } from "./git/worktreeOwnership.ts";
import { onlyRebuildableUntracked } from "./orphanWorktrees.ts";
import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import { hiddenTrackedChangeReason } from "./worktreeHiddenWork.ts";
import type { WorktreeSetMember } from "./worktreeSet.ts";
import {
  classifyIgnored,
  entriesOutsideMembers,
  findRepository,
  type MediaFile,
  NESTED_WALK_TIMEOUT,
} from "./worktreeCleanupWalks.ts";

/** Fingerprints and the evidence manifest; plain values only, so encoding cannot fail. */
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * A pull request's state is asked of its host once per branch head in this
 * long, however often sweeps and plans run: event sweeps can follow each other
 * every two minutes, and a lookup per folder on each would exhaust the host's
 * rate limit. The hourly sweep still reads every state again.
 */
const PULL_REQUEST_REUSE_MS = 50 * 60_000;
const PULL_REQUEST_CACHE_ENTRIES = 2_000;

export type WorktreeSweepMode = "plan" | "apply";

export type DeletedChat = typeof OrchestrationV2AppThreadJson.Type;

export interface FolderGroup {
  /** Real path, the grouping key. */
  readonly key: string;
  /** As its first chat recorded it, resolved. */
  readonly folder: string;
  readonly chats: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** Deleted chats that recorded it; only for a folder no live chat records. */
  readonly deleted: ReadonlyArray<DeletedChat>;
}

export interface MemberState {
  readonly member: WorktreeSetMember;
  readonly path: string;
  /** The checkout whose `git worktree` commands own this member. */
  readonly repository: string;
  readonly registration: string | null;
  readonly locked: boolean;
  /** Other members inside this one, relative and with forward slashes. */
  readonly inside: ReadonlyArray<string>;
  head: string | null;
  base: string | null;
  media: ReadonlyArray<MediaFile>;
  fingerprint: string;
  git: FinishedMemberGit | undefined;
}

export interface Assessment {
  readonly group: FolderGroup;
  readonly decision: FinishedWorktreeDecision;
  readonly members: ReadonlyArray<MemberState>;
  /** The quickly changing facts; any difference at removal keeps the folder. */
  readonly fingerprint: string;
  /** The part of it that says who uses the folder (`readLive`). */
  readonly liveness: string;
  /** The one branch its chats record, or null. */
  readonly chatBranch: string | null;
  readonly head: { readonly id: string; readonly title: string } | null;
  readonly threadCount: number;
}

export interface SweepContext {
  readonly mode: WorktreeSweepMode;
  readonly settings: ServerSettings;
  readonly now: number;
  readonly bindings: WorktreeBindings;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
  readonly roots: ReadonlyArray<string>;
  readonly processCwds: ReadonlyArray<string> | null;
  /** Default-branch refs fetched in this sweep, per repository; null when there is none. */
  readonly defaultRefs: Map<string, string | null>;
}

/**
 * Commits the worktree's own HEAD reaches, through its reflog or directly,
 * that no remote or local branch holds: removing the worktree deletes that
 * reflog, and with it the only reference. HEAD itself is always counted, so a
 * detached HEAD with an empty or expired reflog is not missed. Null when unreadable.
 */
export const reflogOnlyCommits = Effect.fn("WorktreeCleanupSweep.reflogOnly")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
) {
  const reflog = yield* git.execute({
    operation: "WorktreeCleanupSweep.reflog",
    cwd,
    args: ["log", "-g", "--format=%H", "HEAD"],
    maxOutputBytes: 4 * 1024 * 1024,
    allowNonZeroExit: true,
  });
  if (reflog.stdoutTruncated || reflog.exitCode !== 0) return null;
  const commits = [
    ...new Set([...reflog.stdout.split("\n").filter((line) => line !== ""), "HEAD"]),
  ];
  const unreached = yield* git.execute({
    operation: "WorktreeCleanupSweep.reflogUnreached",
    cwd,
    args: ["rev-list", "--count", ...commits, "--not", "--remotes", "--branches"],
    maxOutputBytes: 1024,
    allowNonZeroExit: true,
  });
  const count = Number.parseInt(unreached.stdout.trim(), 10);
  return unreached.exitCode === 0 && Number.isFinite(count) ? count : null;
});

/** The member readings of one sweep service; the pull request answers are kept between sweeps. */
export function makeMemberFacts(deps: {
  readonly git: GitVcsDriver.GitVcsDriver["Service"];
  readonly gitManager: GitManager.GitManager["Service"];
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { git, gitManager, fs, path } = deps;
  const run = (
    cwd: string,
    operation: string,
    args: ReadonlyArray<string>,
    maxOutputBytes = 4096,
  ) => git.execute({ operation, cwd, args, maxOutputBytes, allowNonZeroExit: true });

  const commitCount = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    run(cwd, operation, args, 1024).pipe(
      Effect.map((result) => {
        const count = Number.parseInt(result.stdout.trim(), 10);
        return result.exitCode === 0 && Number.isFinite(count) ? count : null;
      }),
      Effect.orElseSucceed(() => null),
    );

  /** A stash entry made on `branch` (stashes are shared by every worktree of a repository). */
  const stashOnBranch = (cwd: string, branch: string | null) =>
    branch === null
      ? Effect.succeed(false)
      : run(cwd, "WorktreeCleanupSweep.stash", ["stash", "list", "--format=%gs"], 256 * 1024).pipe(
          Effect.map((result) =>
            result.exitCode !== 0 || result.stdoutTruncated
              ? null
              : result.stdout
                  .split("\n")
                  .some(
                    (line) =>
                      line.startsWith(`WIP on ${branch}:`) || line.startsWith(`On ${branch}:`),
                  ),
          ),
          Effect.orElseSucceed(() => null),
        );

  /** Git's `--directory` listing of a member without the members inside it; null when unreadable. */
  const listOthers = (state: MemberState, args: ReadonlyArray<string>, maxOutputBytes: number) =>
    run(
      state.path,
      "WorktreeCleanupSweep.listFiles",
      ["ls-files", "--others", ...args, "--directory", "-z"],
      maxOutputBytes,
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode !== 0 || result.stdoutTruncated
          ? Effect.succeed(null)
          : Effect.tryPromise(() =>
              entriesOutsideMembers(
                state.path,
                result.stdout.split("\0").filter((entry) => entry !== ""),
                state.inside,
              ),
            ).pipe(Effect.map((entries) => ({ raw: result.stdout, entries }))),
      ),
      Effect.orElseSucceed(() => null),
    );

  /** Everything a member's own Git and folder say, short of the network. */
  const readMemberGit = Effect.fn("WorktreeCleanupSweep.readMemberGit")(function* (
    state: MemberState,
    chatBranch: string | null,
    inSet: boolean,
  ) {
    const status = yield* git.statusDetailsLocal(state.path).pipe(Effect.option);
    const statusRead = Option.isSome(status) && status.value.isRepo ? status.value : null;
    const branch = statusRead?.branch ?? null;
    state.head = yield* git.resolveCommit({ cwd: state.path, revision: "HEAD" }).pipe(
      Effect.map((commit) => commit.commitSha),
      Effect.orElseSucceed((): string | null => null),
    );
    // status.showUntrackedFiles=no hides new files from the status check.
    const untracked = yield* listOthers(state, ["--exclude-standard"], 64 * 1024);
    const ignored = yield* listOthers(state, ["--ignored", "--exclude-standard"], 1024 * 1024);
    const classified =
      ignored === null
        ? null
        : yield* Effect.tryPromise(() => classifyIgnored(state.path, ignored.entries)).pipe(
            Effect.orElseSucceed(() => null),
          );
    state.media = classified?.media ?? [];
    const hidden = yield* hiddenTrackedChangeReason(git, state.path).pipe(
      Effect.map((reason) => reason !== null),
      Effect.orElseSucceed(() => null),
    );
    const restorable =
      chatBranch === null
        ? null
        : !inSet
          ? true
          : yield* run(state.repository, "WorktreeCleanupSweep.branchExists", [
              "rev-parse",
              "--verify",
              "--quiet",
              `refs/heads/${chatBranch}`,
            ]).pipe(
              Effect.map((result) => result.exitCode === 0),
              Effect.orElseSucceed(() => null),
            );
    // History last: a branch deleted elsewhere while the ignored folders are
    // walked makes a commit reflog-only, and this reading still sees it.
    const stash = yield* stashOnBranch(state.path, branch);
    const reflogOnly = yield* reflogOnlyCommits(git, state.path).pipe(
      Effect.orElseSucceed(() => null),
    );
    const unpushed = yield* commitCount(state.path, "WorktreeCleanupSweep.unpushed", [
      "rev-list",
      "--count",
      "HEAD",
      "--not",
      "--remotes",
    ]);
    const facts: FinishedMemberGit = {
      branch,
      changes: statusRead === null ? null : statusRead.hasWorkingTreeChanges,
      untracked:
        untracked === null
          ? null
          : untracked.entries
              .filter((entry) => !onlyRebuildableUntracked(entry))
              .map((entry) => path.basename(entry.replace(/\/$/, ""))),
      ignoredOther: classified?.other ?? null,
      media:
        classified === null
          ? null
          : {
              files: classified.media.length,
              bytes: classified.media.reduce((total, file) => total + file.bytes, 0),
            },
      hiddenTrackedChanges: hidden,
      stash,
      reflogOnlyCommits: reflogOnly,
      unpushedCommits: unpushed,
      restorable,
      nestedRepository: undefined,
      headInDefault: undefined,
      pullRequest: undefined,
    };
    state.git = facts;
    state.fingerprint = encodeJson([
      state.path,
      branch,
      state.head,
      facts.changes,
      untracked?.raw ?? null,
      ignored?.raw ?? null,
      // Files inside an ignored folder do not show in Git's listing of it.
      classified?.other ?? null,
      classified?.media ?? null,
      hidden,
      facts.stash,
      facts.unpushedCommits,
      // A side branch deleted or a remote ref pruned makes commits reflog-only.
      facts.reflogOnlyCommits,
      facts.restorable,
    ]);
  });

  /** Host answers kept between sweeps, by repository, branch and head commit. */
  const pullRequestStates = new Map<
    string,
    { readonly state: FinishedPullRequest["state"]; readonly at: number }
  >();

  /**
   * The repository's default branch on its primary remote, fetched once per
   * apply sweep. A plan changes nothing, so it reads the ref as the last fetch
   * left it; a missing ref reads as unknown, and apply fetches before deciding.
   */
  const defaultRef = Effect.fn("WorktreeCleanupSweep.defaultRef")(function* (
    repository: string,
    ctx: SweepContext,
  ) {
    if (ctx.defaultRefs.has(repository)) return ctx.defaultRefs.get(repository)!;
    const ref = yield* Effect.gen(function* () {
      const remote = yield* git.resolvePrimaryRemoteName(repository);
      const branch = yield* git.resolveDefaultBranchName(repository, remote);
      if (branch === null) return null;
      if (ctx.mode === "apply")
        yield* git.fetchRemoteTrackingBranch({
          cwd: repository,
          remoteName: remote,
          remoteBranch: branch,
        });
      return `refs/remotes/${remote}/${branch}`;
    }).pipe(Effect.orElseSucceed(() => null));
    ctx.defaultRefs.set(repository, ref);
    return ref;
  });

  const readHeadInDefault = Effect.fn("WorktreeCleanupSweep.readHeadInDefault")(function* (
    state: MemberState,
    ctx: SweepContext,
    previous: MemberState | undefined,
  ) {
    if (state.git === undefined) return;
    if (
      previous?.git !== undefined &&
      previous.head === state.head &&
      previous.git.headInDefault !== undefined
    ) {
      state.base = previous.base;
      state.git = { ...state.git, headInDefault: previous.git.headInDefault };
      return;
    }
    let headInDefault: boolean | null = null;
    const ref = yield* defaultRef(state.repository, ctx);
    if (ref !== null && state.head !== null) {
      state.base = yield* git.resolveCommit({ cwd: state.path, revision: ref }).pipe(
        Effect.map((commit) => commit.commitSha),
        Effect.orElseSucceed((): string | null => null),
      );
      if (state.base !== null) {
        const ancestor = yield* run(state.path, "WorktreeCleanupSweep.integratedBranch", [
          "merge-base",
          "--is-ancestor",
          state.head,
          state.base,
        ]).pipe(Effect.orElseSucceed(() => null));
        headInDefault = ancestor?.exitCode === 0 ? true : ancestor?.exitCode === 1 ? false : null;
      }
    }
    state.git = { ...state.git, headInDefault };
  });

  const readPullRequest = Effect.fn("WorktreeCleanupSweep.readPullRequest")(function* (
    state: MemberState,
    previous: MemberState | undefined,
    ctx: SweepContext,
    /** A chat's own synced pull request says merged or closed. */
    finishedHint: boolean,
  ) {
    const facts = state.git;
    if (facts === undefined) return;
    if (facts.branch === null) {
      state.git = { ...facts, pullRequest: { state: "none", contentIntegrated: false } };
      return;
    }
    // A closed pull request can be reopened: before a removal that rests on
    // "closed", the host is asked again instead of trusting an earlier answer.
    const closedBefore = previous?.git?.pullRequest?.state === "closed";
    if (
      !closedBefore &&
      previous?.git !== undefined &&
      previous.head === state.head &&
      previous.git.pullRequest !== undefined
    ) {
      state.git = { ...facts, pullRequest: previous.git.pullRequest };
      return;
    }
    const branch = facts.branch;
    const cacheKey = encodeJson([state.repository, branch, state.head]);
    const cached = pullRequestStates.get(cacheKey);
    // Merged is final for this head. Other answers are reused for a while,
    // except an open or missing one the chat's own record already contradicts.
    const reusable =
      !closedBefore &&
      cached !== undefined &&
      (cached.state === "merged" ||
        (cached.at <= ctx.now &&
          ctx.now - cached.at < PULL_REQUEST_REUSE_MS &&
          !(finishedHint && cached.state !== "closed")));
    const pullRequest = reusable
      ? cached.state
      : yield* gitManager.branchPullRequest({ cwd: state.path, branch }, { refresh: true }).pipe(
          Effect.map((found) => found?.state ?? ("none" as const)),
          Effect.orElseSucceed(() => null),
        );
    if (pullRequest === null) {
      // A host that gave no answer is never remembered; the folder stays.
      state.git = { ...facts, pullRequest: null };
      return;
    }
    if (!reusable) {
      if (pullRequestStates.size >= PULL_REQUEST_CACHE_ENTRIES) pullRequestStates.clear();
      pullRequestStates.set(cacheKey, { state: pullRequest, at: ctx.now });
    }
    const contentIntegrated =
      pullRequest === "merged" &&
      (facts.headInDefault === true ||
        (state.head !== null &&
          state.base !== null &&
          (yield* worktreeHasNoAdditionalChanges(git, state.path, state.head, state.base).pipe(
            Effect.orElseSucceed(() => false),
          ))));
    state.git = { ...facts, pullRequest: { state: pullRequest, contentIntegrated } };
  });

  // Walked on every look, the one under the lease included: a repository
  // cloned into an ignored dependency folder changes nothing else Git reports.
  const readNested = Effect.fn("WorktreeCleanupSweep.readNested")(function* (state: MemberState) {
    const facts = state.git;
    if (facts === undefined) return;
    // Git refuses to remove a worktree with a checked-out submodule, and its
    // commits may be nowhere else: it counts as a repository inside.
    const submodule = !(yield* fs
      .exists(path.join(state.path, ".gitmodules"))
      .pipe(Effect.orElseSucceed(() => true)))
      ? false
      : yield* run(
          state.path,
          "WorktreeCleanupSweep.submodules",
          ["submodule", "status"],
          256 * 1024,
        ).pipe(
          Effect.map((result) =>
            result.exitCode !== 0 || result.stdoutTruncated
              ? null
              : result.stdout.split("\n").some((line) => line !== "" && !line.startsWith("-")),
          ),
          Effect.orElseSucceed(() => null),
        );
    // No exclude rules: every untracked path, ignored ones included.
    const listing = submodule === false ? yield* listOthers(state, [], 1024 * 1024) : null;
    const nestedRepository =
      submodule === true
        ? true
        : listing === null
          ? null
          : yield* Effect.tryPromise({
              try: (signal) => findRepository(state.path, listing.entries, signal),
              catch: () => null,
            }).pipe(
              Effect.timeoutOption(NESTED_WALK_TIMEOUT),
              Effect.map((found) => (Option.isSome(found) ? found.value : null)),
              Effect.orElseSucceed(() => null),
            );
    state.git = { ...facts, nestedRepository };
  });

  return { run, readMemberGit, readHeadInDefault, readPullRequest, readNested };
}
