// @effect-diagnostics nodeBuiltinImport:off - plain promises over real Git, like folderTransfer/git.ts.
/**
 * Sync extras (1390 AC-12 to AC-14): the work in a repository that Git does
 * not carry between machines. `inventory` lists it and changes nothing.
 * `sendExtras` sends what was asked for to the other machine's server over the
 * peer route a thread hand off uses, one bundle per branch, never through the
 * remote and never through the folder copy. Uncommitted work travels as one
 * snapshot commit built with a private index, so the branch, the index and the
 * working tree here stay as they are. On this machine only hidden refs under
 * `refs/specwithcode/extras/` are written: each send creates its own only
 * where none of that name exists, and removes only what it created, at the
 * commit it wrote. A ref this call did not write is never removed.
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
  PROJECT_SYNC_EXTRAS_UNREAD_DETAIL,
  PROJECT_SYNC_PATH_UNREAD_DETAIL,
  type ProjectSyncInventoryInput,
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
import { gitFolders } from "./projectSyncFacts.ts";
import { commitOf, type SyncGit } from "./projectSyncGit.ts";
import { keptFetch, type Row } from "./projectSyncRecord.ts";

const EXTRAS_REF_PREFIX = "refs/specwithcode/extras/";
/** Branches that arrived from another machine are that machine's work, not this one's. */
const ARRIVED_PREFIX = "swc/from-";

const syncGit: SyncGit = (cwd, args, options) => runGit(cwd, args, options);
const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);
const count = async (root: string, args: ReadonlyArray<string>, input?: string) => {
  const result = await runGit(root, ["rev-list", "--count", ...args], {
    allowFailure: true,
    ...(input === undefined ? {} : { input }),
  }).catch(() => null);
  if (result === null) return null;
  const value = Number(result.stdout.trim());
  // Null when Git could not count: never a zero.
  return result.code === 0 && Number.isInteger(value) ? value : null;
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
 * files the content check flags or does not reach. Null when Git could not
 * list the files: never an empty list.
 */
export async function snapshotLeftOut(root: string): Promise<Array<ProjectSyncLeftOutFile> | null> {
  const listed = await Promise.all(
    [
      ["ls-files", "-z", "--others", "--exclude-standard"],
      ["diff", "--name-only", "-z", "--no-renames", "HEAD"],
      ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
    ].map((args) => runGit(root, args, { allowFailure: true }).catch(() => null)),
  );
  const [untracked, changed, ignored] = listed;
  if (
    untracked == null ||
    changed == null ||
    ignored == null ||
    listed.some((result) => result?.code !== 0)
  )
    return null;
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
 * The work in one repository that Git does not carry. Reads only. `row` is
 * what the fetch the window names showed for this checkout: which branches
 * `origin` had then, and at which commits. A branch is on origin when origin's
 * branch of its upstream (or, without an upstream, of its own name) is in that
 * fetch, whatever their commits; it is counted against the commit the fetch
 * brought. A branch whose own name origin did not have in that fetch exists
 * only here, also with no commit of its own, whatever its upstream. Without
 * such a fetch, or with a row that is no proof for this checkout (unread, or
 * read in other folders), membership is unknown (`onlyHereUnknown`) and no
 * branch is said to exist only here. A read Git could not make makes the whole
 * repository unread: never a zero, never an empty list.
 */
export async function inventoryRepository(
  repository: ProjectSync.SyncRepository,
  row?: Row,
): Promise<ProjectSyncRepositoryExtras> {
  return readInventory(repository, row).catch(() => unreadExtras(repository.path));
}

/**
 * Each repository's extras, one at a time, with the row `rowOf` gives for it
 * at that moment. A repository Git could not read is unread; the rest still are read.
 */
export async function inventoryAll(
  repositories: ReadonlyArray<ProjectSync.SyncRepository>,
  rowOf: (path: string) => Row | undefined,
): Promise<Array<ProjectSyncRepositoryExtras>> {
  const out: Array<ProjectSyncRepositoryExtras> = [];
  for (const repository of repositories)
    out.push(await inventoryRepository(repository, rowOf(repository.path)));
  return out;
}

const unreadExtras = (path: string): ProjectSyncRepositoryExtras => ({
  path,
  notPushed: [],
  onlyHere: [],
  branchesNotListed: 0,
  changedFiles: 0,
  untrackedFiles: 0,
  stashes: 0,
  leftOut: [],
  leftOutNotListed: 0,
  unreadDetail: PROJECT_SYNC_EXTRAS_UNREAD_DETAIL,
});

/** Whether a fetch's row speaks for this checkout: read whole, in the folders it is in now. */
async function rowApplies(row: Row, cwd: string): Promise<boolean> {
  if (!row.readable) return false;
  const where = await gitFolders(syncGit, cwd);
  return where !== null && where.cwd === row.cwd && where.gitDir === row.gitDir;
}

async function readInventory(
  repository: ProjectSync.SyncRepository,
  row: Row | undefined,
): Promise<ProjectSyncRepositoryExtras> {
  const unread = () => unreadExtras(repository.path);
  if (repository.unread === true) return unread();
  const root = repository.cwd;
  const refs = await runGit(
    root,
    [
      "for-each-ref",
      "--format=%(refname)%09%(objectname)%09%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)",
      "refs/heads",
    ],
    { allowFailure: true },
  ).catch(() => null);
  if (refs === null || refs.code !== 0) return unread();
  // The fetch's row is proof only for the checkout it was read in, and only when read whole.
  const heads = row !== undefined && (await rowApplies(row, root)) ? row.originHeads : null;
  // Passed to Git on its standard input: however many branches origin has.
  const live =
    heads === null ? "" : [...new Set(heads.values())].map((oid) => `^${oid}\n`).join("");
  const notPushed: Array<ProjectSyncBranchExtra> = [];
  const onlyHere: Array<ProjectSyncBranchExtra> = [];
  let branchesNotListed = 0;
  let failedCount = false;
  const counted = async (args: ReadonlyArray<string>, input?: string) => {
    const value = await count(root, args, input);
    if (value === null) failedCount = true;
    return value ?? 0;
  };
  for (const line of lines(refs.stdout)) {
    const [ref, head, upstream, remote, source] = line.split("\t");
    if (ref === undefined || !ref.startsWith("refs/heads/")) continue;
    // The branch's own name in full, as Git keeps it: never a shortened, ambiguous one.
    const branch = ref.slice("refs/heads/".length);
    if (head === undefined || !isCommitSha(head)) continue;
    if (branch.startsWith(ARRIVED_PREFIX) || branch.length > 255) continue;
    const against = upstream !== undefined && upstream.length > 0 ? upstream : null;
    // The branch of origin this one goes with, as Git names it: the remote and the branch
    // there, not the ref it is kept in here. Null for an upstream of another remote.
    const onOrigin =
      against === null
        ? `refs/heads/${branch}`
        : remote === "origin" && source?.startsWith("refs/heads/") === true
          ? source
          : null;
    if (onOrigin === null) {
      const commits = await counted([head, `^${against}`]);
      if (commits === 0) continue;
      if (notPushed.length >= PROJECT_SYNC_MAX_LISTED) branchesNotListed += 1;
      else notPushed.push({ branch, head, commits });
      continue;
    }
    if (heads === null) {
      // Membership unknown. An upstream's commits are counted against its ref here, as Git
      // keeps it; a branch with no upstream against origin's branch of its name as this
      // checkout last fetched it, when there is one. A count, never a claim of membership.
      const local = against ?? `refs/remotes/origin/${branch}`;
      if (against === null) {
        const tracked = await commitOf(syncGit, root, local);
        if (tracked.kind === "unread") return unread();
        if (tracked.kind === "absent") continue;
      }
      const commits = await counted([head, `^${local}`]);
      if (commits === 0) continue;
      if (notPushed.length >= PROJECT_SYNC_MAX_LISTED) branchesNotListed += 1;
      else notPushed.push({ branch, head, commits });
      continue;
    }
    const own = heads.get(ref);
    if (own === undefined) {
      // Origin had no branch of this name in that fetch: it exists only here, whatever its
      // upstream says. Its own commits are those no branch origin had then holds. A commit
      // origin listed that is not here is passed over.
      if (onlyHere.length >= PROJECT_SYNC_MAX_LISTED) branchesNotListed += 1;
      else
        onlyHere.push({
          branch,
          head,
          commits: await counted(["--ignore-missing", "--stdin"], `${head}\n${live}`),
        });
      continue;
    }
    // Counted against origin's branch of its upstream when that fetch had it, else against
    // origin's branch of its own name.
    const tip = heads.get(onOrigin) ?? own;
    const commits = await counted(["--ignore-missing", "--stdin"], `${head}\n^${tip}\n`);
    if (commits === 0) continue;
    if (notPushed.length >= PROJECT_SYNC_MAX_LISTED) branchesNotListed += 1;
    else notPushed.push({ branch, head, commits });
  }
  if (failedCount) return unread();
  // `-z`: each path as it is, never in quotes, and a rename or copy followed by its old name.
  const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    allowFailure: true,
  }).catch(() => null);
  if (status === null || status.code !== 0) return unread();
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
  const stashes = await runGit(root, ["stash", "list"], { allowFailure: true }).catch(() => null);
  if (stashes === null || stashes.code !== 0) return unread();
  const leftOutAll = await snapshotLeftOut(root);
  if (leftOutAll === null) return unread();
  const leftOut = capped(leftOutAll);
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
    ...(heads === null ? { onlyHereUnknown: true } : {}),
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
  // The commit this call wrote the hidden ref at, once Git created it; null while it has not.
  let created: string | null = null;
  try {
    let commit: string;
    let leaf: string;
    let exclude: ReadonlyArray<string>;
    let more: Partial<ProjectSyncExtraResult> = {};
    if (item.kind === "branch") {
      const tip = await refCommit(root, `refs/heads/${item.branch}`);
      if (tip === null) return stays("missing-branch");
      // The branch may move while this runs: the hidden ref holds what is sent. Created only
      // where none of that name exists: a ref another process holds is never taken over.
      await runGit(root, ["update-ref", hidden, tip, ""]);
      created = tip;
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
        exclusive: true,
        message: `SpecWithCode: uncommitted work on ${input.sourceLabel}`,
        contentCheck: { pastLimit: "leave-out", sendAnyway: item.sendAnyway },
      });
      created = snapshot.commit;
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
        const included = await count(root, [snapshot.baseCommit, "--not", "--remotes=origin"]);
        // A count Git could not make is said to be unknown: never a zero.
        more = {
          ...more,
          ...(included === null
            ? { includedCommits: 0, includedCommitsUnknown: true }
            : { includedCommits: included }),
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
    const sent: ProjectSyncExtraResult = {
      ...base,
      ...more,
      status: "sent",
      arrivedAs: arrived.branch,
      landed: arrived.landed,
      bytes,
    };
    return sent;
  } catch (cause) {
    if (cause instanceof ExtrasPeerFailure) return stays(cause.stays, cause.message);
    if (cause instanceof BundleError && cause.code === "too_large")
      return stays("bundle-too-large", cause.message);
    return stays("failed", cause instanceof Error ? cause.message : "Git did not finish.");
  } finally {
    // Only the ref this call created, and only while it is still at the commit written.
    if (created !== null)
      await runGit(root, ["update-ref", "-d", hidden, created], { allowFailure: true });
  }
}

export class ProjectSyncExtras extends Context.Service<
  ProjectSyncExtras,
  {
    readonly inventory: (
      input: ProjectSyncInventoryInput,
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
      // Origin's branches as the fetch the window names showed them, and only that fetch,
      // looked up again for each repository: a fetch that expired meanwhile proves nothing.
      const repositories = yield* attempt(() =>
        inventoryAll(found.repositories, (path) =>
          keptFetch(input.projectId, input.fetchId)?.rows.get(path),
        ),
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
        if (repository.unread === true) {
          items.push({
            kind: item.kind,
            path: item.path,
            branch: item.kind === "branch" ? item.branch : null,
            status: "stays",
            arrivedAs: null,
            landed: null,
            stays: "failed",
            detail: PROJECT_SYNC_PATH_UNREAD_DETAIL,
            bytes: 0,
            includedCommits: 0,
            includedBranch: null,
            leftOut: [],
            leftOutNotListed: 0,
          });
          continue;
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
    }),
  });
});

export const layer = Layer.effect(ProjectSyncExtras, make);
