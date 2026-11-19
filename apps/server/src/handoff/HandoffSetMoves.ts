// @effect-diagnostics nodeBuiltinImport:off - members are plain Git worktrees and bundle files.
/**
 * Handing off a thread that works in a worktree set (1390): one thread folder
 * with a worktree of each repository it changes. The set moves whole or the
 * thread stays.
 *
 * The source checkpoints every member, measures each against the handoff
 * limits and builds every bundle before it sends one, so a member that cannot
 * travel stops the thread with nothing sent. The other members' bundles go
 * first, each to its own repository; the thread's own frame goes last and
 * names every member's commit, and the destination refuses it unless each one
 * is already there. Only that frame makes the copy a thread can be taken over
 * from.
 *
 * On takeover the destination builds every member's worktree in one new
 * thread folder and writes the set's manifest last. A member that cannot be
 * built takes the ones before it down again, so the folder holds every member
 * or does not exist.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  HANDOFF_MAX_BUNDLE_BYTES,
  HANDOFF_MAX_SNAPSHOT_FILE_BYTES,
  HANDOFF_MAX_SNAPSHOT_FILES,
  type HandoffCheckpoint,
  type HandoffSkippedFile,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { FolderGitError, runGit } from "../fleet/folderTransfer/git.ts";
import { worktreeSetManifestPath } from "../worktreeSet.ts";
import {
  applyCheckpointToWorktree,
  availableBranch,
  type BundleFile,
  BundleError,
  copyRequiredFiles,
  createBundle,
  knownCommits,
  measureCommitRange,
  missingFiles,
  negotiationCandidates,
  refCommit,
  repositoryPathFor,
  resolveRepositoryPath,
} from "./bundleGit.ts";
import { writeCheckpoint } from "./checkpointGit.ts";
import { HandoffPeerError, type HandoffPeers } from "./handoffPeers.ts";
import type { HandoffReceiver, HandoffRefusal, ReceiverCaller } from "./HandoffReceiver.ts";
import {
  HANDOFF_APP_VERSION,
  HANDOFF_CAPABILITIES,
  HANDOFF_PROTOCOL_VERSION,
  HANDOFF_SET_MAX_MEMBERS,
  hasWorktreeSets,
  type ReplicateMeta,
  type ReplicateResponse,
  type ReplicateSet,
  type ReplicateSetMember,
} from "./handoffWire.ts";

/** The limits of one member: each repository of a set is measured on its own. */
interface SetLimits {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxBundleBytes: number;
}
export const SET_LIMITS: SetLimits = {
  maxFileBytes: HANDOFF_MAX_SNAPSHOT_FILE_BYTES,
  maxFiles: HANDOFF_MAX_SNAPSHOT_FILES,
  maxBundleBytes: HANDOFF_MAX_BUNDLE_BYTES,
};

/**
 * Why the lease tick keeps no standby copy of a set thread. A copy made there
 * would hold one member as of its last checkpoint and the others as of now,
 * outside any transfer record; the set is copied when it is handed off.
 */
export const SET_COPY_ON_HANDOFF =
  "This thread works in a worktree set. Its repositories are copied to another machine together, when the thread is handed off.";

/** How long a machine that named the capability is not asked again. */
const CAPABILITY_FRESH_MS = 10 * 60_000;

/** Why the set does not travel. The message starts with the member it is about. */
class SetMoveError extends Error {
  readonly code: "invalid" | "too_large" | "failed";
  constructor(code: SetMoveError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** How a member is named to the user: its place in the project folder. */
const memberName = (repositoryPath: string) =>
  repositoryPath === "" ? "The project folder's own repository" : repositoryPath;

const megabytes = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`;
const count = (value: number) => value.toLocaleString("en-US");
const describe = (cause: unknown) =>
  cause instanceof FolderGitError && cause.stderr.trim().length > 0
    ? cause.stderr.trim().split("\n")[0]!
    : cause instanceof Error
      ? cause.message
      : String(cause);

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

const memberPath = (threadFolder: string, relativePath: string) =>
  relativePath === "" ? threadFolder : NodePath.join(threadFolder, relativePath);

/**
 * Where each member of the thread folder's set sits, in the manifest's order,
 * or null when the folder is one plain worktree. A manifest that is there and
 * cannot be read is an error: carrying on would move one repository alone.
 */
export async function readSourceSet(
  threadFolder: string,
): Promise<ReadonlyArray<{ readonly relativePath: string; readonly path: string }> | null> {
  const file = worktreeSetManifestPath(threadFolder, NodePath);
  const text = await NodeFSP.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new SetMoveError("failed", "This thread's list of repositories could not be read.");
  });
  if (text === null) return null;
  let members: unknown;
  try {
    members = (JSON.parse(text) as { readonly members?: unknown }).members;
  } catch {
    members = undefined;
  }
  if (
    !Array.isArray(members) ||
    members.some(
      (member) =>
        typeof (member as { relativePath?: unknown } | null)?.relativePath !== "string" ||
        NodePath.isAbsolute((member as { relativePath: string }).relativePath),
    )
  ) {
    throw new SetMoveError("failed", "This thread's list of repositories could not be read.");
  }
  if (members.length === 0) return null;
  return (members as ReadonlyArray<{ readonly relativePath: string }>).map((member) => ({
    relativePath: member.relativePath,
    path: memberPath(threadFolder, member.relativePath),
  }));
}

/**
 * The folder a thread's own checkpoint is written in: the first member of its
 * set (the thread folder itself when the project's own repository is one),
 * else the folder as it is.
 */
export async function checkpointFolder(threadFolder: string): Promise<string> {
  const members = await readSourceSet(threadFolder).catch(() => null);
  return members?.[0]?.path ?? threadFolder;
}

export interface PreparedMember extends ReplicateSetMember {
  /** The member's worktree, where its bundle is cut. */
  readonly root: string;
  readonly ref: string;
}

const overLimit = (name: string, file: HandoffSkippedFile, limits: SetLimits) =>
  new SetMoveError(
    "too_large",
    file.reason === "too-large"
      ? `${name}: ${file.path} is ${megabytes(file.bytes)}, over the ${megabytes(limits.maxFileBytes)} a file may be in a handoff.`
      : `${name}: more than ${count(limits.maxFiles)} changed files, over the limit of a handoff.`,
  );

/**
 * A checkpoint of every member, the thread's own (already written) first.
 * Fails for the first member that sits outside the project folder or holds a
 * file the checkpoint had to leave out for its size or the file count: a
 * member that would arrive incomplete does not go.
 */
export async function checkpointSetMembers(input: {
  readonly projectRoot: string;
  readonly members: ReadonlyArray<{ readonly relativePath: string; readonly path: string }>;
  readonly threadId: string;
  readonly checkpoint: Pick<
    HandoffCheckpoint,
    "commit" | "baseCommit" | "branch" | "ref" | "skipped" | "requiredSecretPaths" | "sourceRoot"
  >;
  readonly limits?: SetLimits;
}): Promise<ReadonlyArray<PreparedMember>> {
  const limits = input.limits ?? SET_LIMITS;
  if (input.members.length > HANDOFF_SET_MAX_MEMBERS) {
    throw new SetMoveError(
      "invalid",
      `This thread works in ${input.members.length} repositories, and a handoff carries at most ${HANDOFF_SET_MAX_MEMBERS}.`,
    );
  }
  const prepared: Array<PreparedMember> = [];
  for (const [index, member] of input.members.entries()) {
    const shown = member.relativePath === "" ? memberName("") : member.relativePath;
    const repositoryPath = await repositoryPathFor(input.projectRoot, member.path).catch(
      (cause) => {
        throw new SetMoveError("invalid", `${shown}: ${describe(cause)}`);
      },
    );
    if (repositoryPath.split("/").includes("..")) {
      throw new SetMoveError(
        "invalid",
        `${shown}: its repository sits outside the project folder, so the other machine cannot place it.`,
      );
    }
    const name = memberName(repositoryPath);
    if (prepared.some((other) => other.repositoryPath === repositoryPath)) {
      throw new SetMoveError("invalid", `${name}: the set holds this repository twice.`);
    }
    if (index === 0) {
      const left = input.checkpoint.skipped.find((file) => file.reason !== "submodule");
      if (left !== undefined) throw overLimit(name, left, limits);
      prepared.push({
        repositoryPath,
        commit: input.checkpoint.commit,
        baseCommit: input.checkpoint.baseCommit,
        branch: input.checkpoint.branch,
        requiredSecretPaths: [...(input.checkpoint.requiredSecretPaths ?? [])],
        root: input.checkpoint.sourceRoot.workspaceRoot,
        ref: input.checkpoint.ref,
      });
      continue;
    }
    const written = await writeCheckpoint({ cwd: member.path, threadId: input.threadId }).catch(
      (cause) => {
        throw new SetMoveError("failed", `${name}: ${describe(cause)}`);
      },
    );
    if (written.overLimit !== null) throw overLimit(name, written.overLimit, limits);
    prepared.push({
      repositoryPath,
      commit: written.commit,
      baseCommit: written.baseCommit,
      branch: written.branch,
      requiredSecretPaths: [...written.requiredSecretPaths],
      root: written.root,
      ref: written.ref,
    });
  }
  return prepared;
}

/**
 * The bundle of one member, less what the destination holds, measured before
 * and after it is built: a file over the per-file limit, more files than the
 * count limit or a bundle over its cap stops it, named. Null when the
 * destination already holds the member's commit.
 */
export async function bundleSetMember(
  member: PreparedMember,
  known: ReadonlyArray<string>,
  limits: SetLimits = SET_LIMITS,
): Promise<BundleFile | null> {
  if (known.includes(member.commit)) return null;
  const name = memberName(member.repositoryPath);
  const measured = await measureCommitRange({
    root: member.root,
    commit: member.commit,
    exclude: known,
    maxFileBytes: limits.maxFileBytes,
  });
  if (measured.oversizedFile !== null) {
    throw new SetMoveError(
      "too_large",
      `${name}: ${measured.oversizedFile} is over the ${megabytes(limits.maxFileBytes)} a file may be in a handoff.`,
    );
  }
  if (measured.files > limits.maxFiles) {
    throw new SetMoveError(
      "too_large",
      `${name}: ${count(measured.files)} files would travel, over the limit of ${count(limits.maxFiles)}.`,
    );
  }
  return createBundle({
    root: member.root,
    ref: member.ref,
    commit: member.commit,
    exclude: known,
    maxBytes: limits.maxBundleBytes,
  }).catch((cause) => {
    throw new SetMoveError(
      cause instanceof BundleError && cause.code === "too_large" ? "too_large" : "failed",
      `${name}: ${describe(cause)}`,
    );
  });
}

type PeerFailure = HandoffPeerError | HandoffRefusal;

const local = (cause: unknown) =>
  new HandoffPeerError({
    code: cause instanceof SetMoveError ? cause.code : "failed",
    message: describe(cause),
    uncertain: false,
  });

/** The destination's answer about one member, with the member's name in front. */
const named =
  (member: PreparedMember) =>
  (error: PeerFailure): HandoffPeerError =>
    new HandoffPeerError({
      code: error.code,
      message: `${memberName(member.repositoryPath)}: ${error.message}`,
      ...(error.check === undefined ? {} : { check: error.check }),
      uncertain: error.uncertain === true,
      ...(error._tag === "HandoffPeerError" && error.local === true ? { local: true } : {}),
    });

/**
 * Replicates a set thread's checkpoint: every member, or nothing. `self` is a
 * move on this machine (another model): no bundle travels and nothing is asked.
 */
const shipSet = (input: {
  readonly self: boolean;
  readonly destination: string;
  readonly destinationLabel: string;
  readonly projectRoot: string;
  readonly members: ReadonlyArray<{ readonly relativePath: string; readonly path: string }>;
  readonly meta: ReplicateMeta;
  /** Machines that named the capability, and until when that is believed. */
  readonly capable: Map<string, number>;
  readonly capabilities: Effect.Effect<ReadonlyArray<string> | undefined, PeerFailure>;
  readonly negotiate: (
    repositoryPath: string,
    candidates: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, PeerFailure>;
  readonly replicate: (
    meta: ReplicateMeta,
    bundle: Uint8Array | null,
  ) => Effect.Effect<ReplicateResponse, PeerFailure>;
  readonly limits?: SetLimits;
}): Effect.Effect<ReplicateResponse, PeerFailure> =>
  Effect.gen(function* () {
    const checkpoint = input.meta.checkpoint;
    const members = yield* Effect.tryPromise({
      try: () =>
        checkpointSetMembers({
          projectRoot: input.projectRoot,
          members: input.members,
          threadId: input.meta.sourceThreadId,
          checkpoint,
          ...(input.limits === undefined ? {} : { limits: input.limits }),
        }),
      catch: local,
    });
    const now = yield* Clock.currentTimeMillis;
    if (!input.self && (input.capable.get(input.destination) ?? 0) <= now) {
      // Asked before anything is offered: a machine that keeps one repository gets none.
      if (!hasWorktreeSets(yield* input.capabilities)) {
        return yield* new HandoffPeerError({
          code: "invalid",
          check: "version",
          message: `Needs update: this thread works in ${members.length} repositories, and ${input.destinationLabel} runs a SpecWithCode that moves one repository per thread. Update SpecWithCode on ${input.destinationLabel} first. Nothing was sent.`,
          uncertain: false,
          needsUpdate: true,
        });
      }
      input.capable.set(input.destination, now + CAPABILITY_FRESH_MS);
    }
    // Every bundle is built and measured before the first one leaves.
    const bundles: Array<BundleFile | null> = [];
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        Promise.all(bundles.map((bundle) => bundle?.dispose().catch(() => undefined))),
      ),
    );
    for (const member of members) {
      if (input.self) {
        bundles.push(null);
        continue;
      }
      const candidates = yield* Effect.promise(() =>
        negotiationCandidates(member.root, member.baseCommit),
      );
      const known = yield* input
        .negotiate(member.repositoryPath, candidates)
        .pipe(Effect.mapError(named(member)));
      bundles.push(
        yield* Effect.tryPromise({
          try: () => bundleSetMember(member, known, input.limits),
          catch: local,
        }),
      );
    }
    const bytesOf = (index: number) =>
      bundles[index] == null
        ? Effect.succeed(null)
        : Effect.promise(() => NodeFSP.readFile(bundles[index]!.path)).pipe(
            Effect.map((bytes) => new Uint8Array(bytes)),
          );
    for (const [index, member] of members.entries()) {
      if (index === 0) continue;
      yield* input
        .replicate(
          {
            ...input.meta,
            repositoryPath: member.repositoryPath,
            setPart: { commit: member.commit },
          },
          yield* bytesOf(index),
        )
        .pipe(Effect.mapError(named(member)));
    }
    const nested = new Set(members.map((member) => member.repositoryPath));
    return yield* input.replicate(
      {
        ...input.meta,
        // A member's folder inside the project's own worktree is not something left behind.
        checkpoint: {
          ...checkpoint,
          skipped: checkpoint.skipped.filter(
            (file) => !(file.reason === "submodule" && nested.has(file.path)),
          ),
        },
        set: {
          members: members.map(({ root: _root, ref: _ref, ...member }) => member),
        },
      },
      yield* bytesOf(0),
    );
  }).pipe(Effect.scoped);

/** `shipSet` over this machine's peers, or its own receiver for a move that stays here. */
export const shipSetTo = (
  via: {
    readonly peers: HandoffPeers["Service"];
    readonly receiver: HandoffReceiver["Service"];
    readonly selfCaller: ReceiverCaller;
    readonly capable: Map<string, number>;
  },
  destination: ReplicateMeta["sourceEnvironmentId"],
  input: Pick<
    Parameters<typeof shipSet>[0],
    "destinationLabel" | "projectRoot" | "members" | "meta"
  >,
) => {
  const self = input.meta.sourceEnvironmentId;
  return shipSet({
    ...input,
    self: destination === self,
    destination,
    capable: via.capable,
    capabilities: via.peers
      .preflight(destination, {
        sourceEnvironmentId: self,
        protocolVersion: HANDOFF_PROTOCOL_VERSION,
        appVersion: HANDOFF_APP_VERSION,
        capabilities: HANDOFF_CAPABILITIES,
        threads: [],
      })
      .pipe(Effect.map((answer) => answer.capabilities)),
    negotiate: (repositoryPath, candidates) =>
      via.peers
        .negotiate(destination, {
          sourceEnvironmentId: self,
          sourceProjectId: input.meta.sourceProjectId,
          sourceThreadId: input.meta.sourceThreadId,
          repositoryPath,
          candidates,
        })
        .pipe(Effect.map((answer) => answer.known)),
    replicate: (frame, bundle) =>
      destination === self
        ? via.receiver.replicate(via.selfCaller, frame, bundle)
        : via.peers.replicate(destination, frame, bundle),
  });
};

// The destination.

const invalid = (member: Pick<ReplicateSetMember, "repositoryPath">, message: string) =>
  new BundleError("invalid", `${memberName(member.repositoryPath)}: ${message}`);

/** Each member's repository on this machine, or the first that does not map to one. */
async function memberRoots(projectRoot: string, set: ReplicateSet) {
  const seen = new Set<string>();
  const out: Array<{ readonly member: ReplicateSetMember; readonly root: string }> = [];
  for (const member of set.members) {
    if (member.repositoryPath.split("/").includes("..") || seen.has(member.repositoryPath)) {
      throw invalid(member, "the set names this repository twice or outside the project folder.");
    }
    seen.add(member.repositoryPath);
    const root = await resolveRepositoryPath(projectRoot, member.repositoryPath).catch((cause) => {
      throw invalid(member, describe(cause));
    });
    out.push({ member, root });
  }
  return out;
}

/**
 * The check the thread's own frame must pass before it is stored: the set
 * starts with the thread's checkpoint, and every member's commits are in
 * that member's repository here.
 */
export async function checkArrivedSet(input: {
  readonly projectRoot: string;
  readonly set: ReplicateSet;
  readonly repositoryPath: string;
  readonly commit: string;
}): Promise<void> {
  const first = input.set.members[0];
  if (
    first === undefined ||
    first.repositoryPath !== input.repositoryPath ||
    first.commit !== input.commit
  ) {
    throw new BundleError("invalid", "The set does not start with the thread's own checkpoint.");
  }
  for (const { member, root } of await memberRoots(input.projectRoot, input.set)) {
    const held = await knownCommits(root, [member.commit, member.baseCommit]);
    if (!held.includes(member.commit) || !held.includes(member.baseCommit)) {
      throw invalid(member, "its work did not arrive here, so nothing of the thread is kept.");
    }
  }
}

/** Secret files the other members need here and do not have, each with its member in front. */
export async function missingSetSecrets(
  projectRoot: string,
  set: ReplicateSet,
): Promise<ReadonlyArray<string>> {
  const missing: Array<string> = [];
  for (const member of set.members.slice(1)) {
    const required = member.requiredSecretPaths ?? [];
    if (required.length === 0) continue;
    const absent = await resolveRepositoryPath(projectRoot, member.repositoryPath).then(
      (root) => missingFiles(root, required),
      () => required,
    );
    missing.push(...absent.map((path) => `${member.repositoryPath}/${path}`));
  }
  return missing;
}

/**
 * The thread folder an earlier attempt at this takeover began, found through
 * Git's own list of the first member's worktrees, or null.
 */
export async function startedSetFolder(input: {
  readonly projectRoot: string;
  readonly set: ReplicateSet;
  readonly name: string;
}): Promise<string | null> {
  const first = input.set.members[0];
  if (first === undefined) return null;
  const root = await resolveRepositoryPath(input.projectRoot, first.repositoryPath);
  const relative = first.repositoryPath.split("/").filter(Boolean);
  const listed = await runGit(root, ["worktree", "list", "--porcelain", "-z"]);
  for (const field of listed.stdout.split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    let folder = NodePath.resolve(field.slice("worktree ".length));
    if (folder === NodePath.resolve(root)) continue;
    let matches = true;
    for (const segment of relative.toReversed()) {
      if (NodePath.basename(folder) !== segment) matches = false;
      folder = NodePath.dirname(folder);
    }
    if (matches && NodePath.basename(folder) === input.name) return folder;
  }
  return null;
}

interface BuiltMember {
  readonly root: string;
  readonly path: string;
  /** The branch this build created for it; null when it is not this build's to delete. */
  readonly branch: string | null;
}

const branchOf = async (path: string) => {
  const result = await runGit(path, ["symbolic-ref", "--short", "-q", "HEAD"], {
    allowFailure: true,
  });
  const branch = result.stdout.trim();
  return result.code === 0 && branch.length > 0 ? branch : null;
};

/** Takes built members down, deepest first: the worktree, then the branch made for it. */
async function removeBuilt(built: ReadonlyArray<BuiltMember>): Promise<void> {
  for (const member of built.toReversed()) {
    await runGit(member.root, ["worktree", "remove", "--force", member.path], {
      allowFailure: true,
    });
    await runGit(member.root, ["worktree", "prune"], { allowFailure: true });
    if (member.branch !== null) {
      await runGit(member.root, ["branch", "-D", member.branch], { allowFailure: true });
    }
  }
}

/**
 * Builds the set in `folder`: each member a worktree at its base commit with
 * the checkpoint's files as uncommitted changes, on the source's branch where
 * that name is free. The manifest is written last and is what says the set is
 * whole: a repeat that finds it changes nothing, and one that finds members
 * without it (an attempt that was cut) takes them down and builds again.
 */
export async function materializeSet(input: {
  readonly projectRoot: string;
  readonly folder: string;
  readonly set: ReplicateSet;
  readonly sourceLabel: string;
  readonly sourceThreadId: string;
}): Promise<{ readonly worktreePath: string; readonly branch: string }> {
  const { folder } = input;
  const manifest = worktreeSetManifestPath(folder, NodePath);
  const depth = (member: ReplicateSetMember) => member.repositoryPath.split("/").filter(Boolean);
  const ordered = (await memberRoots(input.projectRoot, input.set))
    .map((entry) => ({ ...entry, path: NodePath.join(folder, ...depth(entry.member)) }))
    .toSorted((left, right) => depth(left.member).length - depth(right.member).length);
  const first = ordered.find((entry) => entry.member === input.set.members[0]) ?? ordered[0]!;
  if (await exists(manifest)) {
    const branch = await branchOf(first.path);
    if (branch === null) {
      throw new BundleError("failed", `${first.path} exists and is not on a branch.`);
    }
    return { worktreePath: folder, branch };
  }
  // Members without a manifest are an attempt that was cut. Its branches hold
  // nothing but the base commit, so they go with it; any other branch stays.
  const leftover: Array<BuiltMember> = [];
  for (const entry of ordered) {
    if (!(await exists(entry.path))) continue;
    const top = await runGit(entry.path, ["rev-parse", "--show-toplevel"], { allowFailure: true });
    const [real, expected] = await Promise.all(
      [top.stdout.trim(), entry.path].map((path) => NodeFSP.realpath(path).catch(() => path)),
    );
    if (top.code !== 0 || real !== expected) continue;
    const branch = await branchOf(entry.path);
    const untouched =
      branch !== null && (await refCommit(entry.path, "HEAD")) === entry.member.baseCommit;
    leftover.push({ root: entry.root, path: entry.path, branch: untouched ? branch : null });
  }
  await removeBuilt(leftover);
  await NodeFSP.rmdir(folder).catch(() => undefined);
  if (await exists(folder)) {
    throw new BundleError(
      "failed",
      `${folder} already exists and is not this handoff's. Move it away and hand off again.`,
    );
  }
  const built: Array<BuiltMember> = [];
  let branchOfFirst: string | null = null;
  try {
    for (const entry of ordered) {
      const { member, root, path } = entry;
      try {
        const held = await knownCommits(root, [member.commit, member.baseCommit]);
        if (!held.includes(member.commit) || !held.includes(member.baseCommit)) {
          throw new BundleError("missing_prerequisites", "its work is not on this machine.");
        }
        const branch = await availableBranch({
          root,
          branch: member.branch,
          sourceLabel: input.sourceLabel,
          sourceThreadId: input.sourceThreadId,
        });
        await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
        await runGit(root, ["worktree", "add", "-q", "-b", branch, path, member.baseCommit]);
        built.push({ root, path, branch });
        await applyCheckpointToWorktree({
          worktreePath: path,
          baseCommit: member.baseCommit,
          checkpointCommit: member.commit,
        });
        await copyRequiredFiles({
          fromRoot: root,
          toRoot: path,
          paths: member.requiredSecretPaths ?? [],
        });
        if (entry === first) branchOfFirst = branch;
      } catch (cause) {
        throw new BundleError(
          cause instanceof BundleError ? cause.code : "failed",
          `${memberName(member.repositoryPath)}: ${describe(cause)}`,
        );
      }
    }
    await NodeFSP.writeFile(
      manifest,
      JSON.stringify({
        version: 1,
        members: ordered.map((entry) => ({
          repository: entry.root,
          relativePath: depth(entry.member).join(NodePath.sep),
        })),
      }),
    );
  } catch (cause) {
    await removeBuilt(built);
    await NodeFSP.rm(folder, { recursive: true, force: true });
    throw cause;
  }
  return { worktreePath: folder, branch: branchOfFirst! };
}
