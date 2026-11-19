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
  type ResetAnnouncement,
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
  listedAnnouncements,
  recordIntoFile,
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
    /**
     * Keeps a post an agent read itself (AC-09), next to the feed's. `recorded` is false
     * when the post was already known by its link, falls outside the retention, or could
     * not be saved (`saved` false).
     */
    readonly record: (
      announcement: ResetAnnouncement,
    ) => Effect.Effect<{ readonly recorded: boolean; readonly saved: boolean }>;
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
      // Two first readers may both get here; whoever stored first stands, so a slow file
      // read never replaces what a check has merged since.
      return yield* Ref.updateAndGet(file, (stored) => stored ?? fromDisk).pipe(
        Effect.map((stored) => stored ?? fromDisk),
      );
    });

    const setting = settings.getSettings.pipe(
      Effect.map((value) => value.resetAnnouncementsEnabled !== false),
    );
    /** For the list: unreadable settings do not claim the person turned it off. */
    const enabled = setting.pipe(Effect.orElseSucceed(() => true));
    /** For fetching: when the switch cannot be read, nothing is requested. */
    const mayFetch = setting.pipe(Effect.orElseSucceed(() => false));

    /** Writes `next`; true once it is on disk. */
    const write = (next: AnnouncementFile) =>
      writeFileStringAtomically({ filePath, contents: encodeAnnouncementFile(next) }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not save reset announcements", { cause }).pipe(Effect.as(false)),
        ),
      );
    /** A feed read is kept in memory even when the disk refuses it: the next read repeats it. */
    const save = (next: AnnouncementFile) => Ref.set(file, next).pipe(Effect.andThen(write(next)));

    const record: ResetAnnouncementMonitor["Service"]["record"] = (announcement) =>
      Effect.gen(function* () {
        const before = yield* current;
        const now = yield* Clock.currentTimeMillis;
        const next = recordIntoFile(before, announcement, now);
        if (!next.recorded) return { recorded: false, saved: true };
        // A recording is kept only once it is on disk, so "recorded" never outlives a restart.
        const saved = yield* write(next.file);
        if (saved) yield* Ref.set(file, next.file);
        return { recorded: saved, saved };
      }).pipe(lock.withPermits(1));

    const check = Effect.gen(function* () {
      if (!(yield* mayFetch)) return;
      const before = yield* current;
      const [confirmed, promised] = yield* Effect.all(
        [
          Effect.promise(() => fetchFeed(CONFIRMED_FEED_URL, before.etags.confirmed, fetcher)),
          Effect.promise(() => fetchFeed(PROMISED_FEED_URL, before.etags.promised, fetcher)),
        ],
        { concurrency: "unbounded" },
      );
      const now = yield* Clock.currentTimeMillis;
      yield* save(applyFeedReadings(before, { confirmed, promised }, now));
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Reset announcement check failed", { cause })),
      lock.withPermits(1),
    );

    const list = Effect.gen(function* () {
      const loaded = yield* current;
      const on = yield* enabled;
      const now = yield* Clock.currentTimeMillis;
      return {
        // Filtered on read too: the saved file may hold a post dated ahead of now or past
        // the retention, and no check may have run since (announcements off, or offline).
        announcements: listedAnnouncements(loaded, now),
        enabled: on,
        ...(on && loaded.checkedAt !== null ? { checkedAt: isoAt(loaded.checkedAt) } : {}),
      } as ResetAnnouncementsResult;
    });

    const start: ResetAnnouncementMonitor["Service"]["start"] = () =>
      forkParked(
        Effect.sleep(FIRST_CHECK_DELAY).pipe(
          Effect.andThen(check.pipe(Effect.repeat(Schedule.spaced(CHECK_INTERVAL)))),
          Effect.asVoid,
        ),
      );

    return ResetAnnouncementMonitor.of({ list, record, check, start });
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
