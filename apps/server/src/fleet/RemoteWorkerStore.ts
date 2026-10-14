import { StudioFleetRemoteWorkerState } from "@specweave-studio/contracts/studioFleet";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

/**
 * Workers a coordinator here started on another machine, kept so their
 * completions still reach the coordinator after either server restarts.
 *
 * A JSON file rather than SQLite on purpose: the desktop updater proves the
 * database byte-identical across an update, and a follower writing rows while
 * it runs would fail that proof. Rows are written only on state transitions.
 */
const FILE_NAME = "remote-workers.json";
const PRUNE_AFTER = Duration.days(30);

export const RemoteWorkerRecord = Schema.Struct({
  id: Schema.String,
  callerThreadId: Schema.String,
  projectId: Schema.String,
  machineId: Schema.String,
  environmentId: Schema.String,
  remoteProjectId: Schema.NullOr(Schema.String),
  remoteThreadId: Schema.NullOr(Schema.String),
  title: Schema.String,
  launchStartedAt: Schema.String,
  followedRunId: Schema.NullOr(Schema.String),
  reportBack: Schema.Boolean,
  state: StudioFleetRemoteWorkerState,
  /** The remote thread's last status this server saw. */
  lastStatus: Schema.NullOr(Schema.String),
  deliveredRunIds: Schema.Array(Schema.String),
  /** The run whose wake this server last queued itself, so a lost one can be sent again. */
  lastWakeRunId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lostContactNotified: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type RemoteWorkerRecord = typeof RemoteWorkerRecord.Type;

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  workers: Schema.Array(RemoteWorkerRecord),
});
const StoreFileJson = Schema.fromJsonString(StoreFile);
const decodeStoreFile = Schema.decodeUnknownEffect(StoreFileJson);
const encodeStoreFile = Schema.encodeEffect(StoreFileJson);

export class RemoteWorkerStoreError extends Schema.TaggedError<RemoteWorkerStoreError>()(
  "RemoteWorkerStoreError",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} the remote worker records.`;
  }
}

export class RemoteWorkerStore extends Context.Service<
  RemoteWorkerStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<RemoteWorkerRecord>, RemoteWorkerStoreError>;
    /** Applies `change` to the row with `id` (or inserts it when `change` returns one for undefined). */
    readonly modify: (
      id: string,
      change: (current: RemoteWorkerRecord | undefined) => RemoteWorkerRecord | undefined,
    ) => Effect.Effect<RemoteWorkerRecord | undefined, RemoteWorkerStoreError>;
    /** Drops settled rows untouched for 30 days. */
    readonly prune: (now: number) => Effect.Effect<number, RemoteWorkerStoreError>;
  }
>()("specweave-studio/fleet/RemoteWorkerStore") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, FILE_NAME);
  const lock = yield* Semaphore.make(1);

  const read = Effect.gen(function* () {
    const exists = yield* fileSystem.exists(filePath);
    if (!exists) return [] as ReadonlyArray<RemoteWorkerRecord>;
    const text = yield* fileSystem.readFileString(filePath);
    return (yield* decodeStoreFile(text)).workers;
  }).pipe(Effect.mapError((cause) => new RemoteWorkerStoreError({ operation: "read", cause })));

  const write = (workers: ReadonlyArray<RemoteWorkerRecord>) =>
    Effect.gen(function* () {
      const text = yield* encodeStoreFile({ version: 1, workers });
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
    }).pipe(Effect.mapError((cause) => new RemoteWorkerStoreError({ operation: "write", cause })));

  const list: RemoteWorkerStore["Service"]["list"] = lock.withPermit(read);

  const modify: RemoteWorkerStore["Service"]["modify"] = (id, change) =>
    lock.withPermit(
      Effect.gen(function* () {
        const workers = yield* read;
        const index = workers.findIndex((worker) => worker.id === id);
        const next = change(index === -1 ? undefined : workers[index]);
        if (next === undefined) return index === -1 ? undefined : workers[index];
        const updated =
          index === -1
            ? [...workers, next]
            : workers.map((worker, position) => (position === index ? next : worker));
        yield* write(updated);
        return next;
      }),
    );

  const prune: RemoteWorkerStore["Service"]["prune"] = (now) =>
    lock.withPermit(
      Effect.gen(function* () {
        const workers = yield* read;
        const kept = workers.filter(
          (worker) =>
            !["idle", "stopped", "disposed", "launch_unknown"].includes(worker.state) ||
            now - Date.parse(worker.updatedAt) < Duration.toMillis(PRUNE_AFTER),
        );
        if (kept.length !== workers.length) yield* write(kept);
        return workers.length - kept.length;
      }),
    );

  return RemoteWorkerStore.of({ list, modify, prune });
});

export const layer = Layer.effect(RemoteWorkerStore, make);
