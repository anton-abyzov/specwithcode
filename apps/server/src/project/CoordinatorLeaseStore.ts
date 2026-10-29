import {
  CoordinatorStandbyAfterMinutes,
  LogicalProjectMember,
  NonNegativeInt,
} from "@specweave-studio/contracts";
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
 * The coordinator's side of automatic takeover, per project copy it
 * coordinates: which standby it leases to, the sequence it last sent, when a
 * lease last came back, and the standbys it still owes a release.
 *
 * A JSON file rather than SQLite for the reason in RemoteWorkerStore.ts: the
 * desktop updater proves the database byte-identical across an update, and the
 * lease loop writes here every 30 seconds while it runs.
 */
const FILE_NAME = "coordinator-lease.json";

/** The standby a coordinator leases to, as the binding named it. */
export const CoordinatorLeaseTarget = Schema.Struct({
  standby: LogicalProjectMember,
  epoch: NonNegativeInt,
  afterMinutes: CoordinatorStandbyAfterMinutes,
  /** When the owner turned automatic takeover on for this standby (this machine's clock). */
  enabledAt: Schema.String,
});
export type CoordinatorLeaseTarget = typeof CoordinatorLeaseTarget.Type;

/** A standby this coordinator stopped leasing to and has not yet heard release it. */
export const CoordinatorPendingRelease = Schema.Struct({
  standby: LogicalProjectMember,
  epoch: NonNegativeInt,
  logicalProjectId: Schema.String,
  since: Schema.String,
});
export type CoordinatorPendingRelease = typeof CoordinatorPendingRelease.Type;

/** This copy gave way to a standby that took over while it was quiet. */
export const CoordinatorGaveWay = Schema.Struct({
  at: Schema.String,
  successor: LogicalProjectMember,
  epoch: NonNegativeInt,
  /** Turns from here on, in this machine's clock, are listed for review. */
  reviewFrom: Schema.String,
  ranWhileAway: NonNegativeInt,
});
export type CoordinatorGaveWay = typeof CoordinatorGaveWay.Type;

export const CoordinatorLeaseRecord = Schema.Struct({
  /** This machine's copy. */
  projectId: Schema.String,
  logicalProjectId: Schema.String,
  /**
   * The thread the project names as its coordinator, besides the default
   * `project-coordinator:<projectId>`; what the wake gate refuses while fenced.
   */
  coordinatorThreadId: Schema.optional(Schema.NullOr(Schema.String)),
  /** The standby leased to now; null while none is set. */
  target: Schema.NullOr(CoordinatorLeaseTarget),
  /** The last sequence sent to any standby of this copy; never reused. */
  seq: NonNegativeInt,
  /** When the last lease that came back with `takenOver: null` was sent. */
  lastSuccessfulLeaseAt: Schema.NullOr(Schema.String),
  /** When the standby last answered that it is updating (busy); silence before it does not count. */
  lastPausedAnswerAt: Schema.NullOr(Schema.String),
  /** The standby answered that it does not stand by for this copy (not armed, or released). */
  standbyMissingAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  pendingReleases: Schema.Array(CoordinatorPendingRelease),
  /** Set while this copy refuses new coordinator turns because its standby went quiet. */
  fencedSince: Schema.NullOr(Schema.String),
  gaveWay: Schema.NullOr(CoordinatorGaveWay),
  updatedAt: Schema.String,
});
export type CoordinatorLeaseRecord = typeof CoordinatorLeaseRecord.Type;

/** A fresh record for `projectId`, leasing to nobody yet. */
export const emptyLeaseRecord = (
  projectId: string,
  logicalProjectId: string,
  at: string,
): CoordinatorLeaseRecord => ({
  projectId,
  logicalProjectId,
  target: null,
  seq: 0,
  lastSuccessfulLeaseAt: null,
  lastPausedAnswerAt: null,
  standbyMissingAt: null,
  lastError: null,
  pendingReleases: [],
  fencedSince: null,
  gaveWay: null,
  updatedAt: at,
});

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  projects: Schema.Array(CoordinatorLeaseRecord),
});
const StoreFileJson = Schema.fromJsonString(StoreFile);
const decodeStoreFile = Schema.decodeUnknownEffect(StoreFileJson);
const encodeStoreFile = Schema.encodeEffect(StoreFileJson);

export class CoordinatorLeaseStoreError extends Schema.TaggedError<CoordinatorLeaseStoreError>()(
  "CoordinatorLeaseStoreError",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} the coordinator lease records.`;
  }
}

export class CoordinatorLeaseStore extends Context.Service<
  CoordinatorLeaseStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<CoordinatorLeaseRecord>, CoordinatorLeaseStoreError>;
    readonly get: (
      projectId: string,
    ) => Effect.Effect<CoordinatorLeaseRecord | undefined, CoordinatorLeaseStoreError>;
    /**
     * Applies `change` to the record for `projectId`. Returning undefined keeps
     * the file as it is; returning null removes the record.
     */
    readonly modify: (
      projectId: string,
      change: (
        current: CoordinatorLeaseRecord | undefined,
      ) => CoordinatorLeaseRecord | null | undefined,
    ) => Effect.Effect<CoordinatorLeaseRecord | undefined, CoordinatorLeaseStoreError>;
  }
>()("specweave-studio/project/CoordinatorLeaseStore") {}

/** Records in memory, for tests and for runtimes without a state folder. */
export const makeMemory = () => {
  const records = new Map<string, CoordinatorLeaseRecord>();
  const service = CoordinatorLeaseStore.of({
    list: Effect.sync(() => [...records.values()]),
    get: (projectId) => Effect.sync(() => records.get(projectId)),
    modify: (projectId, change) =>
      Effect.sync(() => {
        const next = change(records.get(projectId));
        if (next === undefined) return records.get(projectId);
        if (next === null) {
          records.delete(projectId);
          return undefined;
        }
        records.set(projectId, next);
        return next;
      }),
  });
  return { records, service };
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, FILE_NAME);
  const lock = yield* Semaphore.make(1);

  const read = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(filePath);
    if (!exists) return [] as ReadonlyArray<CoordinatorLeaseRecord>;
    const text = yield* fileSystem.readFileString(filePath);
    return (yield* decodeStoreFile(text)).projects;
  }).pipe(Effect.mapError((cause) => new CoordinatorLeaseStoreError({ operation: "read", cause })));

  const write = (projects: ReadonlyArray<CoordinatorLeaseRecord>) =>
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
      Effect.mapError((cause) => new CoordinatorLeaseStoreError({ operation: "write", cause })),
    );

  const list: CoordinatorLeaseStore["Service"]["list"] = lock.withPermit(read);

  const get: CoordinatorLeaseStore["Service"]["get"] = (projectId) =>
    list.pipe(
      Effect.map((projects) => projects.find((project) => project.projectId === projectId)),
    );

  const modify: CoordinatorLeaseStore["Service"]["modify"] = (projectId, change) =>
    lock.withPermit(
      Effect.gen(function* () {
        const projects = yield* read;
        const index = projects.findIndex((project) => project.projectId === projectId);
        const current = index === -1 ? undefined : projects[index];
        const next = change(current);
        if (next === undefined) return current;
        if (next === null) {
          if (index !== -1) yield* write(projects.filter((_, position) => position !== index));
          return undefined;
        }
        if (next.projectId !== projectId)
          return yield* Effect.die(new Error("A lease record keeps its project id."));
        yield* write(
          index === -1
            ? [...projects, next]
            : projects.map((project, position) => (position === index ? next : project)),
        );
        return next;
      }),
    );

  return CoordinatorLeaseStore.of({ list, get, modify });
});

export const layer = Layer.effect(CoordinatorLeaseStore, make);
