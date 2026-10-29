import { NonNegativeInt } from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { parseJson, stringifyJson } from "../json.ts";
import * as ProjectService from "../project/ProjectService.ts";

/**
 * The coordinator epoch each linked project last claimed on this worker
 * machine. After an automatic takeover the new coordinator claims its epoch
 * here; from then on this machine takes steering calls for that project only
 * from callers that name an epoch at least as high. The old coordinator, which
 * still believes its older epoch or sends none, may read but no longer steer,
 * so two coordinators never drive the same worker.
 *
 * A JSON file, like the work grants, so the database stays byte-identical
 * across an update. Written only when a claim raises an epoch.
 */
const FILE_NAME = "worker-epochs.json";

/** The header a coordinator's MCP client names its epochs in, one per linked project. */
export const COORDINATOR_EPOCHS_HEADER = "x-specwithcode-coordinator-epochs";
const MAX_HEADER_CHARS = 16_384;
const MAX_HEADER_ENTRIES = 200;
const MAX_LOGICAL_PROJECT_ID_CHARS = 512;

export const WorkerEpochRecord = Schema.Struct({
  logicalProjectId: Schema.String,
  epoch: NonNegativeInt,
  /** The coordinator environment whose claim set it. */
  claimedBy: Schema.String,
  claimedAt: Schema.String,
});
export type WorkerEpochRecord = typeof WorkerEpochRecord.Type;

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  projects: Schema.Array(WorkerEpochRecord),
});
const StoreFileJson = Schema.fromJsonString(StoreFile);
const decodeStoreFile = Schema.decodeUnknownEffect(StoreFileJson);
const encodeStoreFile = Schema.encodeEffect(StoreFileJson);

export class WorkerEpochStoreError extends Schema.TaggedError<WorkerEpochStoreError>()(
  "WorkerEpochStoreError",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} the coordinator epochs claimed on this machine.`;
  }
}

export interface EpochClaim {
  readonly logicalProjectId: string;
  readonly epoch: number;
  readonly by: string;
}

export interface EpochClaimResult {
  /** Whether the claim stands: it raised the epoch, or repeats the claim that set it. */
  readonly accepted: boolean;
  /** The highest epoch this machine now holds for the project. */
  readonly epoch: number;
}

/**
 * A claim stands when it raises the epoch, or when it repeats the claim that
 * set it (a retry after a lost answer). Anything else is refused and changes
 * nothing.
 */
export function applyEpochClaim(
  current: WorkerEpochRecord | undefined,
  claim: EpochClaim,
): EpochClaimResult & { readonly next: WorkerEpochRecord | undefined } {
  if (current === undefined || claim.epoch > current.epoch)
    return {
      accepted: true,
      epoch: claim.epoch,
      next: {
        logicalProjectId: claim.logicalProjectId,
        epoch: claim.epoch,
        claimedBy: claim.by,
        claimedAt: "",
      },
    };
  return {
    accepted: claim.epoch === current.epoch && claim.by === current.claimedBy,
    epoch: current.epoch,
    next: undefined,
  };
}

/**
 * Whether a steering call may go ahead: always before any claim, and after
 * one only with an epoch at least as high as the claimed one.
 */
export function epochAdmits(
  claimed: WorkerEpochRecord | undefined,
  callerEpoch: number | undefined,
): boolean {
  return claimed === undefined || (callerEpoch !== undefined && callerEpoch >= claimed.epoch);
}

export interface WorkerEpochStoreShape {
  readonly get: (
    logicalProjectId: string,
  ) => Effect.Effect<WorkerEpochRecord | undefined, WorkerEpochStoreError>;
  readonly claim: (claim: EpochClaim) => Effect.Effect<EpochClaimResult, WorkerEpochStoreError>;
}

/** Without the layer nothing was ever claimed, so nothing is refused. */
const none: WorkerEpochStoreShape = {
  get: () => Effect.succeed(undefined),
  claim: () =>
    Effect.fail(
      new WorkerEpochStoreError({ operation: "write", cause: new Error("Not available.") }),
    ),
};

export class WorkerEpochStore extends Context.Reference<WorkerEpochStoreShape>(
  "studio/fleet/WorkerEpochStore",
  { defaultValue: () => none },
) {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, FILE_NAME);
  const lock = yield* Semaphore.make(1);

  const read = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(filePath))) return [] as ReadonlyArray<WorkerEpochRecord>;
    return (yield* decodeStoreFile(yield* fileSystem.readFileString(filePath))).projects;
  }).pipe(Effect.mapError((cause) => new WorkerEpochStoreError({ operation: "read", cause })));

  const write = (projects: ReadonlyArray<WorkerEpochRecord>) =>
    Effect.gen(function* () {
      const text = yield* encodeStoreFile({ version: 1, projects });
      const temporary = `${filePath}.${(yield* crypto.randomUUIDv4).slice(0, 8)}.tmp`;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(temporary, { flag: "w", mode: 0o600 });
          yield* file.writeAll(new TextEncoder().encode(text));
          yield* file.sync;
        }),
      );
      yield* fileSystem.chmod(temporary, 0o600);
      yield* fileSystem.rename(temporary, filePath);
    }).pipe(Effect.mapError((cause) => new WorkerEpochStoreError({ operation: "write", cause })));

  const get: WorkerEpochStoreShape["get"] = (logicalProjectId) =>
    lock.withPermit(
      Effect.map(read, (projects) =>
        projects.find((project) => project.logicalProjectId === logicalProjectId),
      ),
    );

  const claim: WorkerEpochStoreShape["claim"] = (input) =>
    lock.withPermit(
      Effect.gen(function* () {
        const projects = yield* read;
        const index = projects.findIndex(
          (project) => project.logicalProjectId === input.logicalProjectId,
        );
        const outcome = applyEpochClaim(index === -1 ? undefined : projects[index], input);
        if (outcome.next !== undefined) {
          const next = {
            ...outcome.next,
            claimedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
          };
          yield* write(
            index === -1
              ? [...projects, next]
              : projects.map((project, position) => (position === index ? next : project)),
          );
        }
        return { accepted: outcome.accepted, epoch: outcome.epoch };
      }),
    );

  return { get, claim } satisfies WorkerEpochStoreShape;
});

export const layer = Layer.effect(WorkerEpochStore, make);

/**
 * Reads the epochs a caller named. Anything malformed counts as naming none,
 * which a project with a claim refuses.
 */
export function parseCoordinatorEpochs(
  value: string | undefined,
): ReadonlyMap<string, number> | undefined {
  if (value === undefined || value.length === 0 || value.length > MAX_HEADER_CHARS)
    return undefined;
  let parsed: unknown;
  try {
    parsed = parseJson(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const entries = Object.entries(parsed);
  if (entries.length > MAX_HEADER_ENTRIES) return undefined;
  const epochs = new Map<string, number>();
  for (const [logicalProjectId, epoch] of entries) {
    if (
      logicalProjectId.length === 0 ||
      logicalProjectId.length > MAX_LOGICAL_PROJECT_ID_CHARS ||
      typeof epoch !== "number" ||
      !Number.isSafeInteger(epoch) ||
      epoch < 0
    )
      return undefined;
    epochs.set(logicalProjectId, epoch);
  }
  return epochs;
}

/** The epochs a request names, as optional fields of its MCP client caller. */
export const withCoordinatorEpochs = (
  value: string | undefined,
): { readonly coordinatorEpochs?: ReadonlyMap<string, number> } => {
  const epochs = parseCoordinatorEpochs(value);
  return epochs === undefined ? {} : { coordinatorEpochs: epochs };
};

/** The header value for `epochs`, or undefined when there is nothing to name. */
export function encodeCoordinatorEpochs(epochs: ReadonlyMap<string, number>): string | undefined {
  if (epochs.size === 0) return undefined;
  const entries = [...epochs].slice(0, MAX_HEADER_ENTRIES);
  const text = stringifyJson(Object.fromEntries(entries));
  return text.length > MAX_HEADER_CHARS ? undefined : text;
}

/**
 * The coordinator epochs this machine names when it calls another machine:
 * one for each linked project it coordinates there.
 */
export interface CoordinatorEpochSourceShape {
  readonly epochsFor: (environmentId: string) => Effect.Effect<ReadonlyMap<string, number>>;
}

export class CoordinatorEpochSource extends Context.Reference<CoordinatorEpochSourceShape>(
  "studio/fleet/CoordinatorEpochSource",
  { defaultValue: () => ({ epochsFor: () => Effect.succeed(new Map()) }) },
) {}

/** Names the epoch of every linked project this machine's copy coordinates and the target shares. */
export const layerCoordinatorEpochSource = Layer.effect(
  CoordinatorEpochSource,
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    return {
      epochsFor: (environmentId) =>
        projects.snapshot.pipe(
          Effect.map((snapshot) => {
            const epochs = new Map<string, number>();
            for (const project of snapshot.projects) {
              const settings = project.workspaceSettings;
              const identity = settings?.logicalProject;
              const binding = settings?.coordinatorBinding ?? { epoch: 0, state: "active" };
              if (
                project.deletedAt !== null ||
                identity === undefined ||
                binding.state !== "active" ||
                !identity.members.some((member) => member.environmentId === environmentId)
              )
                continue;
              epochs.set(identity.id, binding.epoch);
            }
            return epochs as ReadonlyMap<string, number>;
          }),
          Effect.orElseSucceed(() => new Map<string, number>()),
        ),
    } satisfies CoordinatorEpochSourceShape;
  }),
);
