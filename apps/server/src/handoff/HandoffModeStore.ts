import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { HandoffModeError } from "@specweave-studio/contracts";

import * as ServerConfig from "../config.ts";
import { parseJson, stringifyJson } from "../json.ts";
import { EMPTY_HANDOFF_DOCUMENT, HandoffDocument } from "./handoffState.ts";

const FILE_NAME = "handoff-mode.json";
const decodeDocument = Schema.decodeUnknownOption(HandoffDocument);
const encodeDocument = Schema.encodeSync(HandoffDocument);

const storageFailed = (message: string) => new HandoffModeError({ code: "failed", message });

/**
 * One JSON file in the state directory. Updates are serialized and written
 * atomically (temporary file, fsync, rename); a file that does not decode
 * reads as empty rather than blocking the server.
 */
export class HandoffModeStore extends Context.Service<
  HandoffModeStore,
  {
    readonly read: Effect.Effect<HandoffDocument, HandoffModeError>;
    readonly update: <A>(
      change: (document: HandoffDocument) => readonly [A, HandoffDocument],
    ) => Effect.Effect<A, HandoffModeError>;
  }
>()("specweave-studio/handoff/HandoffModeStore") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  const target = path.join(config.stateDir, FILE_NAME);

  const readFile = Effect.gen(function* () {
    if (!(yield* fs.exists(target))) return EMPTY_HANDOFF_DOCUMENT;
    const text = yield* fs.readFileString(target);
    const raw = yield* Effect.try({
      try: () => parseJson(text) as unknown,
      catch: () => storageFailed("The handoff mode file is not valid JSON."),
    }).pipe(Effect.orElseSucceed(() => null));
    return Option.getOrElse(decodeDocument(raw), () => EMPTY_HANDOFF_DOCUMENT);
  }).pipe(Effect.mapError(() => storageFailed("Could not read the handoff mode file.")));

  const writeFile = (document: HandoffDocument) =>
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
    }).pipe(Effect.mapError(() => storageFailed("Could not save the handoff mode file.")));

  let cache: HandoffDocument | null = null;
  const current = Effect.suspend(() =>
    cache === null
      ? readFile.pipe(Effect.tap((document) => Effect.sync(() => (cache = document))))
      : Effect.succeed(cache),
  );

  return HandoffModeStore.of({
    read: lock.withPermits(1)(current),
    update: (change) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const [result, next] = change(yield* current);
          if (next !== cache) {
            yield* writeFile(next);
            cache = next;
          }
          return result;
        }),
      ),
  });
});

export const layer = Layer.effect(HandoffModeStore, make);
