/**
 * UsageLimitHistory — subscription quota over time, for burn rates and
 * run-out estimates on the pooled limits view.
 *
 * Follows the same two feeds the limits view draws from: the provider
 * registry (this environment's signed-in instances, including the windows
 * turns push between probes) and `UsageLimitSources` (hub accounts). Each new
 * read becomes a sample per account and window (see `usageLimitHistoryStore`).
 * The history is kept in `<stateDir>/usage-limit-history.json`, written at
 * most once a minute and on shutdown, for fourteen days. A file rather than a
 * table: it is small, rebuilt by use, and costs nothing to lose.
 *
 * @module usage/UsageLimitHistory
 */
import {
  type UsageLimitHistoryInput,
  type UsageLimitHistoryResult,
  WS_METHODS,
  WsUsageLimitHistoryRpcGroup,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";
import {
  type HistoryReading,
  decodeHistoryFile,
  encodeHistoryFile,
  isoAt,
  pruneHistory,
  readHistory,
  readingsFromProviders,
  readingsFromSources,
  recordReading,
} from "./usageLimitHistoryStore.ts";

const HOUR = 60 * 60_000;
const DEFAULT_SINCE_HOURS = 7 * 24;
export const USAGE_LIMIT_HISTORY_FILE = "usage-limit-history.json";

export class UsageLimitHistory extends Context.Service<
  UsageLimitHistory,
  {
    readonly read: (input: UsageLimitHistoryInput) => Effect.Effect<UsageLimitHistoryResult>;
  }
>()("specweave-studio/usage/UsageLimitHistory") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const filePath = path.join(config.stateDir, USAGE_LIMIT_HISTORY_FILE);

  const state = decodeHistoryFile(
    yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => "")),
  );
  // Bumped on every stored change; a save marks the version it wrote, so a
  // change during a write, or a failed write, is saved by the next flush.
  let version = 0;
  let savedVersion = 0;

  const record = (readings: readonly HistoryReading[]) =>
    Effect.sync(() => {
      for (const reading of readings) {
        if (recordReading(state, reading)) version += 1;
      }
    });

  const flush = Effect.gen(function* () {
    if (version === savedVersion) return;
    const writing = version;
    pruneHistory(state, yield* Clock.currentTimeMillis);
    yield* writeFileStringAtomically({ filePath, contents: encodeHistoryFile(state) }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.andThen(
        Effect.sync(() => {
          savedVersion = writing;
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("could not save usage limit history", { cause }),
      ),
    );
  });

  // The registry stream carries changes only, so seed it with what is there now.
  yield* Stream.concat(Stream.fromEffect(providers.getProviders), providers.streamChanges).pipe(
    Stream.runForEach((current) => record(readingsFromProviders(current))),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );
  yield* sources.streamChanges.pipe(
    Stream.runForEach((current) => record(readingsFromSources(current))),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );
  const ticker = yield* Effect.forever(Effect.sleep("60 seconds").pipe(Effect.andThen(flush))).pipe(
    Effect.forkScoped,
  );
  // Stop the periodic save first, so the last save is never cut short by it.
  yield* Effect.addFinalizer(() => Fiber.interrupt(ticker).pipe(Effect.andThen(flush)));

  const read = (input: UsageLimitHistoryInput) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const since = now - (input.sinceHours ?? DEFAULT_SINCE_HOURS) * HOUR;
      return {
        createdAt: isoAt(now),
        series: readHistory(state, since),
      } satisfies UsageLimitHistoryResult;
    });

  return { read } satisfies UsageLimitHistory["Service"];
});

export const layer = Layer.effect(UsageLimitHistory, make);

export const layerRpcHandlers = WsUsageLimitHistoryRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const history = yield* UsageLimitHistory;
    return {
      [WS_METHODS.usageLimitsHistory]: (input) => history.read(input),
    };
  }),
);
