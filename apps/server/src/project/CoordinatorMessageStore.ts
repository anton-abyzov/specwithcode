/**
 * The coordinator messages this machine keeps, one record per message and
 * direction, keyed by message id: incoming messages from another machine's
 * coordinator and (T-06) outgoing ones this machine's coordinator sent. The
 * conversation message names only the id; the live state (merge count,
 * delivery) is read here.
 *
 * A JSON file, like the work grants, so the database stays byte-identical
 * across an update. Records older than a week are dropped on write.
 *
 * @module CoordinatorMessageStore
 */
import {
  CoordinatorMessageId,
  CoordinatorMessageKind,
  CoordinatorMessageRef,
  CoordinatorMessageState,
  CoordinatorMessageUserStep,
  EnvironmentId,
  NonNegativeInt,
  ProjectId,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

const FILE_NAME = "coordinator-messages.json";
/** How long a settled record is kept. */
export const COORDINATOR_MESSAGE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export const CoordinatorMessageRecord = Schema.Struct({
  id: CoordinatorMessageId,
  direction: Schema.Literals(["incoming", "outgoing"]),
  /** The other machine: the sender of an incoming message, the recipient of an outgoing one. */
  peerEnvironmentId: EnvironmentId,
  projectId: ProjectId,
  logicalProjectId: Schema.String,
  /** Every send this record stands for, so a retry of a merged send is a duplicate too. */
  clientRequestIds: Schema.Array(Schema.String),
  kind: CoordinatorMessageKind,
  subject: Schema.String,
  text: Schema.String,
  userStep: Schema.optional(CoordinatorMessageUserStep),
  refs: Schema.Array(CoordinatorMessageRef),
  replyTo: Schema.optional(CoordinatorMessageId),
  dedupeKey: Schema.String,
  count: NonNegativeInt,
  state: CoordinatorMessageState,
  /** Epoch milliseconds. */
  receivedAt: Schema.Number,
  updatedAt: Schema.Number,
  /** Incoming: not delivered before this (the settle window, or the digest's hour). */
  deliverAfter: Schema.optional(Schema.Number),
});
export type CoordinatorMessageRecord = typeof CoordinatorMessageRecord.Type;

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  messages: Schema.Array(CoordinatorMessageRecord),
});
const StoreFileJson = Schema.fromJsonString(StoreFile);
const decodeStoreFile = Schema.decodeUnknownEffect(StoreFileJson);
const encodeStoreFile = Schema.encodeEffect(StoreFileJson);

export class CoordinatorMessageStoreError extends Schema.TaggedError<CoordinatorMessageStoreError>()(
  "CoordinatorMessageStoreError",
  { operation: Schema.Literals(["read", "write"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not ${this.operation} the coordinator messages kept on this machine.`;
  }
}

type Records = ReadonlyArray<CoordinatorMessageRecord>;

export interface CoordinatorMessageStoreShape {
  readonly all: Effect.Effect<Records, CoordinatorMessageStoreError>;
  /**
   * Runs `change` on every record under one lock and writes what it returns.
   * `now` drops records settled longer than a week.
   */
  readonly update: <A>(
    now: number,
    change: (records: Records) => { readonly records: Records; readonly result: A },
  ) => Effect.Effect<A, CoordinatorMessageStoreError>;
}

export class CoordinatorMessageStore extends Context.Service<
  CoordinatorMessageStore,
  CoordinatorMessageStoreShape
>()("specweave-studio/project/CoordinatorMessageStore") {}

const pending = new Set<CoordinatorMessageRecord["state"]>(["settling", "held", "folded", "queued"]);

/** Drops records that settled more than a week ago; nothing still waiting is dropped. */
export const pruneRecords = (records: Records, now: number): Records =>
  records.filter(
    (record) => pending.has(record.state) || now - record.updatedAt < COORDINATOR_MESSAGE_KEEP_MS,
  );

const makeWith = (
  read: Effect.Effect<Records, CoordinatorMessageStoreError>,
  write: (records: Records) => Effect.Effect<void, CoordinatorMessageStoreError>,
) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    return CoordinatorMessageStore.of({
      all: lock.withPermit(read),
      update: (now, change) =>
        lock.withPermit(
          Effect.gen(function* () {
            const before = yield* read;
            const { records, result } = change(before);
            if (records !== before) yield* write(pruneRecords(records, now));
            return result;
          }),
        ),
    });
  });

/** In memory, for tests. */
export const layerMemory = (initial: Records = []) =>
  Layer.effect(
    CoordinatorMessageStore,
    Effect.gen(function* () {
      const ref = yield* Ref.make(initial);
      return yield* makeWith(Ref.get(ref), (records) => Ref.set(ref, records));
    }),
  );

export const layer = Layer.effect(
  CoordinatorMessageStore,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const config = yield* ServerConfig.ServerConfig;
    const filePath = path.join(config.stateDir, FILE_NAME);

    const read = Effect.gen(function* () {
      if (!(yield* fileSystem.exists(filePath))) return [] as Records;
      return (yield* decodeStoreFile(yield* fileSystem.readFileString(filePath))).messages;
    }).pipe(
      Effect.mapError((cause) => new CoordinatorMessageStoreError({ operation: "read", cause })),
    );

    const write = (messages: Records) =>
      Effect.gen(function* () {
        const text = yield* encodeStoreFile({ version: 1, messages });
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
        Effect.mapError((cause) => new CoordinatorMessageStoreError({ operation: "write", cause })),
      );

    return yield* makeWith(read, write);
  }),
);
