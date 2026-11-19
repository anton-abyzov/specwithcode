/**
 * Where a machine keeps its handoff transfer records (1390): as a source, one
 * record per thread it moves; as a destination, its verdict per lineage. One
 * JSON file in the state directory, written atomically (temporary file,
 * fsync, rename).
 *
 * Unlike the handoff mode file, a file that does not decode is never read as
 * empty: an empty answer would say "this machine accepted nothing" and "no
 * move is open", and either could start a thread twice. Every read then
 * fails, so no move starts and no hold is released until the file is fixed.
 *
 * The rules over the document are pure, so every one is tested without a
 * server.
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  type EnvironmentId,
  HandoffModeError,
  type HandoffTransferAcceptance,
  HandoffTransferDocument,
  type HandoffTransferLineage,
  type HandoffTransferReceipt,
  type HandoffTransferRecord,
  type HandoffTransferState,
  type HandoffTransferTrigger,
  isHandoffTransferFinished,
  type ThreadId,
} from "@specweave-studio/contracts";

import * as ServerConfig from "../config.ts";
import { parseJson, stringifyJson } from "../json.ts";

const FILE_NAME = "handoff-transfers.json";
/** Finished source records and destination verdicts kept, oldest dropped first. */
export const HANDOFF_TRANSFER_FINISHED_MAX = 300;
export const HANDOFF_TRANSFER_ACCEPTANCE_MAX = 1000;

const decodeDocument = Schema.decodeUnknownOption(HandoffTransferDocument);
const encodeDocument = Schema.encodeSync(HandoffTransferDocument);

export const EMPTY_HANDOFF_TRANSFER_DOCUMENT: HandoffTransferDocument = {
  version: 1,
  transfers: {},
  batches: {},
  acceptances: {},
};

export const TRANSFER_RECORDS_UNREADABLE =
  "This machine cannot read its handoff transfer records, so it starts and releases no handoff until they are readable again.";

const storageFailed = (message: string) => new HandoffModeError({ code: "failed", message });

export interface HandoffTransferStoreShape {
  readonly read: Effect.Effect<HandoffTransferDocument, HandoffModeError>;
  readonly update: <A>(
    change: (document: HandoffTransferDocument) => readonly [A, HandoffTransferDocument],
  ) => Effect.Effect<A, HandoffModeError>;
}

export class HandoffTransferStore extends Context.Service<
  HandoffTransferStore,
  HandoffTransferStoreShape
>()("specweave-studio/handoff/HandoffTransferStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  const target = path.join(config.stateDir, FILE_NAME);

  const readFile = Effect.gen(function* () {
    const exists = yield* fs
      .exists(target)
      .pipe(Effect.mapError(() => storageFailed(TRANSFER_RECORDS_UNREADABLE)));
    if (!exists) return EMPTY_HANDOFF_TRANSFER_DOCUMENT;
    const text = yield* fs
      .readFileString(target)
      .pipe(Effect.mapError(() => storageFailed(TRANSFER_RECORDS_UNREADABLE)));
    const raw = yield* Effect.try({
      try: () => parseJson(text) as unknown,
      catch: () => storageFailed(TRANSFER_RECORDS_UNREADABLE),
    });
    const decoded = decodeDocument(raw);
    if (Option.isNone(decoded)) return yield* storageFailed(TRANSFER_RECORDS_UNREADABLE);
    return decoded.value;
  });

  const writeFile = (document: HandoffTransferDocument) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(config.stateDir, { recursive: true, mode: 0o700 });
      const temporary = `${target}.${yield* crypto.randomUUIDv4}.tmp`;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(temporary, { flag: "wx", mode: 0o600 });
          yield* file.writeAll(new TextEncoder().encode(stringifyJson(encodeDocument(document))));
          yield* file.sync;
        }),
      );
      yield* fs.rename(temporary, target);
    }).pipe(
      Effect.mapError(() => storageFailed("Could not save the handoff transfer records.")),
    );

  let cache: HandoffTransferDocument | null = null;
  const current = Effect.suspend(() =>
    cache === null
      ? readFile.pipe(Effect.tap((document) => Effect.sync(() => (cache = document))))
      : Effect.succeed(cache),
  );

  return HandoffTransferStore.of({
    read: lock.withPermits(1)(current),
    update: (change) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const [result, next] = change(yield* current);
          if (next !== cache) {
            // The file is written before the change is visible: a record that is
            // not on disk never lets a hold or a launch go ahead.
            yield* writeFile(next);
            cache = next;
          }
          return result;
        }),
      ),
  });
});

export const layer = Layer.effect(HandoffTransferStore, make);

/** Records kept in `holder`, which outlives the store: a test restarts a server over it. */
export interface HandoffTransferMemory {
  document: HandoffTransferDocument;
  /** Set to make every read and write fail, as an unreadable file does. */
  unreadable?: boolean;
  /** Return true to make that one write fail and leave the document as it was. */
  failWrite?: ((next: HandoffTransferDocument) => boolean) | null;
}

export const makeMemory = (
  holder: HandoffTransferMemory = { document: EMPTY_HANDOFF_TRANSFER_DOCUMENT },
): Effect.Effect<HandoffTransferStoreShape> =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const current = Effect.suspend(() =>
      holder.unreadable === true
        ? Effect.fail(storageFailed(TRANSFER_RECORDS_UNREADABLE))
        : Effect.succeed(holder.document),
    );
    return {
      read: lock.withPermits(1)(current),
      update: (change) =>
        lock.withPermits(1)(
          Effect.flatMap(current, (document) => {
            const [result, next] = change(document);
            if (next !== document && holder.failWrite?.(next) === true) {
              return Effect.fail(storageFailed(TRANSFER_RECORDS_UNREADABLE));
            }
            holder.document = next;
            return Effect.succeed(result);
          }),
        ),
    };
  });

/**
 * The store of this server, or one in memory where none is provided (a test
 * runtime built without a state directory). The server's own layer provides
 * the file store.
 */
export const fromContext: Effect.Effect<HandoffTransferStoreShape> = Effect.gen(function* () {
  const provided = yield* Effect.serviceOption(HandoffTransferStore);
  return Option.isSome(provided) ? provided.value : yield* makeMemory();
});

// Destination: one verdict per lineage

export function acceptanceKey(lineage: HandoffTransferLineage): string {
  return `${lineage.sourceEnvironmentId}/${lineage.sourceThreadId}@${lineage.epoch}`;
}

const sameThread = (a: HandoffTransferLineage, b: HandoffTransferLineage) =>
  a.sourceEnvironmentId === b.sourceEnvironmentId && a.sourceThreadId === b.sourceThreadId;

function capAcceptances(document: HandoffTransferDocument): HandoffTransferDocument {
  const entries = Object.entries(document.acceptances);
  const excess = entries.length - HANDOFF_TRANSFER_ACCEPTANCE_MAX;
  if (excess <= 0) return document;
  // A verdict still being launched is never dropped.
  const droppable = entries
    .filter(([, entry]) => entry.verdict === "not-accepted" || entry.launched)
    .sort(([, a], [, b]) => a.at.localeCompare(b.at))
    .slice(0, excess)
    .map(([key]) => key);
  if (droppable.length === 0) return document;
  const drop = new Set(droppable);
  return {
    ...document,
    acceptances: Object.fromEntries(entries.filter(([key]) => !drop.has(key))),
  };
}

export type AcceptanceClaim =
  /** This request is the first for its lineage: the verdict is now on record. */
  | { readonly kind: "claimed"; readonly acceptance: HandoffTransferAcceptance }
  /** The same operation again: the same receipt, and the launch is finished if it was cut. */
  | { readonly kind: "duplicate"; readonly acceptance: HandoffTransferAcceptance }
  /** This lineage was already answered "not accepted"; that is final. */
  | { readonly kind: "not-accepted"; readonly acceptance: HandoffTransferAcceptance }
  /** Another operation or checkpoint holds this lineage; neither history changes. */
  | { readonly kind: "divergent"; readonly acceptance: HandoffTransferAcceptance }
  /** This machine accepted the thread at a newer epoch. */
  | { readonly kind: "stale"; readonly acceptance: HandoffTransferAcceptance };

/**
 * Claims a lineage for one operation. The first claim wins and is written
 * before anything is launched; every later request for the lineage reads that
 * verdict and never replaces it.
 */
export function claimAcceptance(
  document: HandoffTransferDocument,
  input: {
    readonly lineage: HandoffTransferLineage;
    readonly operationId: string | null;
    readonly sequence: number;
    readonly receipt: HandoffTransferReceipt;
    readonly trigger: HandoffTransferTrigger | null;
    readonly reason: string;
    readonly modelSelection: HandoffTransferAcceptance["modelSelection"];
    readonly now: string;
  },
): readonly [AcceptanceClaim, HandoffTransferDocument] {
  const key = acceptanceKey(input.lineage);
  const existing = document.acceptances[key];
  if (existing !== undefined) {
    if (existing.verdict === "not-accepted") {
      return [{ kind: "not-accepted", acceptance: existing }, document];
    }
    const same = existing.operationId === input.operationId && existing.sequence === input.sequence;
    return [{ kind: same ? "duplicate" : "divergent", acceptance: existing }, document];
  }
  const newer = Object.values(document.acceptances).find(
    (entry) =>
      entry.verdict === "accepted" &&
      sameThread(entry.lineage, input.lineage) &&
      entry.lineage.epoch > input.lineage.epoch,
  );
  if (newer !== undefined) return [{ kind: "stale", acceptance: newer }, document];
  const acceptance: HandoffTransferAcceptance = {
    lineage: input.lineage,
    operationId: input.operationId,
    sequence: input.sequence,
    verdict: "accepted",
    receipt: input.receipt,
    launched: false,
    reason: input.reason,
    modelSelection: input.modelSelection,
    trigger: input.trigger,
    detail: null,
    at: input.now,
  };
  return [
    { kind: "claimed", acceptance },
    capAcceptances({ ...document, acceptances: { ...document.acceptances, [key]: acceptance } }),
  ];
}

/**
 * A launch that failed outright: the acceptance becomes "not accepted" before
 * the refusal is answered, so a repeat of the operation cannot launch a thread
 * the source was told it kept.
 */
export function revokeAcceptance(
  document: HandoffTransferDocument,
  lineage: HandoffTransferLineage,
  detail: string,
): HandoffTransferDocument {
  const key = acceptanceKey(lineage);
  const existing = document.acceptances[key];
  if (existing === undefined || existing.verdict !== "accepted" || existing.launched) {
    return document;
  }
  return {
    ...document,
    acceptances: {
      ...document.acceptances,
      [key]: {
        ...existing,
        verdict: "not-accepted",
        receipt: null,
        detail: detail.slice(0, 1000),
      },
    },
  };
}

export function markLaunched(
  document: HandoffTransferDocument,
  lineage: HandoffTransferLineage,
): HandoffTransferDocument {
  const key = acceptanceKey(lineage);
  const existing = document.acceptances[key];
  if (existing === undefined || existing.verdict !== "accepted" || existing.launched) {
    return document;
  }
  return {
    ...document,
    acceptances: { ...document.acceptances, [key]: { ...existing, launched: true } },
  };
}

/**
 * The verdict a source asks for when it does not know whether its takeover
 * arrived. An acceptance at this epoch or a newer one answers "accepted" with
 * its receipt. Otherwise "not accepted" is written first and then answered, so
 * a takeover for this lineage that arrives later is refused: the answer is
 * final for the operation.
 */
export function settleLineage(
  document: HandoffTransferDocument,
  input: {
    readonly lineage: HandoffTransferLineage;
    readonly operationId: string | null;
    readonly now: string;
  },
): readonly [HandoffTransferAcceptance, HandoffTransferDocument] {
  const key = acceptanceKey(input.lineage);
  const existing = document.acceptances[key];
  if (existing !== undefined) return [existing, document];
  const newer = Object.values(document.acceptances).find(
    (entry) =>
      entry.verdict === "accepted" &&
      sameThread(entry.lineage, input.lineage) &&
      entry.lineage.epoch > input.lineage.epoch,
  );
  if (newer !== undefined) return [newer, document];
  const refused: HandoffTransferAcceptance = {
    lineage: input.lineage,
    operationId: input.operationId,
    sequence: null,
    verdict: "not-accepted",
    receipt: null,
    launched: false,
    reason: "handoff",
    modelSelection: null,
    trigger: null,
    detail: "The source asked before any takeover arrived.",
    at: input.now,
  };
  return [
    refused,
    capAcceptances({ ...document, acceptances: { ...document.acceptances, [key]: refused } }),
  ];
}

/** The accepted lineage behind a continuation on this machine, if it arrived by a handoff. */
export function arrivalOf(
  document: HandoffTransferDocument,
  continuationThreadId: ThreadId,
): HandoffTransferAcceptance | undefined {
  return Object.values(document.acceptances).find(
    (entry) => entry.verdict === "accepted" && entry.receipt?.threadId === continuationThreadId,
  );
}

/**
 * Should an automatic move of an arrived thread back to where it came from be
 * left out? Yes while it is still on the run it arrived with and the usage
 * window that sent it has not reset. A window nobody named counts as not
 * reset. A move someone asked for is never suppressed.
 */
export function reverseMoveSuppressed(input: {
  readonly arrival: HandoffTransferAcceptance | undefined;
  readonly destinationEnvironmentId: EnvironmentId;
  readonly trigger: HandoffTransferTrigger;
  /** Runs the continuation started here since it arrived. */
  readonly runsSinceArrival: number;
  readonly now: number;
}): boolean {
  if (input.trigger.kind !== "automatic") return false;
  const arrival = input.arrival;
  if (arrival === undefined || arrival.trigger?.kind !== "automatic") return false;
  if (arrival.lineage.sourceEnvironmentId !== input.destinationEnvironmentId) return false;
  if (input.runsSinceArrival > 1) return false;
  const reset = Date.parse(arrival.trigger.usageWindowKey ?? "");
  return !Number.isFinite(reset) || input.now < reset;
}

// Source: one record per thread moved

/** The move of this thread that is not finished, newest first. */
export function openTransfer(
  document: HandoffTransferDocument,
  sourceEnvironmentId: EnvironmentId,
  sourceThreadId: ThreadId,
): HandoffTransferRecord | undefined {
  return Object.values(document.transfers)
    .filter(
      (record) =>
        record.lineage.sourceEnvironmentId === sourceEnvironmentId &&
        record.lineage.sourceThreadId === sourceThreadId &&
        !isHandoffTransferFinished(record.state),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function openTransfers(
  document: HandoffTransferDocument,
  sourceEnvironmentId: EnvironmentId,
): ReadonlyArray<HandoffTransferRecord> {
  return Object.values(document.transfers)
    .filter(
      (record) =>
        record.lineage.sourceEnvironmentId === sourceEnvironmentId &&
        !isHandoffTransferFinished(record.state),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function capTransfers(document: HandoffTransferDocument): HandoffTransferDocument {
  const finished = Object.values(document.transfers)
    .filter((record) => isHandoffTransferFinished(record.state))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const excess = finished.length - HANDOFF_TRANSFER_FINISHED_MAX;
  if (excess <= 0) return document;
  const drop = new Set(finished.slice(0, excess).map((record) => record.operationId));
  const transfers = Object.fromEntries(
    Object.entries(document.transfers).filter(([id]) => !drop.has(id)),
  );
  const batches = Object.fromEntries(
    Object.entries(document.batches).filter(([, batch]) =>
      batch.operationIds.some((id) => transfers[id] !== undefined),
    ),
  );
  return { ...document, transfers, batches };
}

export function putTransfer(
  document: HandoffTransferDocument,
  record: HandoffTransferRecord,
): HandoffTransferDocument {
  return capTransfers({
    ...document,
    transfers: { ...document.transfers, [record.operationId]: record },
  });
}

/**
 * Moves a record from one of `from` to `patch.state`, or changes nothing. The
 * store runs changes one at a time, so of two that start from the same state
 * (send it, or resume it here) exactly one applies.
 */
export function transitionTransfer(
  document: HandoffTransferDocument,
  operationId: string,
  from: ReadonlyArray<HandoffTransferState>,
  patch: Partial<HandoffTransferRecord> & { readonly state: HandoffTransferState },
  now: string,
): readonly [HandoffTransferRecord | null, HandoffTransferDocument] {
  const current = document.transfers[operationId];
  if (current === undefined || !from.includes(current.state)) return [null, document];
  const next: HandoffTransferRecord = { ...current, ...patch, updatedAt: now };
  return [next, putTransfer(document, next)];
}
