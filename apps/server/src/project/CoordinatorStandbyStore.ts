import {
  CoordinatorStandbyAfterMinutes,
  LogicalProjectMember,
  NonNegativeInt,
} from "@specweave-studio/contracts";
import { StudioFleetRemoteWorkerState } from "@specweave-studio/contracts/studioFleet";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

/**
 * What this machine knows as the armed standby of a linked project: who the
 * owner registered as the coordinator, and when that coordinator was last heard.
 *
 * A JSON file rather than SQLite for the reason in RemoteWorkerStore.ts: the
 * desktop updater proves the database byte-identical across an update, and the
 * lease handler writes here every 30 seconds while it runs.
 */
const FILE_NAME = "coordinator-standby.json";

/** The most run ids a lease carries for one worker; the follower keeps the same window. */
export const STANDBY_DELIVERED_RUN_IDS_MAX = 50;

/** A worker the coordinator started on another machine, as its lease last reported it. */
export const CoordinatorStandbyShadowWorker = Schema.Struct({
  id: Schema.String,
  callerThreadId: Schema.String,
  machineId: Schema.String,
  environmentId: Schema.String,
  remoteProjectId: Schema.NullOr(Schema.String),
  remoteThreadId: Schema.NullOr(Schema.String),
  title: Schema.String,
  state: StudioFleetRemoteWorkerState,
  followedRunId: Schema.NullOr(Schema.String),
  deliveredRunIds: Schema.Array(Schema.String).check(
    Schema.isMaxLength(STANDBY_DELIVERED_RUN_IDS_MAX),
  ),
});
export type CoordinatorStandbyShadowWorker = typeof CoordinatorStandbyShadowWorker.Type;

/** This machine's own check that a worker machine lets it steer the project there. */
export const CoordinatorStandbyArming = Schema.Struct({
  environmentId: Schema.String,
  armed: Schema.Boolean,
  checkedAt: Schema.String,
  error: Schema.NullOr(Schema.String),
});
export type CoordinatorStandbyArming = typeof CoordinatorStandbyArming.Type;

export const CoordinatorStandbyRecord = Schema.Struct({
  logicalProjectId: Schema.String,
  /** This machine's copy of the project. */
  projectId: Schema.String,
  /** The coordinator the owner registered through `acceptStandby`; leases from anyone else are ignored. */
  coordinator: LogicalProjectMember,
  epoch: NonNegativeInt,
  afterMinutes: CoordinatorStandbyAfterMinutes,
  acceptedAt: Schema.String,
  /** This machine's own receive time of the last accepted lease, never the sender's clock. */
  lastLeaseAt: Schema.NullOr(Schema.String),
  lastSeq: Schema.NullOr(NonNegativeInt),
  /** When the current unbroken watch began. Reset at process start and on clock jumps. */
  watchingSince: Schema.String,
  /**
   * Whether a lease was accepted since `watchingSince`. Kept apart from the
   * times because a wall clock stepped backwards can put an older lease after
   * a newer watch start.
   */
  leaseSinceWatching: Schema.Boolean,
  /** A planned pause the coordinator announced, already capped at 30 minutes. */
  pausedUntil: Schema.NullOr(Schema.String),
  /** When the coordinator said it was going to sleep, for the status line. */
  coordinatorSleptAt: Schema.NullOr(Schema.String),
  /** This machine is about to sleep; it never takes over in that state. */
  standbySleeping: Schema.Boolean,
  armedFor: Schema.Array(CoordinatorStandbyArming),
  runningThreads: Schema.Array(Schema.Struct({ threadId: Schema.String, title: Schema.String })),
  shadowWorkers: Schema.Array(CoordinatorStandbyShadowWorker),
  lastRefusal: Schema.NullOr(Schema.Struct({ at: Schema.String, reason: Schema.String })),
  updatedAt: Schema.String,
});
export type CoordinatorStandbyRecord = typeof CoordinatorStandbyRecord.Type;

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  projects: Schema.Array(CoordinatorStandbyRecord),
});
const StoreFileJson = Schema.fromJsonString(StoreFile);
const decodeStoreFile = Schema.decodeUnknownEffect(StoreFileJson);
const encodeStoreFile = Schema.encodeEffect(StoreFileJson);

export class CoordinatorStandbyStoreError extends Schema.TaggedError<CoordinatorStandbyStoreError>()(
  "CoordinatorStandbyStoreError",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} the coordinator standby records.`;
  }
}

export class CoordinatorStandbyStore extends Context.Service<
  CoordinatorStandbyStore,
  {
    readonly list: Effect.Effect<
      ReadonlyArray<CoordinatorStandbyRecord>,
      CoordinatorStandbyStoreError
    >;
    readonly get: (
      logicalProjectId: string,
    ) => Effect.Effect<CoordinatorStandbyRecord | undefined, CoordinatorStandbyStoreError>;
    /**
     * Applies `change` to the record for `logicalProjectId`. Returning undefined
     * keeps the file as it is; returning null removes the record (disarm).
     */
    readonly modify: (
      logicalProjectId: string,
      change: (
        current: CoordinatorStandbyRecord | undefined,
      ) => CoordinatorStandbyRecord | null | undefined,
    ) => Effect.Effect<CoordinatorStandbyRecord | undefined, CoordinatorStandbyStoreError>;
  }
>()("specweave-studio/project/CoordinatorStandbyStore") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, FILE_NAME);
  const lock = yield* Semaphore.make(1);

  const read = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(filePath);
    if (!exists) return [] as ReadonlyArray<CoordinatorStandbyRecord>;
    const text = yield* fileSystem.readFileString(filePath);
    return (yield* decodeStoreFile(text)).projects;
  }).pipe(
    Effect.mapError((cause) => new CoordinatorStandbyStoreError({ operation: "read", cause })),
  );

  const write = (projects: ReadonlyArray<CoordinatorStandbyRecord>) =>
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
    }).pipe(
      Effect.mapError((cause) => new CoordinatorStandbyStoreError({ operation: "write", cause })),
    );

  const list: CoordinatorStandbyStore["Service"]["list"] = lock.withPermit(read);

  const get: CoordinatorStandbyStore["Service"]["get"] = (logicalProjectId) =>
    list.pipe(
      Effect.map((projects) =>
        projects.find((project) => project.logicalProjectId === logicalProjectId),
      ),
    );

  const modify: CoordinatorStandbyStore["Service"]["modify"] = (logicalProjectId, change) =>
    lock.withPermit(
      Effect.gen(function* () {
        const projects = yield* read;
        const index = projects.findIndex(
          (project) => project.logicalProjectId === logicalProjectId,
        );
        const current = index === -1 ? undefined : projects[index];
        const next = change(current);
        if (next === undefined) return current;
        if (next === null) {
          if (index !== -1) yield* write(projects.filter((_, position) => position !== index));
          return undefined;
        }
        if (next.logicalProjectId !== logicalProjectId)
          return yield* Effect.die(new Error("A standby record keeps its logical project id."));
        yield* write(
          index === -1
            ? [...projects, next]
            : projects.map((project, position) => (position === index ? next : project)),
        );
        return next;
      }),
    );

  return CoordinatorStandbyStore.of({ list, get, modify });
});

export const layer = Layer.effect(CoordinatorStandbyStore, make);
