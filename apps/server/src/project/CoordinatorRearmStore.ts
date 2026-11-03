import {
  LogicalProjectMember,
  NonNegativeInt,
  StandbyRearmConsent,
  StandbyRearmReason,
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
 * Re-arming a standby after an automatic takeover, per linked project on this
 * machine: the owner's consent (which machines may register each other as the
 * standby, the delay, the epoch it starts at) and, on a coordinator that took
 * over automatically, how far its own re-arm went.
 *
 * A JSON file rather than SQLite for the reason in RemoteWorkerStore.ts: the
 * desktop updater proves the database byte-identical across an update.
 */
const FILE_NAME = "coordinator-rearm.json";

/** One machine this run tried and why it was passed over. */
const RearmMachineNote = Schema.Struct({
  member: LogicalProjectMember,
  reason: StandbyRearmReason,
  at: Schema.String,
});

/** A coordinator's re-arm after its automatic takeover at `epoch`. */
export const RearmRun = Schema.Struct({
  /** The epoch this coordinator took over at. */
  epoch: NonNegativeInt,
  chainId: Schema.String,
  state: Schema.Literals(["pending", "verifying", "armed", "stopped"]),
  reason: Schema.NullOr(StandbyRearmReason),
  detail: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
  /** The standby this run named in the binding. */
  standby: Schema.NullOr(LogicalProjectMember),
  /** The binding's `standby.enabledAt` this run wrote. */
  enabledAt: Schema.NullOr(Schema.String),
  /** A registration sent and not yet answered; persisted before it leaves. */
  inFlight: Schema.NullOr(Schema.Struct({ member: LogicalProjectMember, since: Schema.String })),
  /** Set before this run turns its own standby off to try the next machine. */
  rotatingFrom: Schema.NullOr(LogicalProjectMember),
  failed: Schema.Array(RearmMachineNote),
  /** Machines whose registration got no answer; each is owed a release. */
  uncertain: Schema.Array(Schema.Struct({ member: LogicalProjectMember, since: Schema.String })),
  rotations: NonNegativeInt,
  attempts: NonNegativeInt,
  since: Schema.String,
  updatedAt: Schema.String,
});
export type RearmRun = typeof RearmRun.Type;

export const RearmEntry = Schema.Struct({
  logicalProjectId: Schema.String,
  /** This machine's copy of the project. */
  projectId: Schema.String,
  consent: Schema.NullOr(StandbyRearmConsent),
  consentUpdatedAt: Schema.NullOr(Schema.String),
  run: Schema.NullOr(RearmRun),
});
export type RearmEntry = typeof RearmEntry.Type;

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  projects: Schema.Array(RearmEntry),
});
const StoreFileJson = Schema.fromJsonString(StoreFile);
const decodeStoreFile = Schema.decodeUnknownEffect(StoreFileJson);
const encodeStoreFile = Schema.encodeEffect(StoreFileJson);

export class CoordinatorRearmStoreError extends Schema.TaggedError<CoordinatorRearmStoreError>()(
  "CoordinatorRearmStoreError",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} the coordinator re-arm records.`;
  }
}

export class CoordinatorRearmStore extends Context.Service<
  CoordinatorRearmStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<RearmEntry>, CoordinatorRearmStoreError>;
    readonly get: (
      logicalProjectId: string,
    ) => Effect.Effect<RearmEntry | undefined, CoordinatorRearmStoreError>;
    /**
     * Applies `change` to the entry for `logicalProjectId`. Returning undefined
     * keeps the file as it is; returning null removes the entry.
     */
    readonly modify: (
      logicalProjectId: string,
      change: (current: RearmEntry | undefined) => RearmEntry | null | undefined,
    ) => Effect.Effect<RearmEntry | undefined, CoordinatorRearmStoreError>;
  }
>()("specweave-studio/project/CoordinatorRearmStore") {}

/** Entries in memory, for tests and for runtimes without a state folder. */
export const makeMemory = () => {
  const entries = new Map<string, RearmEntry>();
  const service = CoordinatorRearmStore.of({
    list: Effect.sync(() => [...entries.values()]),
    get: (logicalProjectId) => Effect.sync(() => entries.get(logicalProjectId)),
    modify: (logicalProjectId, change) =>
      Effect.sync(() => {
        const next = change(entries.get(logicalProjectId));
        if (next === undefined) return entries.get(logicalProjectId);
        if (next === null) {
          entries.delete(logicalProjectId);
          return undefined;
        }
        entries.set(logicalProjectId, next);
        return next;
      }),
  });
  return { entries, service };
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
    if (!exists) return [] as ReadonlyArray<RearmEntry>;
    const text = yield* fileSystem.readFileString(filePath);
    return (yield* decodeStoreFile(text)).projects;
  }).pipe(Effect.mapError((cause) => new CoordinatorRearmStoreError({ operation: "read", cause })));

  const write = (projects: ReadonlyArray<RearmEntry>) =>
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
      Effect.mapError((cause) => new CoordinatorRearmStoreError({ operation: "write", cause })),
    );

  const list: CoordinatorRearmStore["Service"]["list"] = lock.withPermit(read);

  const get: CoordinatorRearmStore["Service"]["get"] = (logicalProjectId) =>
    list.pipe(
      Effect.map((projects) =>
        projects.find((project) => project.logicalProjectId === logicalProjectId),
      ),
    );

  const modify: CoordinatorRearmStore["Service"]["modify"] = (logicalProjectId, change) =>
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
          return yield* Effect.die(new Error("A re-arm entry keeps its logical project id."));
        yield* write(
          index === -1
            ? [...projects, next]
            : projects.map((project, position) => (position === index ? next : project)),
        );
        return next;
      }),
    );

  return CoordinatorRearmStore.of({ list, get, modify });
});

export const layer = Layer.effect(CoordinatorRearmStore, make);
