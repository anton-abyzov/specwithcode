import type { ProjectId } from "@specweave-studio/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import { randomBytes, sha256 } from "../nodeCrypto.ts";
import { emptyMemoryHistory, type MemoryHistoryState } from "./linkedMemoryMerge.ts";

/**
 * Which versions each project memory file has had on this machine, and which
 * files were deleted, so linked members can merge memory both ways. One
 * owner-only file per project in the state directory, rewritten atomically like
 * the coordinator replicas; the database is not touched. Losing the file only
 * makes the next merge treat differing files as concurrent edits, which keeps a
 * copy rather than dropping one.
 */
export class LinkedMemoryHistory extends Context.Service<
  LinkedMemoryHistory,
  {
    readonly read: (
      projectId: ProjectId,
    ) => Effect.Effect<MemoryHistoryState, LinkedMemoryHistoryError>;
    readonly modify: (
      projectId: ProjectId,
      update: (state: MemoryHistoryState) => MemoryHistoryState,
    ) => Effect.Effect<MemoryHistoryState, LinkedMemoryHistoryError>;
  }
>()("specweave-studio/project/LinkedMemoryHistory") {}

export class LinkedMemoryHistoryError extends Schema.TaggedError<LinkedMemoryHistoryError>()(
  "LinkedMemoryHistoryError",
  { cause: Schema.optional(Schema.Defect()) },
) {}

/** The hash merges compare: sha256 of the UTF-8 content, lowercase hex. */
export const memoryContentHash = (content: string) => sha256([content], "hex");

const DIRECTORY = "linked-memory";
const Hashes = Schema.Array(Schema.String);
const StoredState = Schema.Struct({
  files: Schema.Record(
    Schema.String,
    Schema.Struct({ history: Hashes, authoredAt: Schema.optionalKey(Schema.String) }),
  ),
  tombstones: Schema.Record(
    Schema.String,
    Schema.Struct({ deletedAt: Schema.String, history: Hashes }),
  ),
});
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(StoredState));

export const layer = Layer.effect(
  LinkedMemoryHistory,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const lock = yield* Semaphore.make(1);
    const directory = path.join(config.stateDir, DIRECTORY);
    // Project ids are not file names; their hash is.
    const fileOf = (projectId: ProjectId) =>
      path.join(directory, `${sha256([projectId], "hex").slice(0, 32)}.json`);
    const failed = (cause: unknown) => new LinkedMemoryHistoryError({ cause });
    const read = (projectId: ProjectId) =>
      Effect.gen(function* () {
        const file = fileOf(projectId);
        if (!(yield* fileSystem.exists(file))) return emptyMemoryHistory;
        const text = yield* fileSystem.readFileString(file);
        // A damaged file reads as empty: merges then keep copies instead of dropping.
        return yield* decodeState(text).pipe(Effect.orElseSucceed(() => emptyMemoryHistory));
      }).pipe(Effect.mapError(failed));
    const write = (projectId: ProjectId, state: MemoryHistoryState) =>
      Effect.gen(function* () {
        yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const file = fileOf(projectId);
        const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
        const text = yield* encodeState(state);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fileSystem.open(temporary, { flag: "w", mode: 0o600 });
            yield* handle.writeAll(new TextEncoder().encode(text));
            yield* handle.sync;
          }),
        );
        yield* fileSystem.rename(temporary, file);
      }).pipe(Effect.mapError(failed));
    return LinkedMemoryHistory.of({
      read: (projectId) => read(projectId).pipe(lock.withPermits(1)),
      modify: (projectId, update) =>
        Effect.gen(function* () {
          const next = update(yield* read(projectId));
          yield* write(projectId, next);
          return next;
        }).pipe(lock.withPermits(1)),
    });
  }),
);

/** For tests: histories kept in memory. */
export const layerMemory = Layer.sync(LinkedMemoryHistory, () => {
  const states = new Map<string, MemoryHistoryState>();
  const read = (projectId: ProjectId) => states.get(projectId) ?? emptyMemoryHistory;
  return LinkedMemoryHistory.of({
    read: (projectId) => Effect.sync(() => read(projectId)),
    modify: (projectId, update) =>
      Effect.sync(() => {
        const next = update(read(projectId));
        states.set(projectId, next);
        return next;
      }),
  });
});
