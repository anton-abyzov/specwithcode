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
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { stringifyJson } from "../json.ts";
import { sha256 } from "../nodeCrypto.ts";

const FILE_NAME = "coordinator-messages.json";
/** How long a settled record is kept. */
export const COORDINATOR_MESSAGE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many records, whatever their state. */
export const COORDINATOR_MESSAGE_MAX_ROWS = 2000;
/** At most this many bytes on disk; a larger file is refused before it is parsed. */
export const COORDINATOR_MESSAGE_MAX_FILE_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 65_536;

export const CoordinatorMessageRecord = Schema.Struct({
  /** This machine's own id for the record (`coordinatorMessageRowId`); never the peer's. */
  id: Schema.String,
  /** The id the message travels under: the sender's for an incoming one, this machine's for an outgoing one. */
  externalId: CoordinatorMessageId,
  direction: Schema.Literals(["incoming", "outgoing"]),
  /** Outgoing: the receiver's id, including the id of a merged earlier message. */
  receiverMessageId: Schema.optional(CoordinatorMessageId),
  /** Outgoing: both link identities at send time, so a remove/rejoin cannot revive the old queue. */
  outgoingMembership: Schema.optional(Schema.String),
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
  /**
   * Incoming: the authority it was admitted under, checked again before it
   * reaches the agent. The grant policy's identity (created and last changed),
   * whether the sender's credential could operate, the session and the
   * membership it came under.
   */
  admittedUnder: Schema.optional(
    Schema.Struct({
      grantStamp: Schema.String,
      operate: Schema.Boolean,
      /** What the sender advertised when it was admitted; no later negotiation. */
      capabilities: Schema.Array(Schema.String),
      /** The authenticated session that sent it, checked live again before delivery. */
      sessionId: Schema.String,
      /** Both members' link identities (`linkId`, `generation`) when it was admitted. */
      membership: Schema.String,
      /** The team rules the sender named on the request; the reach check uses them again. */
      teamRulesFingerprint: Schema.optional(Schema.String),
      /** The credential's signed expiry, epoch milliseconds; a renewed session keeps it. */
      credentialExpiresAt: Schema.optional(Schema.Number),
      /** The device facts the credential carried; the device approval is checked again. */
      device: Schema.optional(
        Schema.Struct({
          proofKeyThumbprint: Schema.optional(Schema.String),
          boundDevice: Schema.optional(
            Schema.Struct({ key: Schema.String, approval: Schema.String }),
          ),
        }),
      ),
    }),
  ),
  /** Raised by every merge, so a delivery marks only the text it actually sent. */
  revision: Schema.optional(NonNegativeInt),
  /**
   * Incoming: the turn it was sent as, and the revision sent. It counts as
   * delivered once a provider took that turn's prompt.
   */
  startedRun: Schema.optional(
    Schema.Struct({ threadId: Schema.String, runId: Schema.String, revision: NonNegativeInt }),
  ),
  /** Incoming: the turn this message woke, retained after delivery for reply-loop fencing. */
  wokenRunId: Schema.optional(Schema.String),
  /**
   * Incoming: written before the wake starts a turn, so the woken turn is
   * fenced even when recording its run id afterwards fails.
   */
  wakePending: Schema.optional(
    Schema.Struct({
      threadId: Schema.String,
      commandId: Schema.String,
      /** The revision sent, so a turn the send started settles only that text. */
      revision: Schema.optional(NonNegativeInt),
    }),
  ),
  /** Outgoing: the coordinator turn that sent it, so a woken turn sends one reply. */
  sourceRunId: Schema.optional(Schema.String),
  /** Outgoing: the receiver gave a final answer or none it will ever give; stop asking. */
  receiptStopped: Schema.optional(Schema.Boolean),
  /** Incoming: sends that ended before any provider took them; each retry gets new ids. */
  startAttempt: Schema.optional(NonNegativeInt),
  /** Incoming: thread refs left out because this machine could not place them in the project. */
  droppedRefs: Schema.optional(NonNegativeInt),
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
  { operation: Schema.Literals(["read", "write", "full"]), cause: Schema.Defect() },
) {
  override get message(): string {
    return this.operation === "full"
      ? "This machine keeps as many coordinator messages as it can."
      : `Could not ${this.operation} the coordinator messages kept on this machine.`;
  }
}

/**
 * This machine's id for a message: the authenticated peer, the direction,
 * the project and the id it travels under, so two peers (or two projects)
 * that choose the same id never share a record.
 */
export const coordinatorMessageRowId = (input: {
  readonly peerEnvironmentId: string;
  readonly direction: "incoming" | "outgoing";
  readonly projectId: string;
  readonly externalId: string;
}) =>
  `cm-${sha256([input.peerEnvironmentId, "\u0000", input.direction, "\u0000", input.projectId, "\u0000", input.externalId]).toString("hex").slice(0, 40)}`;

type Records = ReadonlyArray<CoordinatorMessageRecord>;

export interface CoordinatorMessageStoreShape {
  readonly all: Effect.Effect<Records, CoordinatorMessageStoreError>;
  /**
   * Runs `change` on every record under one lock and writes what it returns.
   * `at` is the clock after the permit is held and the records are read.
   * `now` drops records settled longer than a week.
   */
  readonly update: <A>(
    now: number,
    change: (records: Records, at: number) => { readonly records: Records; readonly result: A },
  ) => Effect.Effect<A, CoordinatorMessageStoreError>;
  /** Runs `effect` under the same permit `update` waits for. */
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class CoordinatorMessageStore extends Context.Service<
  CoordinatorMessageStore,
  CoordinatorMessageStoreShape
>()("specweave-studio/project/CoordinatorMessageStore") {}

/** Records still waiting to go out; never pruned. */
export const COORDINATOR_MESSAGE_PENDING_STATES: ReadonlySet<CoordinatorMessageRecord["state"]> =
  new Set(["settling", "held", "folded", "queued"]);
const pending = COORDINATOR_MESSAGE_PENDING_STATES;

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
      withPermit: (effect) => lock.withPermit(effect),
      update: (now, change) =>
        lock.withPermit(
          Effect.gen(function* () {
            const before = yield* read;
            const at = yield* Clock.currentTimeMillis;
            const { records, result } = change(before, at);
            if (records !== before) {
              const kept = pruneRecords(records, now);
              // Budgets before the write, whatever the records' states.
              const bytes = new TextEncoder().encode(
                stringifyJson({ version: 1, messages: kept }),
              ).byteLength;
              if (
                kept.length > COORDINATOR_MESSAGE_MAX_ROWS ||
                bytes > COORDINATOR_MESSAGE_MAX_FILE_BYTES
              )
                return yield* new CoordinatorMessageStoreError({
                  operation: "full",
                  cause: new Error(`${kept.length} records, ${bytes} bytes`),
                });
              yield* write(kept);
            }
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

    /** The file's text, refused by the size on its open handle before anything is parsed. */
    const readBounded = Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fileSystem.open(filePath, { flag: "r" });
        const info = yield* file.stat;
        if (info.type !== "File" || info.size > BigInt(COORDINATOR_MESSAGE_MAX_FILE_BYTES))
          return yield* new CoordinatorMessageStoreError({
            operation: "read",
            cause: new Error(`The file is ${info.size} bytes.`),
          });
        const chunks: Array<Uint8Array> = [];
        let total = 0;
        while (total <= COORDINATOR_MESSAGE_MAX_FILE_BYTES) {
          const next = yield* file.readAlloc(READ_CHUNK_BYTES);
          if (Option.isNone(next) || next.value.byteLength === 0) break;
          chunks.push(next.value);
          total += next.value.byteLength;
        }
        // The file grew after the size was read.
        if (total > COORDINATOR_MESSAGE_MAX_FILE_BYTES)
          return yield* new CoordinatorMessageStoreError({
            operation: "read",
            cause: new Error("The file grew past its budget."),
          });
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return new TextDecoder().decode(bytes);
      }),
    );

    const read = Effect.gen(function* () {
      if (!(yield* fileSystem.exists(filePath))) return [] as Records;
      return (yield* decodeStoreFile(yield* readBounded)).messages;
    }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "CoordinatorMessageStoreError"
          ? cause
          : new CoordinatorMessageStoreError({ operation: "read", cause }),
      ),
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
