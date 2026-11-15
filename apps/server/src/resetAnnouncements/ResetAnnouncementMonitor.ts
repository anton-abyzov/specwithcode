/**
 * ResetAnnouncementMonitor — reads the public reset-announcement feeds every
 * half hour with a conditional request and keeps each post once in
 * `<stateDir>/reset-announcements.json`. Reading the list never waits on the
 * network. The feed can be turned off in settings; then nothing is fetched
 * and what was already read stays listed.
 *
 * @module resetAnnouncements/ResetAnnouncementMonitor
 */
import {
  type ResetAnnouncementsResult,
  WS_METHODS,
  WsResetAnnouncementRpcGroup,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { isoAt } from "../usage/usageLimitHistoryStore.ts";
import {
  type AnnouncementFile,
  CONFIRMED_FEED_URL,
  EMPTY_ANNOUNCEMENT_FILE,
  PROMISED_FEED_URL,
  applyFeedReadings,
  decodeAnnouncementFile,
  encodeAnnouncementFile,
  fetchFeed,
} from "./feeds.ts";

const FIRST_CHECK_DELAY = Duration.seconds(45);
/** AC-08: at most every 30 minutes. */
const CHECK_INTERVAL = Duration.minutes(30);
export const RESET_ANNOUNCEMENTS_FILE = "reset-announcements.json";

export class ResetAnnouncementMonitor extends Context.Service<
  ResetAnnouncementMonitor,
  {
    /** What has been read so far, without fetching anything. */
    readonly list: Effect.Effect<ResetAnnouncementsResult>;
    /** Reads the feeds now, unless they are turned off. */
    readonly check: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("specweave-studio/resetAnnouncements/ResetAnnouncementMonitor") {}

export const makeWith = (fetcher: typeof globalThis.fetch) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettings.ServerSettingsService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(config.stateDir, RESET_ANNOUNCEMENTS_FILE);
    const file = yield* Ref.make<AnnouncementFile | null>(null);
    const lock = yield* Semaphore.make(1);

    const current = Effect.gen(function* () {
      const loaded = yield* Ref.get(file);
      if (loaded !== null) return loaded;
      const fromDisk = yield* fs.readFileString(filePath).pipe(
        Effect.map(decodeAnnouncementFile),
        Effect.orElseSucceed(() => EMPTY_ANNOUNCEMENT_FILE),
      );
      yield* Ref.set(file, fromDisk);
      return fromDisk;
    });

    const enabled = settings.getSettings.pipe(
      Effect.map((value) => value.resetAnnouncementsEnabled !== false),
      Effect.orElseSucceed(() => true),
    );

    const check = Effect.gen(function* () {
      if (!(yield* enabled)) return;
      const before = yield* current;
      const [confirmed, promised] = yield* Effect.all(
        [
          Effect.promise(() => fetchFeed(CONFIRMED_FEED_URL, before.etags.confirmed, fetcher)),
          Effect.promise(() => fetchFeed(PROMISED_FEED_URL, before.etags.promised, fetcher)),
        ],
        { concurrency: "unbounded" },
      );
      const now = yield* Clock.currentTimeMillis;
      const next = applyFeedReadings(before, { confirmed, promised }, now);
      yield* Ref.set(file, next);
      yield* writeFileStringAtomically({
        filePath,
        contents: encodeAnnouncementFile(next),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not save reset announcements", { cause }),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Reset announcement check failed", { cause })),
      lock.withPermits(1),
    );

    const list = Effect.gen(function* () {
      const loaded = yield* current;
      const on = yield* enabled;
      return {
        announcements: loaded.announcements,
        enabled: on,
        ...(on && loaded.checkedAt !== null
          ? { checkedAt: isoAt(loaded.checkedAt) }
          : {}),
      } as ResetAnnouncementsResult;
    });

    const start: ResetAnnouncementMonitor["Service"]["start"] = () =>
      forkParked(
        Effect.sleep(FIRST_CHECK_DELAY).pipe(
          Effect.andThen(check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)))),
          Effect.asVoid,
        ),
      );

    return ResetAnnouncementMonitor.of({ list, check, start });
  });

export const layer = Layer.effect(ResetAnnouncementMonitor, makeWith(globalThis.fetch));

/** Reads the feeds for the server's lifetime. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const monitor = yield* ResetAnnouncementMonitor;
    yield* monitor.start();
  }),
);

export const layerRpcHandlers = WsResetAnnouncementRpcGroup.middleware(RpcInstrumentation).toLayer(
  Effect.gen(function* () {
    const monitor = yield* ResetAnnouncementMonitor;
    return {
      [WS_METHODS.resetAnnouncementsList]: () => monitor.list,
    };
  }),
);
