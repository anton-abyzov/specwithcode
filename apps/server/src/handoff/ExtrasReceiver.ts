// @effect-diagnostics nodeBuiltinImport:off - a received bundle is a plain file Git reads.
/**
 * The receiving side of Sync extras (1390 AC-13). Another machine sends work
 * Git does not carry as a bundle; it lands here as a branch
 * `swc/from-{machine}/{leaf}` and nowhere else. Nothing is put into a working
 * folder, and no branch of this machine's own, checked out or not, is moved.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { EnvironmentId, HandoffModeErrorCode, Project } from "@specweave-studio/contracts";
import * as KeyedLock from "@specweave-studio/shared/KeyedLock";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runGit } from "../fleet/folderTransfer/git.ts";
import { projectInGrant } from "../fleet/workGrantPolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  applyBundle,
  BundleError,
  knownCommits,
  pinCommit,
  refCommit,
  resolveRepositoryPath,
} from "./bundleGit.ts";
import { refComponent } from "./checkpointGit.ts";
import { HandoffMode } from "./HandoffMode.ts";
import { NOT_LINKED_HERE } from "./handoffPreflight.ts";
import { HandoffRefusal, type ReceiverCaller } from "./HandoffReceiver.ts";
import { ambiguousLinkMessage, linkedLocalProject } from "./handoffState.ts";
import type {
  ExtrasNegotiateRequest,
  ExtrasReplicateMeta,
  ExtrasReplicateResponse,
  NegotiateResponse,
} from "./handoffWire.ts";

const EXTRAS_INCOMING_REF_PREFIX = "refs/specwithcode/extras-incoming/";
const BESIDE_ATTEMPTS = 20;

/** Six characters of the operation id, for a branch that must sit beside another. */
export function extraId(operationId: string): string {
  const plain = operationId.toLowerCase().replace(/[^0-9a-z]/g, "");
  return plain.length >= 6
    ? plain.slice(0, 6)
    : NodeCrypto.createHash("sha256").update(operationId).digest("hex").slice(0, 6);
}

/** `swc/from-{machine}/{leaf}`, the machine's label made safe for a ref name. */
export function extraBranchName(sourceLabel: string, leaf: string): string {
  return `swc/from-${refComponent(sourceLabel)}/${leaf}`;
}

/**
 * Branches checked out here, in the project folder or in any worktree of the
 * repository. A branch under a rebase or a bisect counts: Git shows its
 * worktree as detached while it still owns the branch.
 */
export async function checkedOutBranches(root: string): Promise<Set<string>> {
  const listed = await runGit(root, ["worktree", "list", "--porcelain"]);
  const out = new Set<string>();
  const worktrees: Array<string> = [];
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) worktrees.push(line.slice("worktree ".length));
    if (line.startsWith("branch refs/heads/")) out.add(line.slice("branch refs/heads/".length));
  }
  const head = "refs/heads/";
  await Promise.all(
    worktrees.map(async (worktree) => {
      const gitDir = await runGit(worktree, ["rev-parse", "--absolute-git-dir"], {
        allowFailure: true,
      });
      if (gitDir.code !== 0) return;
      for (const file of ["rebase-merge/head-name", "rebase-apply/head-name", "BISECT_START"]) {
        const name = await NodeFSP.readFile(NodePath.join(gitDir.stdout.trim(), file), "utf8")
          .then((text) => text.trim())
          .catch(() => "");
        if (name === "") continue;
        if (name.startsWith(head)) out.add(name.slice(head.length));
        // A bisect records the bare branch name (or a commit, which names no branch).
        else if (file === "BISECT_START") out.add(name);
      }
    }),
  );
  return out;
}

/**
 * Moves an arrival branch forward from the head it was read at, to `commit`,
 * which the hidden ref `via` of this repository holds. Git itself does the
 * move, as a fetch from the repository into its own branch with no `+`:
 *
 * - Git refuses it for a branch any worktree has checked out, also one checked
 *   out after the worktrees were listed; a plain ref update would move the
 *   branch under that worktree.
 * - Git moves the branch only when the new head continues the head Git itself
 *   read, and writes it only if the branch still is at that head. A branch
 *   that changed between the read here and the move is therefore never
 *   written over: it moves only when `commit` continues what it holds now.
 */
export async function moveBranchForward(input: {
  readonly root: string;
  readonly branch: string;
  readonly commit: string;
  /** A ref of this repository that is at `commit`. */
  readonly via: string;
  readonly from: string;
}): Promise<boolean> {
  const { root, branch, commit, via } = input;
  if ((await refCommit(root, `refs/heads/${branch}`)) !== input.from) return false;
  if ((await refCommit(root, via)) !== commit || /[:+*^]/.test(`${via}${branch}`)) return false;
  const moved = await runGit(
    root,
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-prune",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--refmap=",
      ".",
      `${via}:refs/heads/${branch}`,
    ],
    { allowFailure: true },
  );
  return moved.code === 0 && (await refCommit(root, `refs/heads/${branch}`)) === commit;
}

/**
 * What arrivals in one repository are serialised by: the real path of its Git
 * data, the same for the project folder, a link to it and every worktree of
 * it, so two arrivals never work in one repository at once.
 */
export async function arrivalLockKey(root: string): Promise<string> {
  const common = await runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    allowFailure: true,
  });
  const folder = common.code === 0 && common.stdout.trim().length > 0 ? common.stdout.trim() : root;
  return NodeFSP.realpath(folder).catch(() => NodePath.resolve(folder));
}

/**
 * Removes the hidden refs an arrival that never finished left behind (the
 * server stopped mid-way). Arrivals in one repository run one at a time, so
 * every such ref but the current one's belongs to a dead operation.
 */
export async function sweepStaleIncomingRefs(root: string, keep: string): Promise<void> {
  const listed = await runGit(
    root,
    ["for-each-ref", "--format=%(refname)", EXTRAS_INCOMING_REF_PREFIX],
    { allowFailure: true },
  );
  if (listed.code !== 0) return;
  for (const ref of listed.stdout.split("\n")) {
    if (!ref.startsWith(EXTRAS_INCOMING_REF_PREFIX) || ref === keep) continue;
    await runGit(root, ["update-ref", "-d", ref], { allowFailure: true });
  }
}

export interface LandedExtra {
  readonly branch: string;
  readonly landed: ExtrasReplicateResponse["landed"];
}

/**
 * Lands one extra as a branch. The bundle is fetched into a hidden ref first;
 * the branch is then created only where no ref of that name exists, or moved
 * forward when the new head continues it (`moveBranchForward`). When the plain name is checked out
 * here, holds other work, or cannot be created, the extra arrives beside it as
 * `{name}-{id}`. A repeated send of the same extra changes nothing.
 */
export async function landExtra(input: {
  readonly root: string;
  readonly bundle: Uint8Array | null;
  readonly commit: string;
  readonly sourceLabel: string;
  readonly leaf: string;
  readonly operationId: string;
}): Promise<LandedExtra> {
  const { root, commit } = input;
  const base = extraBranchName(input.sourceLabel, input.leaf);
  const valid = async (name: string) =>
    !name.includes("\n") &&
    (await runGit(root, ["check-ref-format", "--branch", name], { allowFailure: true })).code === 0;
  if (input.leaf.length === 0 || input.leaf.startsWith("-") || !(await valid(base))) {
    throw new BundleError("invalid", "The branch name cannot be used here.");
  }
  const incoming = `${EXTRAS_INCOMING_REF_PREFIX}${refComponent(input.operationId)}/${NodeCrypto.createHash(
    "sha256",
  )
    .update(input.leaf)
    .digest("hex")
    .slice(0, 16)}`;
  try {
    await sweepStaleIncomingRefs(root, incoming);
    if (input.bundle === null || input.bundle.byteLength === 0) {
      await pinCommit({ root, commit, targetRef: incoming });
    } else {
      const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "swc-extras-incoming-"));
      try {
        const bundlePath = NodePath.join(scratch, "extra.bundle");
        await NodeFSP.writeFile(bundlePath, input.bundle, { mode: 0o600 });
        await applyBundle({ root, bundlePath, commit, targetRef: incoming });
      } finally {
        await NodeFSP.rm(scratch, { recursive: true, force: true });
      }
    }
    const checkedOut = await checkedOutBranches(root);
    /** Creates the branch only if no ref of that name exists. */
    const create = async (name: string) =>
      (
        await runGit(root, ["update-ref", `refs/heads/${name}`, commit, ""], {
          allowFailure: true,
        })
      ).code === 0;
    let reason: "beside" | "checked-out" = "beside";
    const existing = await refCommit(root, `refs/heads/${base}`);
    // Already there, checked out or not: a repeated send adds no branch.
    if (existing === commit) return { branch: base, landed: "unchanged" };
    if (checkedOut.has(base)) {
      reason = "checked-out";
    } else {
      if (existing === null) {
        if (await create(base)) return { branch: base, landed: "created" };
      } else {
        // Moves only from the head just read, and never under a worktree that has it checked out.
        if (await moveBranchForward({ root, branch: base, commit, via: incoming, from: existing }))
          return { branch: base, landed: "moved-forward" };
      }
    }
    const stem = `${base}-${extraId(input.operationId)}`;
    for (let attempt = 1; attempt <= BESIDE_ATTEMPTS; attempt += 1) {
      const name = attempt === 1 ? stem : `${stem}-${attempt}`;
      if (checkedOut.has(name) || !(await valid(name))) continue;
      const existing = await refCommit(root, `refs/heads/${name}`);
      if (existing === commit) return { branch: name, landed: reason };
      if (existing === null && (await create(name))) return { branch: name, landed: reason };
    }
    throw new BundleError("failed", `Could not name a branch for the work under ${stem}.`);
  } finally {
    await runGit(root, ["update-ref", "-d", incoming], { allowFailure: true });
  }
}

type GrantedProject = Pick<Project, "id" | "title" | "workspaceRoot" | "workspaceSettings"> & {
  readonly deletedAt?: string | null | undefined;
};

/**
 * The project here that extras from `sourceProjectId` may land in, or why none:
 * the request must name the machine that is asking, the project must be linked
 * to the source's both ways, it is never a personal project, and the work grant
 * that machine holds here must cover it.
 */
export function extrasProject<P extends GrantedProject>(input: {
  readonly projects: ReadonlyArray<P>;
  readonly selfEnvironmentId: EnvironmentId;
  readonly caller: ReceiverCaller;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceProjectId: string;
}):
  | { readonly kind: "project"; readonly project: P }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly code: HandoffModeErrorCode;
      readonly message: string;
      readonly check?: "grant" | "project-link";
    } {
  const { caller } = input;
  if (caller.sourceEnvironmentId !== input.sourceEnvironmentId) {
    return {
      kind: "refused",
      status: 403,
      code: "invalid",
      message: "the request names another machine than the one asking",
    };
  }
  if (input.sourceEnvironmentId === input.selfEnvironmentId) {
    return { kind: "refused", status: 409, code: "invalid", message: "this is the same machine" };
  }
  const found = linkedLocalProject(
    input.projects,
    input.selfEnvironmentId,
    input.sourceEnvironmentId,
    input.sourceProjectId,
  );
  if (found.kind === "ambiguous") {
    return {
      kind: "refused",
      status: 409,
      code: "invalid",
      message: ambiguousLinkMessage(found.projects),
      check: "project-link",
    };
  }
  if (found.kind === "none" || isPersonalAssistantProject(found.project)) {
    return {
      kind: "refused",
      status: 409,
      code: "invalid",
      message: NOT_LINKED_HERE,
      check: "project-link",
    };
  }
  if (
    caller.grant === null ||
    !projectInGrant(caller.grant.projects, caller.sourceEnvironmentId, found.project)
  ) {
    return {
      kind: "refused",
      status: 403,
      code: "needs_grant",
      message: `no work grant for ${found.project.title}`,
      check: "grant",
    };
  }
  return { kind: "project", project: found.project };
}

export class ExtrasReceiver extends Context.Service<
  ExtrasReceiver,
  {
    readonly negotiate: (
      caller: ReceiverCaller,
      request: ExtrasNegotiateRequest,
    ) => Effect.Effect<NegotiateResponse, HandoffRefusal>;
    readonly replicate: (
      caller: ReceiverCaller,
      meta: ExtrasReplicateMeta,
      bundle: Uint8Array | null,
    ) => Effect.Effect<ExtrasReplicateResponse, HandoffRefusal>;
  }
>()("specweave-studio/handoff/ExtrasReceiver") {}

const make = Effect.gen(function* () {
  const handoff = yield* HandoffMode;
  const projects = yield* ProjectService.ProjectService;
  const locks = yield* KeyedLock.make<string>();
  const label = handoff.machineLabel;
  const at = (message: string) => `${label}: ${message}`;

  const fromGit = (cause: unknown) =>
    cause instanceof BundleError
      ? new HandoffRefusal({
          status: cause.code === "failed" ? 500 : 409,
          code:
            cause.code === "too_large"
              ? "too_large"
              : cause.code === "failed"
                ? "failed"
                : "invalid",
          message: at(cause.message),
        })
      : new HandoffRefusal({ status: 500, code: "failed", message: at("Git did not finish") });

  /** The repository the extra is for, inside the project this caller may send work to. */
  const repositoryRoot = Effect.fn("ExtrasReceiver.repositoryRoot")(function* (
    caller: ReceiverCaller,
    request: {
      readonly sourceEnvironmentId: EnvironmentId;
      readonly sourceProjectId: string;
      readonly repositoryPath: string;
    },
  ) {
    const snapshot = yield* projects.snapshot.pipe(
      Effect.mapError(
        () =>
          new HandoffRefusal({
            status: 500,
            code: "failed",
            message: at("could not read its projects"),
          }),
      ),
    );
    const found = extrasProject({
      projects: snapshot.projects,
      selfEnvironmentId: handoff.environmentId,
      caller,
      sourceEnvironmentId: request.sourceEnvironmentId,
      sourceProjectId: request.sourceProjectId,
    });
    if (found.kind === "refused") {
      return yield* new HandoffRefusal({
        status: found.status,
        code: found.code,
        message: at(found.message),
        ...(found.check === undefined ? {} : { check: found.check }),
      });
    }
    return yield* Effect.tryPromise({
      try: () => resolveRepositoryPath(found.project.workspaceRoot, request.repositoryPath),
      catch: fromGit,
    });
  });

  return ExtrasReceiver.of({
    negotiate: (caller, request) =>
      Effect.gen(function* () {
        const root = yield* repositoryRoot(caller, request);
        const known = yield* Effect.tryPromise({
          try: () => knownCommits(root, request.candidates),
          catch: fromGit,
        });
        return { known };
      }),
    replicate: (caller, meta, bundle) =>
      Effect.gen(function* () {
        const root = yield* repositoryRoot(caller, meta);
        // One arrival at a time per repository: names are chosen by what exists.
        const key = yield* Effect.tryPromise({ try: () => arrivalLockKey(root), catch: fromGit });
        const landed = yield* locks.withLock(
          key,
          Effect.tryPromise({
            try: () =>
              landExtra({
                root,
                bundle,
                commit: meta.commit,
                sourceLabel: meta.sourceLabel,
                leaf: meta.leaf,
                operationId: meta.operationId,
              }),
            catch: fromGit,
            // A caller that goes away mid-way does not free the repository while Git still
            // works in it: the next arrival would take this one's hidden ref for a dead one.
          }).pipe(Effect.uninterruptible),
        );
        return { machineLabel: label.slice(0, 120), branch: landed.branch, landed: landed.landed };
      }),
  });
});

export const layer = Layer.effect(ExtrasReceiver, make);
