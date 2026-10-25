// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Watches design folders with node:fs.
/**
 * Designs and design systems for clients (RPC) and agents (MCP). This is
 * where ownership is decided:
 *
 * - An owner is a registered project on this machine or this machine's
 *   Playground. Roots come from the project registry and the app's home,
 *   never from a path a caller sends.
 * - A caller may carry a scope (an agent thread: its own project, or the
 *   Playground for a Scratch thread). Anything outside it is `forbidden`.
 * - Each design says what `members` (the owner's paired devices and linked
 *   machines) and `agents` may do: edit, comment or view. The owner session
 *   on this machine always edits, and only it changes access.
 * - A reference made on another machine resolves through this machine's
 *   linked checkout of the same logical project; a design not pulled here
 *   yet is `not_on_this_machine` naming the member that has it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  DesignError,
  PROJECT_DESIGN_DIR,
  type DesignActor,
  type DesignAddress,
  type DesignApplyInput,
  type DesignAssetPutInput,
  type DesignCopyInput,
  type DesignCreateInput,
  type DesignDocument,
  type DesignExportInput,
  type DesignExportResult,
  type DesignGetInput,
  type DesignGetResult,
  type DesignHistoryResult,
  type DesignListInput,
  type DesignListProblem,
  type DesignListResult,
  type DesignMoveInput,
  type DesignOperation,
  type DesignOwner,
  type DesignOwnerFilter,
  type DesignOwnerInput,
  type DesignRestoreInput,
  type DesignSaveVersionInput,
  type DesignSummary,
  type DesignSystem,
  type DesignSystemAddress,
  type DesignSystemCopyInput,
  type DesignSystemDeleteInput,
  type DesignSystemGetResult,
  type DesignSystemListResult,
  type DesignSystemRenameInput,
  type DesignSystemUsageResult,
  type DesignThreadBinding,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import {
  applyDesignOperations,
  designAccess,
  designAccessAllows,
  designId,
  newDesignDocument,
} from "@specweave-studio/shared/designOps";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import { exportDesign } from "./DesignExport.ts";
import * as Move from "./DesignMove.ts";
import * as Store from "./DesignStore.ts";
import * as SystemFiles from "./systems/SystemFilesStore.ts";

/** The Playground's folder below the app's private state directory. */
export const PLAYGROUND_DESIGN_DIR = "design/playground";
const PLAYGROUND_LABEL = "Playground";
/** A watch never sends faster than this. */
export const DESIGN_WATCH_INTERVAL_MS = 500;
/** A safety re-read for file systems whose change events get lost. */
const WATCH_POLL_MS = 5_000;

/** Who reads the access level: the owner here, `members`, or `agents`. */
export type DesignAudience = "owner" | "members" | "agents";

export interface DesignCaller {
  readonly actor: DesignActor;
  readonly audience: DesignAudience;
  /** The only owner this caller may touch; every owner on this machine when absent. */
  readonly scope?: DesignOwnerInput | undefined;
}

export const ownerCaller: DesignCaller = { actor: { kind: "user" }, audience: "owner" };

/** Who a list problem is about: the label people read and the owner clients match on. */
const problemOwner = (resolved: { readonly owner: DesignOwner; readonly label: string }) => ({
  ownerLabel: resolved.label,
  owner:
    resolved.owner.kind === "project"
      ? ({ kind: "project", projectId: resolved.owner.projectId } as const)
      : ({ kind: "playground" } as const),
});

interface ResolvedOwner {
  readonly owner: DesignOwner;
  readonly label: string;
  readonly base: string;
  /** The design root relative to `base`; references use it as their path prefix. */
  readonly relative: string;
}

export class DesignService extends Context.Service<
  DesignService,
  {
    readonly list: (
      caller: DesignCaller,
      input: typeof DesignListInput.Type,
    ) => Effect.Effect<DesignListResult, DesignError>;
    readonly get: (
      caller: DesignCaller,
      input: DesignGetInput,
    ) => Effect.Effect<DesignGetResult, DesignError>;
    readonly create: (
      caller: DesignCaller,
      input: DesignCreateInput,
    ) => Effect.Effect<DesignGetResult, DesignError>;
    readonly apply: (
      caller: DesignCaller,
      input: DesignApplyInput,
    ) => Effect.Effect<DesignGetResult, DesignError>;
    readonly history: (
      caller: DesignCaller,
      input: DesignAddress,
    ) => Effect.Effect<DesignHistoryResult, DesignError>;
    readonly saveVersion: (
      caller: DesignCaller,
      input: DesignSaveVersionInput,
    ) => Effect.Effect<DesignHistoryResult, DesignError>;
    readonly restore: (
      caller: DesignCaller,
      input: DesignRestoreInput,
    ) => Effect.Effect<DesignGetResult, DesignError>;
    readonly copy: (
      caller: DesignCaller,
      input: DesignCopyInput,
    ) => Effect.Effect<DesignGetResult, DesignError>;
    /**
     * Moves a Playground design into a project here, keeping its id, history,
     * thread and access. Owner only. The old address then answers `not_found`
     * with `movedTo`.
     */
    readonly move: (
      caller: DesignCaller,
      input: DesignMoveInput,
    ) => Effect.Effect<DesignGetResult, DesignError>;
    readonly remove: (
      caller: DesignCaller,
      input: DesignAddress,
    ) => Effect.Effect<{ readonly deleted: boolean }, DesignError>;
    readonly putAsset: (
      caller: DesignCaller,
      input: DesignAssetPutInput,
    ) => Effect.Effect<{ readonly asset: string }, DesignError>;
    /** The file of one of a design's assets, for the signed asset route. */
    readonly assetFile: (
      caller: DesignCaller,
      input: DesignAddress & { readonly asset: string },
    ) => Effect.Effect<string, DesignError>;
    readonly export: (
      caller: DesignCaller,
      input: DesignExportInput,
    ) => Effect.Effect<DesignExportResult, DesignError>;
    /** The document now, then again each time its revision changes. */
    readonly watch: (
      caller: DesignCaller,
      input: DesignAddress,
    ) => Stream.Stream<DesignGetResult, DesignError>;
    readonly systemList: (
      caller: DesignCaller,
      input: { readonly filter: DesignOwnerFilter },
    ) => Effect.Effect<DesignSystemListResult, DesignError>;
    readonly systemGet: (
      caller: DesignCaller,
      input: DesignSystemAddress,
    ) => Effect.Effect<DesignSystemGetResult, DesignError>;
    readonly systemCopy: (
      caller: DesignCaller,
      input: DesignSystemCopyInput,
    ) => Effect.Effect<DesignSystemGetResult, DesignError>;
    /** A new name at `expectedRevision`; the id and folder stay. Users only. */
    readonly systemRename: (
      caller: DesignCaller,
      input: DesignSystemRenameInput,
    ) => Effect.Effect<DesignSystemGetResult, DesignError>;
    /**
     * Removes a system at `expectedRevision`. Users only. Designs that use it
     * keep the id and render without it; `owner` is where it was, for callers
     * that hold state about the system (open import proposals).
     */
    readonly systemRemove: (
      caller: DesignCaller,
      input: DesignSystemDeleteInput,
    ) => Effect.Effect<{ readonly deleted: boolean; readonly owner: DesignOwner }, DesignError>;
    /** How many designs of the system's owner use it. */
    readonly systemUsage: (
      caller: DesignCaller,
      input: DesignSystemAddress,
    ) => Effect.Effect<DesignSystemUsageResult, DesignError>;
    /**
     * Where the design root of an owner the caller may use is, and whether it
     * exists yet. Never creates a folder: for reads, lists and scans.
     */
    readonly findOwnerRoot: (
      caller: DesignCaller,
      owner: DesignOwnerInput,
    ) => Effect.Effect<
      { readonly owner: DesignOwner; readonly root: string; readonly exists: boolean },
      DesignError
    >;
    /** The design root of an owner the caller may use, created if missing: for writes only. */
    readonly ownerRoot: (
      caller: DesignCaller,
      owner: DesignOwnerInput,
    ) => Effect.Effect<{ readonly owner: DesignOwner; readonly root: string }, DesignError>;
  }
>()("specweave-studio/design/DesignService") {}

const isDesignError = Schema.is(DesignError);

type FileOperation = "read" | "save";

const toDesignError = (cause: unknown, operation?: FileOperation): DesignError => {
  if (isDesignError(cause)) return cause;
  if (cause instanceof Store.DesignStoreProblem) {
    return new DesignError({
      code: cause.code,
      detail: cause.message,
      ...(cause.currentRevision === undefined ? {} : { currentRevision: cause.currentRevision }),
    });
  }
  return new DesignError({ code: "operation_failed", detail: fileFailureDetail(cause, operation) });
};

/**
 * System calls that only read, for callers that do not say what they were doing. `open` is
 * not here: reads and writes both fail in it.
 */
const READ_CALLS = new Set(["read", "readlink", "lstat", "stat", "realpath", "access", "scandir"]);
const FOLDER_CALLS = new Set(["mkdir", "rmdir", "scandir", "opendir"]);

/**
 * A file failure in plain words, naming the cause and the folder:
 * "The design could not be saved: SpecWithCode may not write to /work/app/.specweave/design."
 */
export function fileFailureDetail(cause: unknown, operation?: FileOperation): string {
  const error = cause as NodeJS.ErrnoException | undefined;
  const code = typeof error?.code === "string" ? error.code : null;
  const path = typeof error?.path === "string" ? error.path : null;
  const syscall = typeof error?.syscall === "string" ? error.syscall : "";
  const reading = operation === undefined ? READ_CALLS.has(syscall) : operation === "read";
  if (code === null || path === null)
    return `The design could not be ${reading ? "read" : "saved"}. Try again.`;
  const folder = FOLDER_CALLS.has(syscall) ? path : NodePath.dirname(path);
  const failed = `The design could not be ${reading ? "read" : "saved"}`;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `${failed}: SpecWithCode may not ${reading ? "read" : "write to"} ${folder}.`;
    case "EROFS":
      return `${failed}: ${folder} is on a read-only disk.`;
    case "ENOSPC":
    case "EDQUOT":
      return `${failed}: the disk holding ${folder} is full.`;
    case "ENOENT":
      return `${failed}: ${folder} is missing.`;
    default:
      return `${failed} in ${folder} (${code}). Try again.`;
  }
}

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => toDesignError(cause) });
/** Like `attempt`, for work that only reads: its failures say "could not be read". */
const attemptRead = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => toDesignError(cause, "read") });

const forbidden = (detail: string) => new DesignError({ code: "forbidden", detail });

const sameOwner = (left: DesignOwnerInput, right: DesignOwner | DesignOwnerInput) =>
  left.kind === "playground"
    ? right.kind === "playground"
    : right.kind === "project" && right.projectId === left.projectId;

/** The level `caller` has on `document`; the owner here always edits. */
export const designLevel = (caller: DesignCaller, document: Pick<DesignDocument, "access">) =>
  caller.audience === "owner" ? "edit" : designAccess(document)[caller.audience];

const audienceName = (caller: DesignCaller) =>
  caller.audience === "agents" ? "agents" : "people on other devices";

/** Refuses `operations` the caller's level does not allow, and access changes from anyone but the owner. */
export function assertDesignAccess(
  caller: DesignCaller,
  document: Pick<DesignDocument, "access">,
  operations: readonly DesignOperation[] | "edit",
): void {
  if (
    operations !== "edit" &&
    caller.audience !== "owner" &&
    operations.some((operation) => operation.op === "set_access")
  ) {
    throw new Store.DesignStoreProblem(
      "forbidden",
      "Only the owner on this machine can change who may edit this design.",
    );
  }
  const level = designLevel(caller, document);
  const allowed = operations === "edit" ? level === "edit" : designAccessAllows(level, operations);
  if (!allowed) {
    throw new Store.DesignStoreProblem(
      "forbidden",
      level === "view"
        ? `This design is view-only for ${audienceName(caller)}.`
        : `This design allows only comments from ${audienceName(caller)}.`,
    );
  }
}

/**
 * Binding a design to a thread: the owner session may bind any thread; an agent
 * may only bind its own thread on this machine, or clear a binding to itself.
 */
export function assertThreadBinding(
  caller: DesignCaller,
  document: Pick<DesignDocument, "thread">,
  operations: readonly DesignOperation[],
  here: EnvironmentId,
): void {
  const own = caller.actor.kind === "agent" ? caller.actor.threadId : undefined;
  const isOwn = (binding: DesignThreadBinding | undefined | null) =>
    own !== undefined && binding?.threadId === own && binding.environmentId === here;
  for (const operation of operations) {
    if (operation.op !== "set_thread" || caller.audience === "owner") continue;
    if (operation.thread === null ? isOwn(document.thread) : isOwn(operation.thread)) continue;
    throw new Store.DesignStoreProblem(
      "forbidden",
      caller.audience === "agents"
        ? "An agent can only bind a design to its own thread, or clear its own binding."
        : "Only the owner on this machine can change which thread a design is bound to.",
    );
  }
}

/** Who wrote a comment, and when, come from the server, never from the caller. */
const stampOperations = (
  operations: readonly DesignOperation[],
  actor: DesignActor,
  now: string,
): DesignOperation[] =>
  operations.map((operation) =>
    operation.op === "add_comment"
      ? { ...operation, comment: { ...operation.comment, author: actor, createdAt: now } }
      : operation,
  );

const sameDesignOwner = (left: DesignOwner, right: DesignOwner) =>
  left.kind === right.kind &&
  left.environmentId === right.environmentId &&
  (left.kind === "playground" || (right.kind === "project" && left.projectId === right.projectId));

/**
 * The newest of `systems` copied from `systemId` of `from`: the copy of the
 * highest source revision, the latest made among those.
 */
const newestCopyOf = (systems: readonly DesignSystem[], systemId: string, from: DesignOwner) =>
  systems
    .filter(
      (system) =>
        system.copiedFrom?.id === systemId && sameDesignOwner(system.copiedFrom.owner, from),
    )
    .toSorted(
      (left, right) =>
        right.copiedFrom!.revision - left.copiedFrom!.revision ||
        right.copiedFrom!.copiedAt.localeCompare(left.copiedFrom!.copiedAt),
    )[0];

/**
 * The id a copy should use for `systemId` of `from` in the target root: the
 * same system when the target has it, else the newest copy the target made of it.
 */
const systemInTarget = async (systemId: string, from: DesignOwner, targetRoot: string) => {
  const same = await Store.readDesignSystem(targetRoot, systemId).catch(() => null);
  if (same !== null) return same.id;
  const { systems } = await Store.listDesignSystems(targetRoot);
  return newestCopyOf(systems, systemId, from)?.id ?? null;
};

/** `name`, or "name 2", "name 3"… when the target already has a system by that name. */
export const freeSystemName = (name: string, taken: readonly string[]): string => {
  const used = new Set(taken.map((entry) => entry.trim().toLowerCase()));
  if (!used.has(name.trim().toLowerCase())) return name;
  const numbered = (n: number) => `${name.slice(0, 170).trimEnd()} ${n}`;
  let n = 2;
  while (used.has(numbered(n).toLowerCase())) n += 1;
  return numbered(n);
};

const refPath = (resolved: ResolvedOwner, id: string, file: string) =>
  `${resolved.relative}/${id}/${file}`;

const designRef = (resolved: ResolvedOwner, id: string) => ({
  owner: resolved.owner,
  designId: id,
  path: refPath(resolved, id, Store.DESIGN_FILE),
});

const summaryOf = (resolved: ResolvedOwner, document: DesignDocument): DesignSummary => ({
  ref: designRef(resolved, document.id),
  kind: document.kind,
  title: document.title,
  revision: document.revision,
  updatedAt: document.updatedAt,
  pageCount: document.pages.length,
  designSystem: document.designSystem,
  ownerLabel: resolved.label,
  ...(document.thread === undefined ? {} : { thread: document.thread }),
  ...(document.access === undefined ? {} : { access: document.access }),
});

/** Image assets a document uses. */
const designAssets = (document: DesignDocument) =>
  document.pages.flatMap((page) =>
    page.nodes.flatMap((node) => (node.type === "image" ? [node.asset] : [])),
  );

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const render = yield* HtmlRender.HtmlRender;

  const localEnvironment = environment.getEnvironmentId;

  const unavailable = () =>
    new DesignError({
      code: "operation_failed",
      detail: "The project registry could not be read.",
    });

  /** This machine's checkout linked to `projectId` on `environmentId`, if any. */
  const linkedProject = (environmentId: EnvironmentId, projectId: ProjectId) =>
    projects.list().pipe(
      Effect.mapError(unavailable),
      Effect.map((rows) =>
        rows.find((row) =>
          (row.workspaceSettings?.logicalProject?.members ?? []).some(
            (member) => member.environmentId === environmentId && member.projectId === projectId,
          ),
        ),
      ),
    );

  const notOnThisMachine = (environmentId: EnvironmentId, projectId: ProjectId, detail: string) =>
    new DesignError({
      code: "not_on_this_machine",
      detail,
      member: { environmentId, projectId },
    });

  /**
   * The owner `input` names on this machine. `from` is the machine a
   * reference was made on; a project there resolves to the linked checkout here.
   */
  const resolveOwner = Effect.fn("DesignService.resolveOwner")(function* (
    caller: DesignCaller,
    input: DesignOwnerInput,
    from?: EnvironmentId,
  ) {
    const here = yield* localEnvironment;
    if (input.kind === "playground") {
      if (from !== undefined && from !== here) {
        return yield* new DesignError({
          code: "forbidden",
          detail:
            "A Playground belongs to its own machine; copy the design to a project to share it.",
        });
      }
      if (caller.scope !== undefined && caller.scope.kind !== "playground") {
        return yield* forbidden("This thread can only use its own project's designs.");
      }
      return {
        owner: { kind: "playground", environmentId: here },
        label: PLAYGROUND_LABEL,
        base: config.stateDir,
        relative: PLAYGROUND_DESIGN_DIR,
      } satisfies ResolvedOwner;
    }
    let row = Option.getOrUndefined(
      yield* projects.get(input.projectId).pipe(Effect.mapError(unavailable)),
    );
    if (row?.deletedAt !== null && row !== undefined) row = undefined;
    if (row === undefined || (from !== undefined && from !== here)) {
      const remote = from ?? here;
      const linked = yield* linkedProject(remote, input.projectId);
      if (linked === undefined || linked.deletedAt !== null) {
        if (row === undefined && (from === undefined || from === here)) {
          return yield* new DesignError({
            code: "not_found",
            detail: "That project is not on this machine.",
          });
        }
        if (row === undefined) {
          return yield* notOnThisMachine(
            remote,
            input.projectId,
            "Not on this machine yet: this project has no linked checkout here.",
          );
        }
      } else {
        row = linked;
      }
    }
    if (
      caller.scope !== undefined &&
      !sameOwner(caller.scope, { kind: "project", projectId: row.projectId })
    ) {
      return yield* forbidden(
        caller.scope.kind === "playground"
          ? "This Scratch thread can only use Playground designs."
          : "This thread can only use its own project's designs.",
      );
    }
    return {
      owner: { kind: "project", environmentId: here, projectId: row.projectId },
      label: row.title,
      base: row.workspaceRoot,
      relative: PROJECT_DESIGN_DIR,
    } satisfies ResolvedOwner;
  });

  const rootOf = (resolved: ResolvedOwner, create: boolean) =>
    attempt(() =>
      Store.resolveDesignRoot(resolved.base, resolved.relative, {
        create,
        mode: resolved.owner.kind === "playground" ? 0o700 : 0o755,
      }),
    );

  /** The root of an existing owner folder; a missing one means the design is not here. */
  const existingRoot = (resolved: ResolvedOwner) =>
    rootOf(resolved, false).pipe(
      Effect.flatMap((root) =>
        root === null
          ? Effect.fail(new DesignError({ code: "not_found", detail: "No designs here yet." }))
          : Effect.succeed(root),
      ),
    );

  /** Where a Playground design went: its record and the project root holding it, or null. */
  const placedForward = (playground: string, designId: string) =>
    Effect.gen(function* () {
      const forward = yield* attemptRead(() => Move.readForward(playground, designId));
      if (forward === null) return null;
      const target = yield* resolveOwner(ownerCaller, forward.to);
      const root = yield* rootOf(target, false);
      if (root === null || !(yield* attemptRead(() => Move.designPlaced(root, designId))))
        return null;
      return { forward, target, root };
    }).pipe(Effect.orElseSucceed(() => null));

  /**
   * The `not_found` for a Playground design that moved into a project, with
   * `movedTo` when the caller may open it there. It counts as moved once its
   * forward record names a project that holds it, even while the old folder
   * is still being removed, so the two copies are never both editable.
   */
  const movedAway = (
    caller: DesignCaller,
    input: {
      readonly owner: DesignOwnerInput;
      readonly designId: string;
      readonly environmentId?: EnvironmentId | undefined;
    },
  ) =>
    Effect.gen(function* () {
      if (input.owner.kind !== "playground") return undefined;
      const here = yield* localEnvironment;
      if (input.environmentId !== undefined && input.environmentId !== here) return undefined;
      const playground = yield* attempt(() =>
        Store.resolveDesignRoot(config.stateDir, PLAYGROUND_DESIGN_DIR, { create: false }),
      );
      if (playground === null) return undefined;
      const moved = yield* placedForward(playground, input.designId);
      if (moved === null) return undefined;
      const { forward, target } = moved;
      const allowed = yield* Effect.isSuccess(resolveOwner(caller, forward.to));
      return allowed
        ? new DesignError({
            code: "not_found",
            detail: `Moved to ${target.label}.`,
            movedTo: { owner: forward.to, designId: input.designId },
          })
        : new DesignError({ code: "not_found", detail: "This design moved to a project." });
    }).pipe(Effect.orElseSucceed(() => undefined));

  const address = Effect.fn("DesignService.address")(function* (
    caller: DesignCaller,
    input: {
      readonly owner: DesignOwnerInput;
      readonly environmentId?: EnvironmentId | undefined;
      readonly designId?: string | undefined;
    },
  ) {
    const scoped = yield* resolveOwner(caller, input.owner, input.environmentId).pipe(
      Effect.result,
    );
    if (input.designId !== undefined) {
      const moved = yield* movedAway(caller, { ...input, designId: input.designId });
      // A caller outside the Playground's scope hears of a move only when it may open the target.
      if (moved !== undefined && (scoped._tag === "Success" || moved.movedTo !== undefined)) {
        return yield* moved;
      }
    }
    if (scoped._tag === "Failure") return yield* scoped.failure;
    const resolved = scoped.success;
    return { resolved, root: yield* existingRoot(resolved) };
  });

  /** A design missing from a linked checkout is `not_on_this_machine`, naming where it was made. */
  const missingHere =
    (input: {
      readonly owner: DesignOwnerInput;
      readonly environmentId?: EnvironmentId | undefined;
    }) =>
    (error: DesignError) =>
      Effect.gen(function* () {
        const here = yield* localEnvironment;
        if (
          error.code === "not_found" &&
          input.owner.kind === "project" &&
          input.environmentId !== undefined &&
          input.environmentId !== here
        ) {
          return yield* notOnThisMachine(
            input.environmentId,
            input.owner.projectId,
            "Not on this machine yet: pull the project here, or open it on the machine that has it.",
          );
        }
        return yield* error;
      });

  const get: DesignService["Service"]["get"] = (caller, input) =>
    Effect.gen(function* () {
      const { resolved, root } = yield* address(caller, input);
      const document = yield* attemptRead(() =>
        Store.readDesign(root, input.designId, input.revision),
      );
      return { ref: designRef(resolved, document.id), document, audience: caller.audience };
    }).pipe(Effect.catch(missingHere(input)), Effect.withSpan("DesignService.get"));

  const listOwners = Effect.fn("DesignService.listOwners")(function* (
    caller: DesignCaller,
    filter: DesignOwnerFilter,
  ) {
    const owners: DesignOwnerInput[] = [];
    const named: DesignOwnerInput | undefined =
      filter.kind === "project"
        ? { kind: "project", projectId: filter.projectId }
        : filter.kind === "playground"
          ? { kind: "playground" }
          : undefined;
    if (caller.scope !== undefined && named !== undefined && !sameOwner(caller.scope, named)) {
      return yield* forbidden(
        caller.scope.kind === "playground"
          ? "This Scratch thread can only use Playground designs."
          : "This thread can only use its own project's designs.",
      );
    }
    const wantPlayground = filter.kind === "all" || filter.kind === "playground";
    const wantProjects = filter.kind === "all" || filter.kind === "projects";
    if (filter.kind === "project") owners.push({ kind: "project", projectId: filter.projectId });
    if (wantPlayground) owners.push({ kind: "playground" });
    if (wantProjects) {
      const rows = yield* projects.list().pipe(Effect.mapError(unavailable));
      for (const row of rows) {
        if (row.deletedAt !== null || (yield* folders.isScratch(row.projectId))) continue;
        owners.push({ kind: "project", projectId: row.projectId });
      }
    }
    // A scoped caller sees its own owner only, whatever it asked for.
    return caller.scope === undefined
      ? owners
      : owners.filter((owner) => sameOwner(caller.scope!, owner));
  });

  const list: DesignService["Service"]["list"] = (caller, input) =>
    Effect.gen(function* () {
      const designs: DesignSummary[] = [];
      const problems: Array<DesignListProblem> = [];
      for (const owner of yield* listOwners(caller, input.filter)) {
        const resolved = yield* resolveOwner(caller, owner).pipe(Effect.option);
        if (Option.isNone(resolved)) continue;
        const located = yield* rootOf(resolved.value, false).pipe(
          Effect.flatMap((root) =>
            root === null
              ? Effect.succeed(null)
              : attemptRead(() => Store.listDesigns(root)).pipe(
                  Effect.map((listing) => ({ root, listing })),
                ),
          ),
          Effect.result,
        );
        if (located._tag === "Failure") {
          problems.push({ ...problemOwner(resolved.value), detail: located.failure.detail });
          continue;
        }
        // No folder yet: nothing to list.
        if (located.success === null) continue;
        const { root, listing } = located.success;
        let documents: ReadonlyArray<DesignDocument> = listing.documents;
        if (resolved.value.owner.kind === "playground") {
          // A move that stopped after placing the design: hide the copy and finish removing it.
          const kept: DesignDocument[] = [];
          for (const document of documents) {
            const moved = yield* placedForward(root, document.id);
            if (moved === null) kept.push(document);
            else
              yield* attempt(() => Move.removeMovedSource(root, document.id, moved.root)).pipe(
                Effect.ignore,
              );
          }
          documents = kept;
        }
        designs.push(...documents.map((document) => summaryOf(resolved.value, document)));
        problems.push(
          ...listing.problems.map((problem) => ({
            ...problemOwner(resolved.value),
            detail: `${problem.id}: ${problem.detail}`,
          })),
        );
      }
      designs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { designs, problems };
    }).pipe(Effect.withSpan("DesignService.list"));

  /** A design system the document may use: same owner, and present. */
  const checkSystems = async (root: string, operations: readonly DesignOperation[]) => {
    for (const operation of operations) {
      if (operation.op !== "set_design_system" || operation.systemId === null) continue;
      await Store.readDesignSystem(root, operation.systemId).catch((error: unknown) => {
        if (error instanceof Store.DesignStoreProblem && error.code === "not_found") {
          throw new Store.DesignStoreProblem(
            "invalid",
            `No design system ${operation.systemId} in this owner. Copy it here first.`,
          );
        }
        throw error;
      });
    }
  };

  const create: DesignService["Service"]["create"] = (caller, input) =>
    Effect.gen(function* () {
      const resolved = yield* resolveOwner(caller, input.owner);
      const root = yield* rootOf(resolved, true);
      if (root === null) return yield* new DesignError({ code: "operation_failed", detail: "" });
      const systemId = input.designSystem ?? null;
      if (systemId !== null) {
        yield* attempt(() => checkSystems(root, [{ op: "set_design_system", systemId }]));
      }
      // Binding on creation is held to the set_thread rule, before anything is written.
      if (input.thread !== undefined) {
        const here = yield* localEnvironment;
        yield* Effect.try({
          try: () =>
            assertThreadBinding(caller, {}, [{ op: "set_thread", thread: input.thread! }], here),
          catch: toDesignError,
        });
      }
      const document = newDesignDocument({
        id: designId("d"),
        kind: input.kind,
        title: input.title,
        now: DateTime.formatIso(yield* DateTime.now),
        createdBy: caller.actor,
        designSystem: systemId,
      });
      const stored = yield* attempt(() =>
        Store.createDesign(
          root,
          {
            ...document,
            ...(input.thread === undefined ? {} : { thread: input.thread }),
            ...(input.reuse === undefined ? {} : { reuse: input.reuse }),
          },
          caller.actor,
        ),
      );
      return { ref: designRef(resolved, stored.id), document: stored };
    }).pipe(Effect.withSpan("DesignService.create"));

  const apply: DesignService["Service"]["apply"] = (caller, input) =>
    Effect.gen(function* () {
      const { resolved, root } = yield* address(caller, input);
      const here = yield* localEnvironment;
      const now = DateTime.formatIso(yield* DateTime.now);
      const document = yield* attempt(() =>
        Store.updateDesign(root, input.designId, {
          expectedRevision: input.expectedRevision,
          actor: caller.actor,
          now,
          change: async (current) => {
            assertDesignAccess(caller, current, input.operations);
            assertThreadBinding(caller, current, input.operations, here);
            await checkSystems(root, input.operations);
            const outcome = applyDesignOperations(
              current,
              stampOperations(input.operations, caller.actor, now),
            );
            if (!outcome.ok) {
              throw new Store.DesignStoreProblem(
                outcome.error.code,
                `Operation ${outcome.error.index + 1}: ${outcome.error.detail}`,
              );
            }
            return outcome.document;
          },
        }),
      );
      return { ref: designRef(resolved, document.id), document };
    }).pipe(Effect.withSpan("DesignService.apply"));

  const history: DesignService["Service"]["history"] = (caller, input) =>
    Effect.gen(function* () {
      const { root } = yield* address(caller, input);
      return { entries: yield* attemptRead(() => Store.designHistory(root, input.designId)) };
    }).pipe(Effect.withSpan("DesignService.history"));

  const saveVersion: DesignService["Service"]["saveVersion"] = (caller, input) =>
    Effect.gen(function* () {
      const { root } = yield* address(caller, input);
      yield* attempt(() =>
        Store.saveDesignVersion(root, input.designId, {
          name: input.name,
          actor: caller.actor,
          check: (current) => assertDesignAccess(caller, current, "edit"),
        }),
      );
      return { entries: yield* attemptRead(() => Store.designHistory(root, input.designId)) };
    }).pipe(Effect.withSpan("DesignService.saveVersion"));

  const restore: DesignService["Service"]["restore"] = (caller, input) =>
    Effect.gen(function* () {
      const { resolved, root } = yield* address(caller, input);
      const document = yield* attempt(() =>
        Store.restoreDesign(root, input.designId, {
          revision: input.revision,
          expectedRevision: input.expectedRevision,
          actor: caller.actor,
          check: (current) => assertDesignAccess(caller, current, "edit"),
        }),
      );
      return { ref: designRef(resolved, document.id), document };
    }).pipe(Effect.withSpan("DesignService.restore"));

  const remove: DesignService["Service"]["remove"] = (caller, input) =>
    Effect.gen(function* () {
      const { root } = yield* address(caller, input);
      const deleted = yield* attempt(() =>
        Store.deleteDesign(root, input.designId, (current) =>
          assertDesignAccess(caller, current, "edit"),
        ),
      );
      return { deleted };
    }).pipe(Effect.withSpan("DesignService.remove"));

  const copy: DesignService["Service"]["copy"] = (caller, input) =>
    Effect.gen(function* () {
      if (caller.audience === "agents") {
        return yield* forbidden(
          "Agents cannot copy designs between owners. Ask the user to copy it from the Design gallery.",
        );
      }
      const source = yield* address(caller, input);
      const original = yield* attemptRead(() => Store.readDesign(source.root, input.designId));
      yield* attempt(async () => assertDesignAccess(caller, original, "edit"));
      const target = yield* resolveOwner(caller, input.to);
      const targetRoot = yield* rootOf(target, true);
      if (targetRoot === null)
        return yield* new DesignError({ code: "operation_failed", detail: "" });
      const systemId =
        original.designSystem === null
          ? null
          : yield* attempt(() =>
              systemInTarget(original.designSystem!, source.resolved.owner, targetRoot),
            );
      const now = DateTime.formatIso(yield* DateTime.now);
      const { thread: _thread, access: _access, ...content } = original;
      const copied: DesignDocument = {
        ...content,
        id: designId("d"),
        revision: 0,
        createdAt: now,
        updatedAt: now,
        createdBy: caller.actor,
        designSystem: systemId,
        copiedFrom: {
          owner: source.resolved.owner,
          id: original.id,
          revision: original.revision,
          copiedAt: now,
        },
      };
      const stored = yield* attempt(async () => {
        const created = await Store.createDesign(targetRoot, copied, caller.actor);
        await Store.copyDesignAssets(
          { root: source.root, designId: original.id },
          { root: targetRoot, designId: created.id },
          designAssets(original),
        );
        return created;
      });
      return { ref: designRef(target, stored.id), document: stored };
    }).pipe(Effect.withSpan("DesignService.copy"));

  // The source is read without the forward check, so a retry finishes a move that stopped part way.
  const move: DesignService["Service"]["move"] = (caller, input) =>
    Effect.gen(function* () {
      if (caller.audience !== "owner") {
        return yield* forbidden(
          "Only the owner on this machine can move a design into a project. Ask the user to do it.",
        );
      }
      if (input.owner.kind !== "playground" || input.to.kind !== "project") {
        return yield* new DesignError({
          code: "invalid",
          detail: "Only a Playground design moves, and only into a project.",
        });
      }
      if (yield* folders.isScratch(input.to.projectId)) {
        return yield* new DesignError({
          code: "invalid",
          detail: "The Scratch project keeps its designs in the Playground. Pick another project.",
        });
      }
      const source = yield* resolveOwner(caller, input.owner);
      const playgroundRoot = yield* existingRoot(source);
      const target = yield* resolveOwner(caller, input.to);
      const targetRoot = yield* rootOf(target, true);
      if (targetRoot === null)
        return yield* new DesignError({ code: "operation_failed", detail: "" });
      const now = DateTime.formatIso(yield* DateTime.now);
      // A record naming another project: that project is looked up here, and checked under the lock.
      const earlier = yield* attemptRead(() => Move.readForward(playgroundRoot, input.designId));
      const to = input.to;
      const elsewhere =
        earlier === null || (earlier.to.kind === "project" && earlier.to.projectId === to.projectId)
          ? null
          : yield* resolveOwner(ownerCaller, earlier.to).pipe(
              Effect.flatMap((other) =>
                rootOf(other, false).pipe(
                  Effect.map((root) => ({ to: earlier.to, root, label: other.label })),
                ),
              ),
              // A project no longer on this machine holds nothing; any other failure might.
              Effect.catch((error) =>
                Effect.succeed({
                  to: earlier.to,
                  root: null,
                  label: "another project",
                  gone: error.code === "not_found",
                }),
              ),
            );
      const document = yield* attempt(() =>
        Move.moveDesign({
          playgroundRoot,
          designId: input.designId,
          targetRoot,
          to: input.to,
          elsewhere,
          expectedRevision: input.expectedRevision,
          actor: caller.actor,
          movedAt: now,
          // The system it names comes along under the same id, so its tokens keep resolving.
          prepare: async (current) => {
            if (current.designSystem === null) return;
            await Move.copySystemForMove({
              from: { root: playgroundRoot, owner: source.owner },
              targetRoot,
              systemId: current.designSystem,
              actor: caller.actor,
              now,
            });
          },
        }),
      );
      return { ref: designRef(target, document.id), document, audience: caller.audience };
    }).pipe(Effect.withSpan("DesignService.move"));

  // Reading the design first applies the same owner and scope checks as design.get.
  const assetFile: DesignService["Service"]["assetFile"] = (caller, input) =>
    Effect.gen(function* () {
      const { root } = yield* address(caller, input);
      yield* attemptRead(() => Store.readDesign(root, input.designId));
      return yield* attemptRead(() => Store.designAssetFile(root, input.designId, input.asset));
    }).pipe(Effect.withSpan("DesignService.assetFile"));

  const putAsset: DesignService["Service"]["putAsset"] = (caller, input) =>
    Effect.gen(function* () {
      const { root } = yield* address(caller, input);
      const bytes = Buffer.from(input.data, "base64");
      if (bytes.byteLength === 0) {
        return yield* new DesignError({ code: "invalid", detail: "The image is empty." });
      }
      const asset = yield* attempt(() =>
        Store.putDesignAsset(root, input.designId, bytes, input.mimeType, (current) =>
          assertDesignAccess(caller, current, "edit"),
        ),
      );
      return { asset };
    }).pipe(Effect.withSpan("DesignService.putAsset"));

  const exportOne: DesignService["Service"]["export"] = (caller, input) =>
    Effect.gen(function* () {
      const { root } = yield* address(caller, input);
      const document = yield* attemptRead(() => Store.readDesign(root, input.designId));
      const system =
        document.designSystem === null
          ? null
          : yield* attemptRead(() => Store.readDesignSystem(root, document.designSystem!)).pipe(
              Effect.orElseSucceed(() => null),
            );
      return yield* exportDesign({
        document,
        system,
        input,
        readAsset: (asset) => Store.readDesignAsset(root, document.id, asset),
        render,
      });
    }).pipe(Effect.withSpan("DesignService.export"));

  const watch: DesignService["Service"]["watch"] = (caller, input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { resolved, root } = yield* address(caller, input);
        const folder = Store.designFolder(root, input.designId);
        const first = yield* attemptRead(() => Store.readDesign(root, input.designId));
        return Stream.callback<DesignGetResult, DesignError>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              let lastRevision = first.revision;
              // @effect-diagnostics-next-line globalDateInEffect:off - the watcher's callbacks run outside Effect.
              let lastSent = Date.now();
              let timer: ReturnType<typeof setTimeout> | undefined;
              let reading = false;
              let closed = false;
              Queue.offerUnsafe(queue, { ref: designRef(resolved, first.id), document: first });
              const check = () => {
                timer = undefined;
                if (closed || reading) return;
                reading = true;
                Store.readDesign(root, input.designId).then(
                  (document) => {
                    reading = false;
                    if (closed || document.revision === lastRevision) return;
                    lastRevision = document.revision;
                    lastSent = Date.now();
                    Queue.offerUnsafe(queue, { ref: designRef(resolved, document.id), document });
                  },
                  (error: unknown) => {
                    reading = false;
                    if (closed) return;
                    // A half-written or briefly missing file settles; a deleted design ends the watch.
                    if (error instanceof Store.DesignStoreProblem && error.code === "not_found") {
                      closed = true;
                      Queue.failCauseUnsafe(
                        queue,
                        Cause.fail(
                          new DesignError({ code: "not_found", detail: "The design was deleted." }),
                        ),
                      );
                    }
                  },
                );
              };
              const schedule = () => {
                if (closed || timer !== undefined) return;
                const wait = Math.max(DESIGN_WATCH_INTERVAL_MS - (Date.now() - lastSent), 100);
                timer = setTimeout(check, wait);
              };
              let watcher: NodeFS.FSWatcher | undefined;
              try {
                // Any change re-reads after the debounce; only a new revision is sent.
                watcher = NodeFS.watch(folder, { persistent: false }, schedule);
                watcher.on("error", () => undefined);
              } catch {
                watcher = undefined;
              }
              // @effect-diagnostics-next-line globalTimersInEffect:off - a safety poll beside fs.watch, cleared on release.
              const poll = setInterval(schedule, WATCH_POLL_MS);
              return () => {
                closed = true;
                if (timer !== undefined) clearTimeout(timer);
                clearInterval(poll);
                watcher?.close();
              };
            }),
            (stop) => Effect.sync(stop),
          ),
        );
      }).pipe(Effect.catch(missingHere(input))),
    ).pipe(
      // A design that moved while watched ends with where it went.
      Stream.catch((error) =>
        error.code !== "not_found" || error.movedTo !== undefined
          ? Stream.fail(error)
          : Stream.unwrap(
              Effect.map(movedAway(caller, input), (moved) => Stream.fail(moved ?? error)),
            ),
      ),
    );

  const systemRef = (resolved: ResolvedOwner, id: string) => ({
    owner: resolved.owner,
    systemId: id,
    path: refPath(resolved, `${Store.DESIGN_SYSTEMS_DIR}/${id}`, Store.DESIGN_SYSTEM_FILE),
  });

  const systemList: DesignService["Service"]["systemList"] = (caller, input) =>
    Effect.gen(function* () {
      const systems: DesignSystemListResult["systems"][number][] = [];
      const problems: Array<DesignListProblem> = [];
      for (const owner of yield* listOwners(caller, input.filter)) {
        const resolved = yield* resolveOwner(caller, owner).pipe(Effect.option);
        if (Option.isNone(resolved)) continue;
        const listed = yield* rootOf(resolved.value, false).pipe(
          Effect.flatMap((root) =>
            root === null
              ? Effect.succeed({ systems: [] as DesignSystem[], problems: [] })
              : attemptRead(() => Store.listDesignSystems(root)),
          ),
          Effect.result,
        );
        if (listed._tag === "Failure") {
          problems.push({ ...problemOwner(resolved.value), detail: listed.failure.detail });
          continue;
        }
        for (const system of listed.success.systems) {
          systems.push({
            ref: systemRef(resolved.value, system.id),
            name: system.name,
            revision: system.revision,
            updatedAt: system.updatedAt,
            tokenCount: system.tokens.length,
            componentCount: system.components.length,
            sources: system.sources,
            ownerLabel: resolved.value.label,
            ...(system.copiedFrom !== null ? { copiedFrom: system.copiedFrom } : {}),
          });
        }
        problems.push(
          ...listed.success.problems.map((problem) => ({
            ...problemOwner(resolved.value),
            detail: `${problem.id}: ${problem.detail}`,
          })),
        );
      }
      return { systems, problems };
    }).pipe(Effect.withSpan("DesignService.systemList"));

  const systemGet: DesignService["Service"]["systemGet"] = (caller, input) =>
    Effect.gen(function* () {
      const { resolved, root } = yield* address(caller, input);
      const system = yield* attemptRead(() => Store.readDesignSystem(root, input.systemId));
      return { ref: systemRef(resolved, system.id), system };
    }).pipe(Effect.withSpan("DesignService.systemGet"));

  const systemCopy: DesignService["Service"]["systemCopy"] = (caller, input) =>
    Effect.gen(function* () {
      if (caller.audience === "agents") {
        return yield* forbidden("Agents cannot copy design systems between owners.");
      }
      const source = yield* address(caller, input);
      const original = yield* attemptRead(() =>
        Store.readDesignSystem(source.root, input.systemId),
      );
      const target = yield* resolveOwner(caller, input.to);
      const targetRoot = yield* rootOf(target, true);
      if (targetRoot === null)
        return yield* new DesignError({ code: "operation_failed", detail: "" });
      const now = DateTime.formatIso(yield* DateTime.now);
      const stored = yield* attempt(async () => {
        // A target that already holds a copy of this system gets its newest copy back, not
        // another; a fresh copy is made only when that one predates the source's revision.
        // A copy into the system's own owner is a duplicate, always a new system.
        const { systems: present } = await Store.listDesignSystems(targetRoot);
        const existing = sameDesignOwner(target.owner, source.resolved.owner)
          ? undefined
          : newestCopyOf(present, original.id, source.resolved.owner);
        if (
          existing !== undefined &&
          (input.fresh !== true || existing.copiedFrom!.revision >= original.revision)
        )
          return existing;
        const created = await Store.writeDesignSystem(
          targetRoot,
          {
            ...original,
            name: freeSystemName(
              original.name,
              present.map((system) => system.name),
            ),
            id: designId("s"),
            revision: 0,
            createdAt: now,
            updatedAt: now,
            copiedFrom: {
              owner: source.resolved.owner,
              id: original.id,
              revision: original.revision,
              copiedAt: now,
            },
          },
          { expectedRevision: null, actor: caller.actor, now },
        );
        // Its stored files (README, fonts, asset sets) go with it, or the copy is undone.
        await SystemFiles.copySystemFiles(
          { root: source.root, systemId: original.id },
          { root: targetRoot, systemId: created.id },
        ).catch(async (error: unknown) => {
          await Store.deleteDesignSystem(targetRoot, created.id).catch(() => undefined);
          throw error;
        });
        return created;
      });
      return { ref: systemRef(target, stored.id), system: stored };
    }).pipe(Effect.withSpan("DesignService.systemCopy"));

  const systemRename: DesignService["Service"]["systemRename"] = (caller, input) =>
    Effect.gen(function* () {
      if (caller.audience === "agents") {
        return yield* forbidden("Agents cannot rename design systems. Ask the user to do it.");
      }
      const name = input.name.trim();
      if (name.length === 0) {
        return yield* new DesignError({ code: "invalid", detail: "A design system needs a name." });
      }
      const { resolved, root } = yield* address(caller, input);
      const current = yield* attemptRead(() => Store.readDesignSystem(root, input.systemId));
      if (current.revision !== input.expectedRevision) {
        return yield* new DesignError({
          code: "conflict",
          detail: `The design system is at revision ${current.revision}, not ${input.expectedRevision}. Read it again first.`,
          currentRevision: current.revision,
        });
      }
      if (current.name === name) return { ref: systemRef(resolved, current.id), system: current };
      const now = DateTime.formatIso(yield* DateTime.now);
      // The store compares the revision again under its lock, so a write in between still conflicts.
      const stored = yield* attempt(() =>
        Store.writeDesignSystem(
          root,
          { ...current, name },
          { expectedRevision: input.expectedRevision, actor: caller.actor, now },
        ),
      );
      return { ref: systemRef(resolved, stored.id), system: stored };
    }).pipe(Effect.withSpan("DesignService.systemRename"));

  const systemRemove: DesignService["Service"]["systemRemove"] = (caller, input) =>
    Effect.gen(function* () {
      if (caller.audience === "agents") {
        return yield* forbidden("Agents cannot delete design systems. Ask the user to do it.");
      }
      const { resolved, root } = yield* address(caller, input);
      const deleted = yield* attempt(() =>
        Store.deleteDesignSystem(root, input.systemId, input.expectedRevision),
      );
      return { deleted, owner: resolved.owner };
    }).pipe(Effect.withSpan("DesignService.systemRemove"));

  const systemUsage: DesignService["Service"]["systemUsage"] = (caller, input) =>
    Effect.gen(function* () {
      const resolved = yield* resolveOwner(caller, input.owner);
      const root = yield* rootOf(resolved, false);
      if (root === null) return { designs: 0 };
      const { documents } = yield* attemptRead(() => Store.listDesigns(root));
      return {
        designs: documents.filter((document) => document.designSystem === input.systemId).length,
      };
    }).pipe(Effect.withSpan("DesignService.systemUsage"));

  const findOwnerRoot: DesignService["Service"]["findOwnerRoot"] = (caller, owner) =>
    Effect.gen(function* () {
      const resolved = yield* resolveOwner(caller, owner);
      const found = yield* attemptRead(() =>
        Store.locateDesignRoot(resolved.base, resolved.relative),
      );
      return { owner: resolved.owner, ...found };
    }).pipe(Effect.withSpan("DesignService.findOwnerRoot"));

  const ownerRoot: DesignService["Service"]["ownerRoot"] = (caller, owner) =>
    Effect.gen(function* () {
      const resolved = yield* resolveOwner(caller, owner);
      const root = yield* rootOf(resolved, true);
      if (root === null) return yield* new DesignError({ code: "operation_failed", detail: "" });
      return { owner: resolved.owner, root };
    });

  return DesignService.of({
    list,
    get,
    create,
    apply,
    history,
    saveVersion,
    restore,
    copy,
    move,
    remove,
    putAsset,
    assetFile,
    export: exportOne,
    watch,
    systemList,
    systemGet,
    systemCopy,
    systemRename,
    systemRemove,
    systemUsage,
    findOwnerRoot,
    ownerRoot,
  });
});

export const layer = Layer.effect(DesignService, make);

/** With its own headless renderer, as the MCP server builds one for `html_render`. */
export const layerWithRender = layer.pipe(Layer.provide(HtmlRender.layer));
