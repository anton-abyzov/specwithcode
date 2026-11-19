// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/**
 * Sync extras (1390 AC-12 to AC-14): the work in a repository that Git does
 * not carry between machines. `inventory` lists it and changes nothing.
 * `sendExtras` sends what was asked for to the other machine's server over the
 * peer route a thread hand off uses, one bundle per branch, never through the
 * remote and never through the folder copy. Uncommitted work travels as one
 * snapshot commit built with a private index, so the branch, the index and the
 * working tree here stay as they are. On this machine only hidden refs under
 * `refs/specwithcode/extras/` are written, and they are removed afterwards.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  type EnvironmentId,
  HANDOFF_MAX_BUNDLE_BYTES,
  HANDOFF_MAX_SNAPSHOT_FILE_BYTES,
  HANDOFF_MAX_SNAPSHOT_FILES,
  type ProjectId,
  PROJECT_SYNC_MAX_LISTED,
  type ProjectSyncBranchExtra,
  ProjectSyncError,
  type ProjectSyncExtraItem,
  type ProjectSyncExtraResult,
  type ProjectSyncInventoryResult,
  type ProjectSyncLeftOutFile,
  type ProjectSyncProjectInput,
  type ProjectSyncRepositoryExtras,
  type ProjectSyncSendExtrasInput,
  type ProjectSyncSendExtrasResult,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import {
  BundleError,
  createBundle,
  isCommitSha,
  measureCommitRange,
  negotiationCandidates,
  refCommit,
} from "../handoff/bundleGit.ts";
import { refComponent, writeCheckpoint } from "../handoff/checkpointGit.ts";
import { extraId } from "../handoff/ExtrasReceiver.ts";
import { HandoffMode } from "../handoff/HandoffMode.ts";
import * as HandoffPeers from "../handoff/handoffPeers.ts";
import type { ExtrasReplicateMeta, ExtrasReplicateResponse } from "../handoff/handoffWire.ts";
import { checkSnapshotContent } from "../handoff/snapshotSecrets.ts";
import {
  isSecretLikeProjectPath,
  isUntrackedSecretConfigPath,
} from "../workspace/WorkspaceSensitivePaths.ts";
import { runGit } from "./folderTransfer/git.ts";
import { cloneStagingIn } from "./cloneStaging.ts";
import * as ProjectSync from "./ProjectSync.ts";
import { originRecord, type OriginRecords, originRecordsOf } from "./projectSyncOrigin.ts";

const EXTRAS_REF_PREFIX = "refs/specwithcode/extras/";
/** Branches that arrived from another machine are that machine's work, not this one's. */
const ARRIVED_PREFIX = "swc/from-";

const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);
const count = async (root: string, args: ReadonlyArray<string>) => {
  const result = await runGit(root, ["rev-list", "--count", ...args], { allowFailure: true });
  const value = Number(result.stdout.trim());
  return result.code === 0 && Number.isInteger(value) ? value : 0;
};

async function modifiedAtMs(root: string, path: string): Promise<number | null> {
  const stat = await NodeFSP.lstat(NodePath.join(root, path)).catch(() => null);
  return stat === null ? null : Math.max(0, Math.floor(stat.mtimeMs));
}

const capped = <A>(items: ReadonlyArray<A>) => ({
  listed: items.slice(0, PROJECT_SYNC_MAX_LISTED),
  notListed: Math.max(0, items.length - PROJECT_SYNC_MAX_LISTED),
});

/**
 * What a snapshot of the uncommitted work would leave out, without writing
 * one: changed and untracked files that are secrets by name, and untracked
 * files the content check flags or does not reach.
 */
export async function snapshotLeftOut(root: string): Promise<Array<ProjectSyncLeftOutFile>> {
  const [untracked, changed, ignored] = await Promise.all([
    runGit(root, ["ls-files", "-z", "--others", "--exclude-standard"]),
    runGit(root, ["diff", "--name-only", "-z", "--no-renames", "HEAD"], { allowFailure: true }),
    runGit(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]),
  ]);
  // A folder a clone is being made in (it carries the clone step's mark) is no work of
  // this repository.
  const staging = cloneStagingIn(root);
  const untrackedPaths: Array<string> = [];
  for (const path of untracked.stdout.split("\0").filter(Boolean).toSorted())
    if (!(await staging.has(path))) untrackedPaths.push(path);
  const out: Array<Omit<ProjectSyncLeftOutFile, "modifiedAtMs">> = [];
  const toCheck: Array<string> = [];
  for (const path of changed.stdout.split("\0").filter(Boolean).toSorted()) {
    if (isSecretLikeProjectPath(path)) out.push({ path, reason: "name", kind: null });
  }
  for (const path of untrackedPaths) {
    if (path.endsWith("/")) continue;
    if (isSecretLikeProjectPath(path) || isUntrackedSecretConfigPath(path))
      out.push({ path, reason: "name", kind: null });
    else toCheck.push(path);
  }
  // Ignored secrets (a `.env` under `.gitignore`) are never in a snapshot; they are listed so
  // the sealed route can offer them.
  for (const path of ignored.stdout.split("\0").filter(Boolean).toSorted()) {
    if (path.endsWith("/") || (await staging.has(path))) continue;
    if (isSecretLikeProjectPath(path) || isUntrackedSecretConfigPath(path))
      out.push({ path, reason: "name", kind: null });
  }
  const checked = await checkSnapshotContent({ root, untracked: toCheck, pastLimit: "leave-out" });
  out.push(...checked.leftOut);
  return Promise.all(
    out
      .toSorted((a, b) => a.path.localeCompare(b.path))
      .map(async (file) => ({ ...file, modifiedAtMs: await modifiedAtMs(root, file.path) })),
  );
}

/**
 * Removes the hidden refs of sends that never finished (the server stopped
 * mid-way): every ref under `refs/specwithcode/extras/` whose operation is not
 * a send under way in this server. `isActive` is asked for each ref at the
 * moment it would be removed, never from a list made earlier: a send that
 * began after the refs were listed keeps its ref. A ref is removed only while
 * it still holds the commit it was listed with.
 */
export async function sweepStaleExtraRefs(
  root: string,
  isActive: (operation: string) => boolean,
): Promise<void> {
  const listed = await runGit(
    root,
    ["for-each-ref", "--format=%(refname) %(objectname)", EXTRAS_REF_PREFIX],
    { allowFailure: true },
  );
  if (listed.code !== 0) return;
  for (const line of listed.stdout.split("\n")) {
    const [ref, commit] = line.split(" ");
    if (ref === undefined || commit === undefined || !ref.startsWith(EXTRAS_REF_PREFIX)) continue;
    const operation = ref.slice(EXTRAS_REF_PREFIX.length).split("/")[0] ?? "";
    if (isActive(operation)) continue;
    await runGit(root, ["update-ref", "-d", ref, commit], { allowFailure: true });
  }
}

/** More branches on `origin` than this are not passed to one Git command. */
const LIVE_HEADS_MAX = 2000;
const ORIGIN_TRACKING = "refs/remotes/origin/";

/**
 * The work in one repository that Git does not carry. Reads only. `origin` is
 * what the project's Sync fetches learned: a branch `origin` no longer lists
 * is counted against the branches it does list, not against its own tracking
 * ref, which the fetch (it never prunes) leaves where it was.
 */
export async function inventoryRepository(
  repository: ProjectSync.SyncRepository,
  origin?: OriginRecords,
): Promise<ProjectSyncRepositoryExtras> {
  const root = repository.cwd;
  const refs = await runGit(root, [
    "for-each-ref",
    "--format=%(refname:short)%09%(objectname)%09%(upstream:short)%09%(upstream)",
    "refs/heads",
  ]);
  let listed: ReadonlyMap<string, string> | null = null;
  if (origin !== undefined && origin.size > 0) {
    const urls = await runGit(root, ["config", "--get-all", "remote.origin.url"], {
      allowFailure: true,
    });
    const url = urls.code === 0 ? (urls.stdout.split("\n")[0] ?? "").trim() : "";
    const record =
      url.length === 0
        ? undefined
        : await originRecord(origin, (cwd, args, options) => runGit(cwd, args, options), root, url);
    if (record !== undefined && record.heads.size <= LIVE_HEADS_MAX) listed = record.heads;
  }
  const live = listed === null ? [] : [...new Set(listed.values())];
  const notPushed: Array<ProjectSyncBranchExtra> = [];
  const onlyHere: Array<ProjectSyncBranchExtra> = [];
  let branchesNotListed = 0;
  for (const line of lines(refs.stdout)) {
    const [branch, head, upstream, upstreamRef] = line.split("\t");
    if (branch === undefined || head === undefined || !isCommitSha(head)) continue;
    if (branch.startsWith(ARRIVED_PREFIX) || branch.length > 255) continue;
    const sameName = await refCommit(root, `refs/remotes/origin/${branch}`);
    const against = upstream !== undefined && upstream.length > 0 ? upstream : null;
    // The branch of origin this one is counted against, when it is one of origin's.
    const onOrigin =
      against === null
        ? sameName === null
          ? null
          : `refs/heads/${branch}`
        : upstreamRef?.startsWith(ORIGIN_TRACKING) === true
          ? `refs/heads/${upstreamRef.slice(ORIGIN_TRACKING.length)}`
          : null;
    if (listed !== null && onOrigin !== null && !listed.has(onOrigin)) {
      // Gone from origin: its own commits are those no branch origin still has holds.
      // A commit origin listed that is not here yet is passed over.
      const commits = await count(root, ["--ignore-missing", head, "--not", ...live]);
      if (commits === 0) continue;
      if (onlyHere.length >= PROJECT_SYNC_MAX_LISTED) branchesNotListed += 1;
      else onlyHere.push({ branch, head, commits });
      continue;
    }
    if (against === null && sameName === null) {
      if (onlyHere.length >= PROJECT_SYNC_MAX_LISTED) branchesNotListed += 1;
      else
        onlyHere.push({
          branch,
          head,
          commits: await count(root, [head, "--not", "--remotes=origin"]),
        });
      continue;
    }
    const commits = await count(root, [head, `^${against ?? `refs/remotes/origin/${branch}`}`]);
    if (commits === 0) continue;
    if (notPushed.length >= PROJECT_SYNC_MAX_LISTED) branchesNotListed += 1;
    else notPushed.push({ branch, head, commits });
  }
  // `-z`: each path as it is, never in quotes, and a rename or copy followed by its old name.
  const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  // A folder a clone is being made in is no work of this repository.
  const staging = cloneStagingIn(root);
  const entries: Array<string> = [];
  const fields = status.stdout.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index]!;
    if (entry.length < 4) continue;
    if (/[RC]/.test(entry.slice(0, 2))) index += 1;
    if (!(entry.startsWith("??") && (await staging.has(entry.slice(3))))) entries.push(entry);
  }
  const untrackedFiles = entries.filter((entry) => entry.startsWith("??")).length;
  const stashes = await runGit(root, ["stash", "list"], { allowFailure: true });
  const leftOut = capped(await snapshotLeftOut(root));
  return {
    path: repository.path,
    notPushed,
    onlyHere,
    branchesNotListed,
    changedFiles: entries.length - untrackedFiles,
    untrackedFiles,
    stashes: lines(stashes.stdout).length,
    leftOut: leftOut.listed,
    leftOutNotListed: leftOut.notListed,
  };
}

/** The other machine's server, as one extra needs it. */
export interface ExtrasPeer {
  readonly negotiate: (candidates: ReadonlyArray<string>) => Promise<ReadonlyArray<string>>;
  readonly replicate: (
    meta: Pick<ExtrasReplicateMeta, "leaf" | "commit">,
    bundle: Uint8Array | null,
  ) => Promise<Pick<ExtrasReplicateResponse, "branch" | "landed">>;
}

/** Why the other machine did not take an extra. */
export class ExtrasPeerFailure extends Error {
  readonly stays: NonNullable<ProjectSyncExtraResult["stays"]>;
  constructor(stays: ExtrasPeerFailure["stays"], message: string) {
    super(message);
    this.stays = stays;
  }
}

const two = (value: number) => String(value).padStart(2, "0");
/** `uncommitted-{yyyymmdd-hhmmss}-{id}`: the snapshot's branch leaf. */
export function snapshotLeaf(now: Date, operationId: string): string {
  const day = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `uncommitted-${day}-${time}-${extraId(operationId)}`;
}

const megabytes = (bytes: number) => `${Math.ceil(bytes / 1_048_576)} MB`;

/**
 * Sends one extra. A branch travels as it is; uncommitted work as a snapshot
 * commit on the checked-out commit. The other machine names the commits it
 * holds and the bundle leaves those out; when it holds none, the bundle carries
 * the whole branch. Limits are measured on what would travel: an extra over
 * one stays, with the file or the count that exceeded it.
 */
export async function sendExtra(input: {
  readonly repository: ProjectSync.SyncRepository;
  readonly item: ProjectSyncExtraItem;
  readonly operationId: string;
  /** Position in the run: one hidden ref per extra. */
  readonly index: number;
  readonly sourceLabel: string;
  readonly now: Date;
  readonly peer: ExtrasPeer;
  /** Lower limits for a branch and for the bundle, so tests need no 64 MB fixture. */
  readonly limits?: {
    readonly maxFileBytes?: number;
    readonly maxFiles?: number;
    readonly maxBundleBytes?: number;
  };
}): Promise<ProjectSyncExtraResult> {
  const { item, peer } = input;
  const maxFileBytes = input.limits?.maxFileBytes ?? HANDOFF_MAX_SNAPSHOT_FILE_BYTES;
  const maxFiles = input.limits?.maxFiles ?? HANDOFF_MAX_SNAPSHOT_FILES;
  const maxBundleBytes = input.limits?.maxBundleBytes ?? HANDOFF_MAX_BUNDLE_BYTES;
  const root = input.repository.cwd;
  const base: ProjectSyncExtraResult = {
    kind: item.kind,
    path: item.path,
    branch: item.kind === "branch" ? item.branch : null,
    status: "stays",
    arrivedAs: null,
    landed: null,
    stays: null,
    detail: null,
    bytes: 0,
    includedCommits: 0,
    includedBranch: null,
    leftOut: [],
    leftOutNotListed: 0,
  };
  const stays = (
    reason: NonNullable<ProjectSyncExtraResult["stays"]>,
    detail: string | null = null,
    more: Partial<ProjectSyncExtraResult> = {},
  ): ProjectSyncExtraResult => ({
    ...base,
    ...more,
    status: "stays",
    stays: reason,
    detail: detail === null ? null : detail.slice(0, 1900),
  });
  const hidden = `${EXTRAS_REF_PREFIX}${refComponent(input.operationId)}/${input.index}`;
  try {
    let commit: string;
    let leaf: string;
    let exclude: ReadonlyArray<string>;
    let more: Partial<ProjectSyncExtraResult> = {};
    if (item.kind === "branch") {
      const tip = await refCommit(root, `refs/heads/${item.branch}`);
      if (tip === null) return stays("missing-branch");
      // The branch may move while this runs: the hidden ref holds what is sent.
      await runGit(root, ["update-ref", hidden, tip]);
      commit = tip;
      leaf = item.branch;
      exclude = await peer.negotiate(await negotiationCandidates(root, tip));
      if (!exclude.includes(tip)) {
        const measured = await measureCommitRange({
          root,
          commit: tip,
          exclude,
          maxFileBytes,
        });
        if (measured.oversizedFile !== null)
          return stays(
            "file-too-large",
            `${measured.oversizedFile} is over ${megabytes(maxFileBytes)}.`,
          );
        if (measured.files > maxFiles)
          return stays(
            "too-many-files",
            `${measured.files.toLocaleString("en-US")} files, over the limit of ${maxFiles.toLocaleString("en-US")}.`,
          );
      }
    } else {
      const snapshot = await writeCheckpoint({
        cwd: root,
        threadId: `sync-${input.operationId}`,
        ref: hidden,
        message: `SpecWithCode: uncommitted work on ${input.sourceLabel}`,
        contentCheck: { pastLimit: "leave-out", sendAnyway: item.sendAnyway },
      });
      const leftOutAll: Array<ProjectSyncLeftOutFile> = await Promise.all(
        [
          ...snapshot.excludedSecretPaths.map((path) => ({
            path,
            reason: "name" as const,
            kind: null,
          })),
          ...snapshot.leftOutByContent,
        ].map(async (file) => ({ ...file, modifiedAtMs: await modifiedAtMs(root, file.path) })),
      );
      const leftOut = capped(leftOutAll);
      more = { leftOut: leftOut.listed, leftOutNotListed: leftOut.notListed };
      const over = snapshot.overLimit;
      if (over !== null) {
        return over.reason === "too-large"
          ? stays(
              "file-too-large",
              `${over.path} is ${megabytes(over.bytes)}, over ${megabytes(HANDOFF_MAX_SNAPSHOT_FILE_BYTES)}.`,
              more,
            )
          : stays(
              "too-many-files",
              `More than ${HANDOFF_MAX_SNAPSHOT_FILES.toLocaleString("en-US")} files.`,
              more,
            );
      }
      const [own, parent] = await Promise.all([
        runGit(root, ["rev-parse", `${snapshot.commit}^{tree}`]),
        runGit(root, ["rev-parse", `${snapshot.baseCommit}^{tree}`]),
      ]);
      if (own.stdout.trim() === parent.stdout.trim()) return stays("nothing-to-send", null, more);
      commit = snapshot.commit;
      leaf = snapshotLeaf(input.now, input.operationId);
      exclude = await peer.negotiate(await negotiationCandidates(root, snapshot.baseCommit));
      if (!exclude.includes(snapshot.baseCommit)) {
        // The checked-out commit is not there yet: its commits travel in the same bundle,
        // under the same limits as a branch.
        const measured = await measureCommitRange({
          root,
          commit: snapshot.baseCommit,
          exclude,
          maxFileBytes,
        });
        if (measured.oversizedFile !== null)
          return stays(
            "file-too-large",
            `${measured.oversizedFile} is over ${megabytes(maxFileBytes)}.`,
            more,
          );
        if (measured.files + snapshot.includedFileCount > maxFiles)
          return stays(
            "too-many-files",
            `${(measured.files + snapshot.includedFileCount).toLocaleString("en-US")} files, over the limit of ${maxFiles.toLocaleString("en-US")}.`,
            more,
          );
        more = {
          ...more,
          includedCommits: await count(root, [snapshot.baseCommit, "--not", "--remotes=origin"]),
          includedBranch: snapshot.branch,
        };
      }
    }
    let bytes = 0;
    let payload: Uint8Array | null = null;
    if (!exclude.includes(commit)) {
      const bundle = await createBundle({
        root,
        ref: hidden,
        commit,
        exclude,
        maxBytes: maxBundleBytes,
      });
      try {
        bytes = bundle.bytes;
        payload = await NodeFSP.readFile(bundle.path);
      } finally {
        await bundle.dispose();
      }
    }
    const arrived = await peer.replicate({ leaf, commit }, payload);
    return {
      ...base,
      ...more,
      status: "sent",
      arrivedAs: arrived.branch,
      landed: arrived.landed,
      bytes,
    };
  } catch (cause) {
    if (cause instanceof ExtrasPeerFailure) return stays(cause.stays, cause.message);
    if (cause instanceof BundleError && cause.code === "too_large")
      return stays("bundle-too-large", cause.message);
    return stays("failed", cause instanceof Error ? cause.message : "Git did not finish.");
  } finally {
    await runGit(root, ["update-ref", "-d", hidden], { allowFailure: true });
  }
}

export class ProjectSyncExtras extends Context.Service<
  ProjectSyncExtras,
  {
    readonly inventory: (
      input: ProjectSyncProjectInput,
    ) => Effect.Effect<ProjectSyncInventoryResult, ProjectSyncError>;
    readonly sendExtras: (
      input: ProjectSyncSendExtrasInput,
    ) => Effect.Effect<ProjectSyncSendExtrasResult, ProjectSyncError>;
  }
>()("specweave-studio/fleet/ProjectSyncExtras") {}

const failed = (reason: string) => new ProjectSyncError({ code: "failed", reason });

const make = Effect.gen(function* () {
  const sync = yield* ProjectSync.ProjectSync;
  const peers = yield* HandoffPeers.HandoffPeers;
  const handoff = yield* HandoffMode;

  const attempt = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        failed(cause instanceof Error ? cause.message.slice(0, 1900) : "Git did not finish."),
    });
  /** The sends under way in this server, by the name their hidden refs carry. */
  const activeOperations = new Map<string, number>();
  const withActiveOperation = <A, E>(
    effect: Effect.Effect<A, E>,
    input: ProjectSyncSendExtrasInput,
  ) => {
    const key = refComponent(input.operationId);
    return Effect.acquireUseRelease(
      Effect.sync(() => activeOperations.set(key, (activeOperations.get(key) ?? 0) + 1)),
      () => effect,
      () =>
        Effect.sync(() => {
          const left = (activeOperations.get(key) ?? 1) - 1;
          if (left <= 0) activeOperations.delete(key);
          else activeOperations.set(key, left);
        }),
    );
  };

  /** A refusal or a silence from the other machine, as the reason an extra stays. */
  const peerFailure = (error: HandoffPeers.HandoffPeerError) =>
    new ExtrasPeerFailure(
      error.needsUpdate === true
        ? "needs-update"
        : error.code === "unreachable"
          ? "unreachable"
          : error.code === "too_large"
            ? "bundle-too-large"
            : "refused",
      error.message,
    );
  /** Runs a peer call from the Git code's promises, with the context of the request it serves. */
  const call = async <A>(
    context: Context.Context<never>,
    effect: Effect.Effect<A, HandoffPeers.HandoffPeerError>,
  ) => {
    const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(context)));
    if (Exit.isSuccess(exit)) return exit.value;
    const cause = Cause.squash(exit.cause);
    throw cause instanceof HandoffPeers.HandoffPeerError
      ? peerFailure(cause)
      : new ExtrasPeerFailure("failed", "The call to the other machine did not finish.");
  };

  const peerFor = (
    context: Context.Context<never>,
    target: EnvironmentId,
    projectId: ProjectId,
    repositoryPath: string,
    operationId: string,
  ): ExtrasPeer => {
    const common = {
      sourceEnvironmentId: handoff.environmentId,
      sourceProjectId: projectId,
      // The peer route names the project folder itself "".
      repositoryPath: repositoryPath === "." ? "" : repositoryPath,
    };
    return {
      negotiate: (candidates) =>
        call(
          context,
          peers.extrasNegotiate(target, { ...common, candidates: [...candidates] }),
        ).then((answer) => answer.known),
      replicate: (meta, bundle) =>
        call(
          context,
          peers.extrasReplicate(
            target,
            {
              ...common,
              sourceLabel: handoff.machineLabel.slice(0, 120),
              operationId,
              leaf: meta.leaf,
              commit: meta.commit,
            },
            bundle,
          ),
        ),
    };
  };

  return ProjectSyncExtras.of({
    inventory: Effect.fn("ProjectSyncExtras.inventory")(function* (input) {
      const found = yield* sync.repositories(input.projectId);
      const repositories: Array<ProjectSyncRepositoryExtras> = [];
      for (const repository of found.repositories)
        repositories.push(
          yield* attempt(() => inventoryRepository(repository, originRecordsOf(input.projectId))),
        );
      return { repositories, scanLimited: found.scanLimited };
    }),
    sendExtras: Effect.fn("ProjectSyncExtras.sendExtras")(function* (input) {
      if (input.targetEnvironmentId === handoff.environmentId)
        return yield* new ProjectSyncError({
          code: "invalid",
          reason: "Extras go to another machine, not to this one.",
        });
      const found = yield* sync.repositories(input.projectId);
      const known = new Map(found.repositories.map((repository) => [repository.path, repository]));
      const now = DateTime.toDate(yield* DateTime.now);
      const context = yield* Effect.context<never>();
      const items: Array<ProjectSyncExtraResult> = [];
      const swept = new Set<string>();
      for (const [index, item] of input.items.entries()) {
        const repository = known.get(item.path);
        if (repository === undefined) {
          items.push({
            kind: item.kind,
            path: item.path,
            branch: item.kind === "branch" ? item.branch : null,
            status: "stays",
            arrivedAs: null,
            landed: null,
            stays: "failed",
            detail: "Sync does not list this folder as a repository of the project.",
            bytes: 0,
            includedCommits: 0,
            includedBranch: null,
            leftOut: [],
            leftOutNotListed: 0,
          });
          continue;
        }
        if (!swept.has(repository.cwd)) {
          swept.add(repository.cwd);
          yield* attempt(() =>
            sweepStaleExtraRefs(repository.cwd, (operation) => activeOperations.has(operation)),
          ).pipe(Effect.uninterruptible);
        }
        items.push(
          yield* attempt(
            () =>
              sendExtra({
                repository,
                item,
                operationId: input.operationId,
                index,
                sourceLabel: handoff.machineLabel,
                now,
                peer: peerFor(
                  context,
                  input.targetEnvironmentId,
                  input.projectId,
                  repository.path,
                  input.operationId,
                ),
              }),
            // Never cut short: a cancelled call waits, so the hidden ref is removed and a
            // bundle the other machine is taking is not left half sent.
          ).pipe(Effect.uninterruptible),
        );
      }
      return { items };
    }, withActiveOperation),
  });
});

export const layer = Layer.effect(ProjectSyncExtras, make);
