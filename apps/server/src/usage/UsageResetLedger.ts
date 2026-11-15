/**
 * UsageResetLedger — what each subscription window had used when it reset, so
 * the app can say how much quota went unused, week over week.
 *
 * Follows the same two feeds as `UsageLimitHistory` (this environment's
 * signed-in instances and the hubs it polls) and closes a period whenever a
 * weekly or monthly window starts over between two reads. Kept in
 * `<stateDir>/usage-reset-ledger.json` for a year, written at most once a
 * minute and on shutdown. Its own file, not the history's: the history drops
 * samples after fourteen days and a report needs months.
 *
 * @module usage/UsageResetLedger
 */
import {
  type ServerProvider,
  type UsageLimitSourceSnapshot,
  type UsageResetLedgerInput,
  type UsageResetLedgerResult,
  WS_METHODS,
  WsUsageResetLedgerRpcGroup,
} from "@specweave-studio/contracts";
import { limitAccountKey } from "@specweave-studio/shared/usageLimits";
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
  isoAt,
  readingsFromProviders,
  readingsFromSources,
} from "./usageLimitHistoryStore.ts";
import {
  type LedgerReading,
  advanceLedger,
  decodeLedgerFile,
  encodeLedgerFile,
  pruneLedger,
  readLedger,
} from "./usageResetLedgerStore.ts";

const DAY = 24 * 60 * 60_000;
const DEFAULT_SINCE_DAYS = 90;
export const USAGE_RESET_LEDGER_FILE = "usage-reset-ledger.json";

export class UsageResetLedger extends Context.Service<
  UsageResetLedger,
  {
    readonly read: (input: UsageResetLedgerInput) => Effect.Effect<UsageResetLedgerResult>;
  }
>()("specweave-studio/usage/UsageResetLedger") {}

/** Readings of this environment's instances, each with the account's banked resets. */
export function ledgerReadingsFromProviders(providers: readonly ServerProvider[]): LedgerReading[] {
  const credits = new Map<string, number>();
  for (const provider of providers) {
    const limits = provider.usageLimits;
    const count = limits?.resetCredits?.availableCount;
    if (limits === undefined || count === undefined) continue;
    const accountKey = limitAccountKey(provider.driver, provider.auth.email, limits);
    if (accountKey !== null) credits.set(accountKey, count);
  }
  return readingsFromProviders(providers).map((reading) => ({
    ...reading,
    resetCredits: credits.get(reading.accountKey) ?? null,
  }));
}

export function ledgerReadingsFromSources(
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
): LedgerReading[] {
  const credits = new Map<string, number>();
  for (const source of sources) {
    for (const account of source.accounts) {
      const limits = account.usageLimits;
      const count = limits?.resetCredits?.availableCount;
      if (limits === undefined || count === undefined) continue;
      const accountKey = limitAccountKey(account.driver, account.email, limits);
      if (accountKey !== null) credits.set(accountKey, count);
    }
  }
  return readingsFromSources(sources).map((reading) => ({
    ...reading,
    resetCredits: credits.get(reading.accountKey) ?? null,
  }));
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const sources = yield* UsageLimitSources.UsageLimitSources;
  const filePath = path.join(config.stateDir, USAGE_RESET_LEDGER_FILE);

  const state = decodeLedgerFile(
    yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => "")),
  );
  // Cursors move on every read, but only a closed period or a new window is
  // worth a write: a lost cursor move costs at most the reads since the last save.
  let version = 0;
  let savedVersion = 0;

  const record = (readings: readonly LedgerReading[]) =>
    Effect.sync(() => {
      for (const reading of readings) {
        const cursorsBefore = state.cursors.size;
        const closed = advanceLedger(state, reading);
        if (closed.length > 0 || state.cursors.size !== cursorsBefore) version += 1;
      }
    });

  const flush = (force: boolean) =>
    Effect.gen(function* () {
      if (!force && version === savedVersion) return;
      const writing = version;
      pruneLedger(state, yield* Clock.currentTimeMillis);
      yield* writeFileStringAtomically({ filePath, contents: encodeLedgerFile(state) }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.andThen(
          Effect.sync(() => {
            savedVersion = writing;
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("could not save usage reset ledger", { cause }),
        ),
      );
    });

  yield* Stream.concat(Stream.fromEffect(providers.getProviders), providers.streamChanges).pipe(
    Stream.runForEach((current) => record(ledgerReadingsFromProviders(current))),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );
  yield* sources.streamChanges.pipe(
    Stream.runForEach((current) => record(ledgerReadingsFromSources(current))),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );
  const ticker = yield* Effect.forever(
    Effect.sleep("60 seconds").pipe(Effect.andThen(flush(false))),
  ).pipe(Effect.forkScoped);
  // Shutdown saves the cursors too, so the last read before a restart is not lost.
  yield* Effect.addFinalizer(() =>
    Fiber.interrupt(ticker).pipe(Effect.andThen(flush(state.cursors.size > 0))),
  );

  const read = (input: UsageResetLedgerInput) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const since = now - (input.sinceDays ?? DEFAULT_SINCE_DAYS) * DAY;
      return {
        createdAt: isoAt(now),
        periods: readLedger(state, since),
      } satisfies UsageResetLedgerResult;
    });

  return { read } satisfies UsageResetLedger["Service"];
});

export const layer = Layer.effect(UsageResetLedger, make);

export const layerRpcHandlers = WsUsageResetLedgerRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const ledger = yield* UsageResetLedger;
    return {
      [WS_METHODS.usageLimitsResets]: (input) => ledger.read(input),
    };
  }),
);
