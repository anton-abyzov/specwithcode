// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - members are plain Git worktrees and bundle files.
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
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  HANDOFF_MAX_BUNDLE_BYTES,
  HANDOFF_MAX_SNAPSHOT_FILE_BYTES,
  HANDOFF_MAX_SNAPSHOT_FILES,
  type HandoffCheckpoint,
  type HandoffSkippedFile,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import { FolderGitError, runGit } from "../fleet/folderTransfer/git.ts";
import { worktreeSetManifestPath } from "../worktreeSet.ts";
import {
  applyBundle,
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
  pinCommit,
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
  HANDOFF_SET_FRAME_PATH,
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
/** How long a destination keeps an offered set's members before it drops them. */
export const SET_OFFER_TTL_MS = 10 * 60_000;
const SET_OFFERS_MAX = 64;
/** How many left-out files a stored checkpoint lists (`HandoffCheckpoint.skipped`). */
const SKIPPED_LISTED = 200;

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
    | "commit"
    | "baseCommit"
    | "branch"
    | "ref"
    | "skipped"
    | "overLimit"
    | "requiredSecretPaths"
    | "sourceRoot"
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
      // The verdict of the writer of the very checkpoint that is sent. The
      // folder as it is now may differ; the list alone holds only the first 200.
      const verdict = input.checkpoint.overLimit;
      const left =
        verdict === undefined
          ? input.checkpoint.skipped.find((file) => file.reason !== "submodule")
          : verdict;
      if (left != null) throw overLimit(name, left, limits);
      if (verdict === undefined && input.checkpoint.skipped.length >= SKIPPED_LISTED) {
        throw new SetMoveError(
          "invalid",
          `${name}: this checkpoint lists the first ${SKIPPED_LISTED} files it left out and does not say whether a file was over the limit. Hand off again to take a new checkpoint.`,
        );
      }
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
  /** Offers this set to the destination and returns what it says it can take. */
  readonly offer: (id: string) => Effect.Effect<ReadonlyArray<string> | undefined, PeerFailure>;
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
    // Asked every time, for this set alone: what the machine answered a minute
    // ago says nothing about the build it runs now.
    const offer = NodeCrypto.randomUUID();
    if (!input.self) {
      if (!hasWorktreeSets(yield* input.offer(offer))) {
        return yield* new HandoffPeerError({
          code: "invalid",
          check: "version",
          message: `Needs update: this thread works in ${members.length} repositories, and ${input.destinationLabel} runs a SpecWithCode that moves one repository per thread. Update SpecWithCode on ${input.destinationLabel} first. Nothing was sent.`,
          uncertain: false,
          needsUpdate: true,
        });
      }
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
            repositoryPath: HANDOFF_SET_FRAME_PATH,
            setPart: { offer, repositoryPath: member.repositoryPath, commit: member.commit },
          },
          yield* bytesOf(index),
        )
        .pipe(Effect.mapError(named(member)));
    }
    const nested = new Set(members.map((member) => member.repositoryPath));
    return yield* input.replicate(
      {
        ...input.meta,
        repositoryPath: HANDOFF_SET_FRAME_PATH,
        // A member's folder inside the project's own worktree is not something left behind.
        checkpoint: {
          ...checkpoint,
          skipped: checkpoint.skipped.filter(
            (file) => !(file.reason === "submodule" && nested.has(file.path)),
          ),
        },
        set: {
          offer,
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
    offer: (id) =>
      via.peers
        .preflight(destination, {
          sourceEnvironmentId: self,
          protocolVersion: HANDOFF_PROTOCOL_VERSION,
          appVersion: HANDOFF_APP_VERSION,
          capabilities: HANDOFF_CAPABILITIES,
          setOffer: { id, sourceThreadId: input.meta.sourceThreadId },
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
async function memberRoots<Member extends Pick<ReplicateSetMember, "repositoryPath">>(
  projectRoot: string,
  set: { readonly members: ReadonlyArray<Member> },
) {
  const seen = new Set<string>();
  const out: Array<{ readonly member: Member; readonly root: string }> = [];
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

/** The refs one set's last frame writes, kept on disk while they are written. */
export interface SetLanding {
  readonly sourceEnvironmentId: string;
  readonly sourceThreadId: string;
  /** The offer the set arrived under, and each member's commit: together, this very send. */
  readonly offer: string;
  readonly members: ReadonlyArray<Pick<ReplicateSetMember, "repositoryPath" | "commit">>;
  readonly commit: string;
  readonly targetRef: string;
  readonly refs: Array<{
    readonly root: string;
    /** What the ref was before, or null when there was none. */
    readonly before: string | null;
    readonly commit: string;
  }>;
}

interface SetOffer {
  /** The source machine and thread the offer was opened for. */
  readonly key: string;
  readonly timer: ReturnType<typeof setTimeout>;
  /** Where the members' bundles wait: a private folder, outside every repository. */
  directory: string | null;
  readonly parts: Map<string, { readonly commit: string; readonly file: string | null }>;
}

const notOffered = () =>
  new BundleError(
    "invalid",
    "This machine did not agree to take a worktree set in this handoff, so nothing of it was kept. Hand off again.",
  );

/**
 * The sets a destination has agreed to take. A member's frame is kept as a
 * file under its offer and reaches no repository until the thread's own frame
 * arrives; then every member's ref is written, or none is. An offer that is
 * refused, replaced by a later one for the same thread, or older than
 * `SET_OFFER_TTL_MS` is dropped with its files.
 */
export function makeSetOffers(
  ttlMs: number = SET_OFFER_TTL_MS,
  at: {
    /** A folder that outlives the process. Without one, a private temporary folder. */
    readonly directory?: string | undefined;
    /**
     * Whether the record this machine holds for the thread is of this very
     * send. The thread's own commit does not say: a resend whose other members
     * changed carries the same one.
     */
    readonly stored?: (landing: SetLanding) => boolean | Promise<boolean>;
    /** Runs after each ref is written. A test stops a receiver here. */
    readonly afterRef?: () => Promise<void>;
  } = {},
) {
  const offers = new Map<string, SetOffer>();
  let home: Promise<string> | null = null;
  const directory = () =>
    (home ??=
      at.directory === undefined
        ? NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-handoff-set-"))
        : NodeFSP.mkdir(at.directory, { recursive: true, mode: 0o700 }).then(() => at.directory!));
  const takeBack = async (landing: SetLanding) => {
    for (const { root, before, commit } of landing.refs.toReversed()) {
      // Only where the ref still is what this landing wrote: a later one is not undone.
      await runGit(
        root,
        before === null
          ? ["update-ref", "-d", landing.targetRef, commit]
          : ["update-ref", landing.targetRef, before, commit],
        { allowFailure: true },
      ).catch(() => undefined);
    }
  };
  let recovered: Promise<void> | null = null;
  /**
   * What a receiver that stopped left behind, settled once before this one
   * takes anything: bundles that waited are dropped, and a set whose refs were
   * being written is taken back unless the thread's record was stored.
   */
  const recover = () =>
    (recovered ??= (async () => {
      const root = await directory();
      await NodeFSP.rm(NodePath.join(root, "staged"), { recursive: true, force: true });
      const landings = NodePath.join(root, "landings");
      for (const name of await NodeFSP.readdir(landings).catch(() => [] as Array<string>)) {
        const file = NodePath.join(landings, name);
        const landing = await NodeFSP.readFile(file, "utf8").then(
          (text) => JSON.parse(text) as SetLanding,
          () => null,
        );
        if (landing !== null && Array.isArray(landing.refs)) {
          const kept = await Promise.resolve(at.stored?.(landing)).catch(() => null);
          // Not known either way: left for the next start.
          if (kept === null) continue;
          if (kept !== true) await takeBack(landing);
        }
        await NodeFSP.rm(file, { force: true });
      }
    })().catch(() => undefined));
  const keyOf = (sourceEnvironmentId: string, sourceThreadId: string) =>
    `${sourceEnvironmentId}\0${sourceThreadId}`;
  const drop = async (id: string) => {
    const offer = offers.get(id);
    if (offer === undefined) return;
    offers.delete(id);
    clearTimeout(offer.timer);
    if (offer.directory !== null) {
      await NodeFSP.rm(offer.directory, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  const open = async (sourceEnvironmentId: string, sourceThreadId: string, id: string) => {
    await recover();
    const key = keyOf(sourceEnvironmentId, sourceThreadId);
    // A later offer for the thread replaces the earlier one: that send was given up.
    for (const [other, offer] of [...offers]) if (offer.key === key) await drop(other);
    while (offers.size >= SET_OFFERS_MAX) await drop(offers.keys().next().value!);
    const timer = setTimeout(() => void drop(id), ttlMs);
    timer.unref?.();
    const offer: SetOffer = { key, timer, directory: null, parts: new Map() };
    offers.set(id, offer);
    return offer;
  };
  const save = async (offer: SetOffer, bundle: Uint8Array | null) => {
    if (bundle === null || bundle.byteLength === 0) return null;
    if (offer.directory === null) {
      const staged = NodePath.join(await directory(), "staged");
      await NodeFSP.mkdir(staged, { recursive: true, mode: 0o700 });
      offer.directory = await NodeFSP.mkdtemp(NodePath.join(staged, "offer-"));
    }
    const file = NodePath.join(offer.directory, `${NodeCrypto.randomUUID()}.bundle`);
    await NodeFSP.writeFile(file, bundle, { mode: 0o600 });
    return file;
  };
  /**
   * One frame of a set. A member's frame is kept and answers `null`. The
   * thread's own frame writes every member's ref and answers the set with a
   * way to take those refs back, for a caller that then refuses the thread.
   */
  const take = async (input: {
    readonly sourceEnvironmentId: string;
    readonly sourceThreadId: string;
    /** This machine asking itself: it never offers, and is taken at its word. */
    readonly self: boolean;
    readonly projectRoot: string;
    readonly targetRef: string;
    readonly commit: string;
    readonly part: ReplicateMeta["setPart"];
    readonly set: ReplicateSet | undefined;
    readonly bundle: Uint8Array | null;
  }): Promise<{
    readonly set: ReplicateSet;
    /** Takes the refs back: the thread was refused after they were written. */
    readonly undo: () => Promise<void>;
    /** The thread's record is stored: the refs are its own from here on. */
    readonly done: () => Promise<void>;
  } | null> => {
    await recover();
    const id = input.part?.offer ?? input.set?.offer;
    if (id === undefined) throw notOffered();
    const offer =
      offers.get(id) ??
      (input.self ? await open(input.sourceEnvironmentId, input.sourceThreadId, id) : undefined);
    if (
      offer === undefined ||
      offer.key !== keyOf(input.sourceEnvironmentId, input.sourceThreadId)
    ) {
      throw notOffered();
    }
    const { part, set } = input;
    if (part !== undefined) {
      if (offer.parts.size >= HANDOFF_SET_MAX_MEMBERS) throw notOffered();
      await memberRoots(input.projectRoot, { members: [part] });
      offer.parts.set(part.repositoryPath, {
        commit: part.commit,
        file: await save(offer, input.bundle),
      });
      return null;
    }
    if (set === undefined) throw notOffered();
    const landing: SetLanding = {
      sourceEnvironmentId: input.sourceEnvironmentId,
      sourceThreadId: input.sourceThreadId,
      offer: id,
      members: set.members.map(({ repositoryPath, commit }) => ({ repositoryPath, commit })),
      commit: input.commit,
      targetRef: input.targetRef,
      refs: [],
    };
    const landings = NodePath.join(await directory(), "landings");
    const file = NodePath.join(landings, `${NodeCrypto.randomUUID()}.json`);
    const done = () => NodeFSP.rm(file, { force: true }).catch(() => undefined);
    const undo = async () => {
      await takeBack(landing);
      await done();
    };
    try {
      const first = set.members[0];
      if (first === undefined) {
        throw new BundleError("invalid", "The set names no repository.");
      }
      offer.parts.set(first.repositoryPath, {
        commit: input.commit,
        file: await save(offer, input.bundle),
      });
      const steps: Array<{
        readonly member: ReplicateSetMember;
        readonly root: string;
        readonly file: string | null;
      }> = [];
      for (const { member, root } of await memberRoots(input.projectRoot, set)) {
        const held = offer.parts.get(member.repositoryPath);
        if (held === undefined || held.commit !== member.commit) {
          throw invalid(member, "its work did not arrive here, so nothing of the thread is kept.");
        }
        landing.refs.push({
          root,
          before: await refCommit(root, input.targetRef),
          commit: member.commit,
        });
        steps.push({ member, root, file: held.file });
      }
      // On disk before the first ref is written, so a receiver that stops
      // between two of them finds what to take back when it starts again.
      await NodeFSP.mkdir(landings, { recursive: true, mode: 0o700 });
      await NodeFSP.writeFile(`${file}.new`, JSON.stringify(landing), { mode: 0o600, flush: true });
      await NodeFSP.rename(`${file}.new`, file);
      for (const { member, root, file: bundlePath } of steps) {
        await (
          bundlePath === null
            ? pinCommit({ root, commit: member.commit, targetRef: input.targetRef })
            : applyBundle({
                root,
                bundlePath,
                commit: member.commit,
                targetRef: input.targetRef,
              })
        ).catch((cause) => {
          throw member === first
            ? cause
            : new BundleError(
                cause instanceof BundleError ? cause.code : "failed",
                `${memberName(member.repositoryPath)}: ${describe(cause)}`,
              );
        });
        await at.afterRef?.();
      }
    } catch (cause) {
      await undo();
      throw cause;
    } finally {
      await drop(id);
    }
    return { set, undo, done };
  };
  return { open, take, drop, size: () => offers.size };
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
 * Git's own list of the first member's worktrees, or null. The name only finds
 * the folder; `materializeSet` decides from its owner record whose it is.
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

/** True when the set a machine stored for a thread is the one this landing was writing. */
export const isLandedSet = (held: ReplicateSet | undefined, landing: SetLanding) =>
  held !== undefined &&
  typeof landing.offer === "string" &&
  held.offer === landing.offer &&
  Array.isArray(landing.members) &&
  held.members.length === landing.members.length &&
  held.members.every(
    (member, index) =>
      member.repositoryPath === landing.members[index]?.repositoryPath &&
      member.commit === landing.members[index]?.commit,
  );

/** The part of a set's folder name that tells one handoff's folder from another's. */
export const setOwnerTag = (owner: string) =>
  NodeCrypto.createHash("sha256").update(owner).digest("hex").slice(0, 8);

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

const gitTree = async (root: string, commit: string) =>
  (
    await runGit(root, ["rev-parse", "--verify", "-q", `${commit}^{tree}`], { allowFailure: true })
  ).stdout.trim();

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

/** Which handoff a set's folder was built for, and what it put there. Beside the manifest. */
interface OwnerRecord {
  readonly version: 1;
  readonly owner: string;
  readonly members: ReadonlyArray<{
    readonly repositoryPath: string;
    readonly branch: string;
    readonly commit: string;
    readonly baseCommit: string;
  }>;
}

const ownerRecordPath = (folder: string) =>
  NodePath.join(NodePath.dirname(folder), `.${NodePath.basename(folder)}.handoff-set.json`);

async function readOwnerRecord(folder: string): Promise<OwnerRecord | null> {
  try {
    const record = JSON.parse(
      await NodeFSP.readFile(ownerRecordPath(folder), "utf8"),
    ) as OwnerRecord;
    const sound =
      typeof record?.owner === "string" &&
      Array.isArray(record.members) &&
      record.members.every(
        (member) =>
          typeof member?.repositoryPath === "string" &&
          typeof member.branch === "string" &&
          typeof member.commit === "string" &&
          typeof member.baseCommit === "string",
      );
    return sound ? record : null;
  } catch {
    return null;
  }
}

/** True when `path` is the top of a checkout of its own, on `branch`. */
async function isCheckoutOn(path: string, branch: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  const top = await runGit(path, ["rev-parse", "--show-toplevel"], { allowFailure: true }).catch(
    () => null,
  );
  if (top === null || top.code !== 0) return false;
  const [real, expected] = await Promise.all(
    [top.stdout.trim(), path].map((each) => NodeFSP.realpath(each).catch(() => each)),
  );
  return real === expected && (await branchOf(path)) === branch;
}

/** The tree a commit of everything in the checkout would have, less `except`. */
async function checkoutTree(path: string, except: ReadonlyArray<string>): Promise<string> {
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-handoff-tree-"));
  const env = { GIT_INDEX_FILE: NodePath.join(scratch, "index") };
  try {
    await runGit(path, ["read-tree", "HEAD"], { env });
    await runGit(path, ["add", "-A"], { env });
    // Left out after the fact: a path that is ignored or absent fails as a pathspec.
    if (except.length > 0) {
      await runGit(
        path,
        ["rm", "-r", "-f", "-q", "--cached", "--ignore-unmatch", "--", ...except],
        {
          env,
        },
      );
    }
    return (await runGit(path, ["write-tree"], { env })).stdout.trim();
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

/**
 * True when the checkout holds nothing but what this build put there. Its
 * index and its files must be one of the three states a build passes through:
 * both at the base, both at the checkpoint, or the index at the base under the
 * checkpoint's files. A staged edit, a file Git ignores that the build did
 * not copy, or a copied file edited since is someone's work: removing the
 * checkout would lose it.
 */
async function asBuilt(
  path: string,
  expected: {
    readonly base: string;
    readonly checkpoint: string;
    /** Other members checked out inside this one. */
    readonly inside: ReadonlyArray<string>;
    /** Files the build copied in from `copiedFrom`, the member's repository here. */
    readonly secrets: ReadonlyArray<string>;
    readonly copiedFrom: string;
  },
): Promise<boolean> {
  // A copied file is this build's only while it is still the file that was
  // copied. Compared by digest: what either one holds is never read out.
  const digest = (file: string) =>
    NodeFSP.readFile(file).then(
      (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      () => null,
    );
  for (const secret of expected.secrets) {
    const segments = secret.split("/").filter((each) => each.length > 0 && each !== ".");
    if (NodePath.isAbsolute(secret) || segments.includes("..")) continue;
    const here = await digest(NodePath.join(path, ...segments));
    if (here !== null && here !== (await digest(NodePath.join(expected.copiedFrom, ...segments)))) {
      return false;
    }
  }
  const staged = await runGit(path, ["write-tree"], { allowFailure: true });
  if (staged.code !== 0) return false;
  const index = staged.stdout.trim();
  const files = await checkoutTree(path, [...expected.inside, ...expected.secrets]);
  const known =
    (index === expected.base && (files === expected.base || files === expected.checkpoint)) ||
    (index === expected.checkpoint && files === expected.checkpoint);
  if (!known) return false;
  const ignored = await runGit(path, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  return ignored.stdout
    .split("\0")
    .map((each) => each.replace(/\/$/, ""))
    .filter((each) => each.length > 0)
    .every(
      (each) =>
        expected.secrets.includes(each) ||
        expected.inside.some((member) => each === member || each.startsWith(`${member}/`)),
    );
}

/** Removes `folder` and the folders in it when not one of them holds a file. */
async function removeEmptyFolders(folder: string): Promise<void> {
  const entries = await NodeFSP.readdir(folder, { withFileTypes: true }).catch(() => null);
  if (entries === null) return;
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyFolders(NodePath.join(folder, entry.name));
  }
  await NodeFSP.rmdir(folder).catch(() => undefined);
}

/**
 * Builds the set in `folder` for the handoff `owner` (source machine, thread
 * and epoch): each member a worktree at its base commit with the checkpoint's
 * files as uncommitted changes, on the source's branch where that name is
 * free. Before anything is built, a record beside the folder says whose it is
 * and which branches it makes; the manifest is written last and says the set
 * is whole.
 *
 * A repeat trusts only that record. A whole set is returned when every member
 * is still checked out on its branch, and refused when one is not. An attempt
 * that was cut is taken down and built again only when each member it left
 * holds exactly what this handoff put there. A folder with no record, another
 * handoff's record or a member someone has worked in since is left as it is,
 * and the answer says so.
 */
export async function materializeSet(input: {
  readonly projectRoot: string;
  readonly folder: string;
  /** The handoff this build belongs to: source machine, thread and epoch. */
  readonly owner: string;
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
  const taken = (why: string) =>
    new BundleError("failed", `${folder} ${why} Move it away and hand off again.`);
  const record = await readOwnerRecord(folder);
  if (record !== null && record.owner !== input.owner) {
    throw taken("holds the work of another handoff.");
  }
  if (record !== null) {
    const recorded = (entry: (typeof ordered)[number]) =>
      record.members.find((member) => member.repositoryPath === entry.member.repositoryPath);
    const same =
      record.members.length === ordered.length &&
      ordered.every((entry) => {
        const member = recorded(entry);
        return (
          member !== undefined &&
          member.commit === entry.member.commit &&
          member.baseCommit === entry.member.baseCommit
        );
      });
    if (same && (await exists(manifest))) {
      for (const entry of ordered) {
        if (!(await isCheckoutOn(entry.path, recorded(entry)!.branch))) {
          throw new BundleError(
            "failed",
            `${memberName(entry.member.repositoryPath)}: its checkout in ${folder} is gone or was moved to another branch since the thread arrived, so the thread is not started with part of its work. Move ${folder} away and hand off again.`,
          );
        }
      }
      return { worktreePath: folder, branch: recorded(first)!.branch };
    }
    // An attempt that was cut, or one for an earlier checkpoint. Every member
    // it left is checked before the first is removed.
    const leftover: Array<BuiltMember> = [];
    const paths = record.members.map((member) => member.repositoryPath);
    for (const member of record.members) {
      const segments = member.repositoryPath.split("/").filter(Boolean);
      const path = NodePath.join(folder, ...segments);
      if (!(await exists(path))) continue;
      const name = memberName(member.repositoryPath);
      const root = await resolveRepositoryPath(input.projectRoot, member.repositoryPath).catch(
        (cause) => {
          throw new BundleError("failed", `${name}: ${describe(cause)}`);
        },
      );
      // Another member checked out inside this one is that member's to answer for.
      const prefix = segments.length === 0 ? "" : `${segments.join("/")}/`;
      const inside = paths
        .map((other) => other.split("/").filter(Boolean).join("/"))
        .filter((other) => other.length > prefix.length && other.startsWith(prefix))
        .map((other) => other.slice(prefix.length));
      const secrets =
        ordered.find((entry) => entry.path === path)?.member.requiredSecretPaths ?? [];
      const untouched =
        (await isCheckoutOn(path, member.branch)) &&
        (await refCommit(path, "HEAD")) === member.baseCommit &&
        (await asBuilt(path, {
          base: await gitTree(root, member.baseCommit),
          checkpoint: await gitTree(root, member.commit),
          inside,
          secrets,
          copiedFrom: root,
        }));
      if (!untouched) {
        throw new BundleError(
          "failed",
          `${name}: its checkout in ${folder} was left by an earlier attempt and has been changed since, so it is not removed. Move ${folder} away and hand off again.`,
        );
      }
      leftover.push({ root, path, branch: member.branch });
    }
    await removeBuilt(leftover);
    await NodeFSP.rm(manifest, { force: true });
    await NodeFSP.rm(ownerRecordPath(folder), { force: true });
    await removeEmptyFolders(folder);
  }
  await NodeFSP.rmdir(folder).catch(() => undefined);
  if (await exists(folder)) throw taken("already exists and is not this handoff's.");
  const built: Array<BuiltMember> = [];
  let branchOfFirst: string | null = null;
  try {
    const branches = new Map<string, string>();
    for (const { member, root } of ordered) {
      try {
        const held = await knownCommits(root, [member.commit, member.baseCommit]);
        if (!held.includes(member.commit) || !held.includes(member.baseCommit)) {
          throw new BundleError("missing_prerequisites", "its work is not on this machine.");
        }
        branches.set(
          member.repositoryPath,
          await availableBranch({
            root,
            branch: member.branch,
            sourceLabel: input.sourceLabel,
            sourceThreadId: input.sourceThreadId,
          }),
        );
      } catch (cause) {
        throw new BundleError(
          cause instanceof BundleError ? cause.code : "failed",
          `${memberName(member.repositoryPath)}: ${describe(cause)}`,
        );
      }
    }
    // Whose folder this is, and what is about to be made in it, before any of it exists.
    await NodeFSP.mkdir(NodePath.dirname(folder), { recursive: true, mode: 0o700 });
    await NodeFSP.writeFile(
      ownerRecordPath(folder),
      JSON.stringify({
        version: 1,
        owner: input.owner,
        members: ordered.map(({ member }) => ({
          repositoryPath: member.repositoryPath,
          branch: branches.get(member.repositoryPath)!,
          commit: member.commit,
          baseCommit: member.baseCommit,
        })),
      } satisfies OwnerRecord),
      { mode: 0o600 },
    );
    for (const entry of ordered) {
      const { member, root, path } = entry;
      try {
        const branch = branches.get(member.repositoryPath)!;
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
    await NodeFSP.rm(ownerRecordPath(folder), { force: true });
    throw cause;
  }
  return { worktreePath: folder, branch: branchOfFirst! };
}
