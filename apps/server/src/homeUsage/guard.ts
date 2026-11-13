/**
 * The home folder guard storage cleanup runs: every six hours at most, never
 * before startup settles (cleanup's own startup delay), it measures the app's
 * home folder in a worker thread, keeps the result in `home-usage.json` beside
 * the database (never in it), attaches it to the storage status clients get,
 * logs a warning when the folder passes the size in settings or a part grows
 * abnormally, and runs the scratch folder retention from the same walk.
 *
 * @module homeUsage/guard
 */
import {
  formatStorageFreeSpace,
  StorageHomeUsage,
  type ServerSettings,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  HOME_USAGE_DEADLINE_MS,
  HOME_USAGE_MAX_ENTRIES,
  homeUsageDue,
  homeUsageLayout,
  homeUsageLevel,
  homeUsageReport,
  measureTree,
  withOldAppVersions,
} from "./measure.ts";
import { oldRuntimeVersionDirsSync } from "../cloud/runtimeVersionRetention.ts";
import { runScratchRetention } from "./scratchRetention.ts";

/** `home-usage.json` in the state folder: the last measurement. */
export const HOME_USAGE_STATE_FILE = "home-usage.json";

const HomeUsageState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  usage: StorageHomeUsage,
});
const decodeHomeUsageState = Schema.decodeUnknownOption(Schema.fromJsonString(HomeUsageState));
const encodeHomeUsageState = Schema.encodeSync(Schema.fromJsonString(HomeUsageState));

/** One line for logs: "172 GB: worktrees 102 GB, database 23 GB, ...". */
export function describeHomeUsage(usage: StorageHomeUsage): string {
  const parts = usage.parts
    .map((part) => `${part.key} ${formatStorageFreeSpace(part.bytes)}`)
    .join(", ");
  return `${formatStorageFreeSpace(usage.totalBytes)}: ${parts}; ${usage.worktreeCount} worktrees`;
}

/** `usage` under a new warning size, or `usage` itself when the size is unchanged. */
export function withWarningSize(
  usage: StorageHomeUsage,
  warnAboveGb: number | null,
): StorageHomeUsage {
  const warnAboveBytes = warnAboveGb === null ? null : warnAboveGb * 1e9;
  if (usage.warnAboveBytes === warnAboveBytes) return usage;
  const grown = usage.parts.filter((part) => part.grewBytes !== undefined).length;
  return {
    ...usage,
    warnAboveBytes,
    level: homeUsageLevel(usage.totalBytes, warnAboveBytes, grown),
  };
}

export const makeHomeUsageGuard = <E>(input: {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly worktreesDir: string;
  readonly logsDir: string;
  readonly foldCase: boolean;
  readonly publish: (usage: StorageHomeUsage) => Effect.Effect<void>;
  readonly processCwds: Effect.Effect<ReadonlyArray<string> | null>;
  /** The orphan-worktree sweep's ownership check. */
  readonly isOwned: (path: string) => Effect.Effect<boolean, E>;
  /** Wraps one removal (the workspace lease the sweeps take). */
  readonly guardRemoval: <A, E2>(
    path: string,
    effect: Effect.Effect<A, E2>,
  ) => Effect.Effect<A, E2>;
  /** Overrides the user's home folder the layout must stay inside (tests). */
  readonly userHome?: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const statePath = path.join(input.stateDir, HOME_USAGE_STATE_FILE);
    const layout = homeUsageLayout(input);
    let last: StorageHomeUsage | null | undefined;

    const readLast = Effect.gen(function* () {
      if (last !== undefined) return last;
      last = yield* fs.readFileString(statePath).pipe(
        Effect.map((text) =>
          Option.match(decodeHomeUsageState(text), {
            onNone: () => null,
            onSome: (state) => state.usage,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
      return last;
    });

    const write = (usage: StorageHomeUsage) =>
      Effect.gen(function* () {
        const temporary = `${statePath}.tmp`;
        yield* fs.writeFileString(temporary, encodeHomeUsageState({ schemaVersion: 1, usage }));
        yield* fs.rename(temporary, statePath);
      }).pipe(
        // Unrecorded, the next start measures again sooner: slower, never unsafe.
        Effect.catch((error) => Effect.logWarning("home usage state write failed", { error })),
      );

    /** Shows the last measurement again after a restart, without walking. */
    const restore = Effect.gen(function* () {
      const usage = yield* readLast;
      if (usage !== null) yield* input.publish(usage);
    });

    const run = Effect.fn("HomeUsageGuard.run")(function* (settings: ServerSettings, now: number) {
      if (layout === null) return;
      const previous = yield* readLast;
      const lastAt = previous === null ? null : Date.parse(previous.checkedAt);
      if (!homeUsageDue(lastAt, now)) {
        // A new warning size applies to the last measurement right away.
        if (previous !== null) {
          const changed = withWarningSize(previous, settings.storageCleanup.homeSizeWarningGb);
          if (changed !== previous) {
            last = changed;
            yield* write(changed);
            yield* input.publish(changed);
          }
        }
        return;
      }
      const walk = yield* measureTree({
        root: layout.root,
        parts: withOldAppVersions(layout.parts, oldRuntimeVersionDirsSync(input.baseDir)),
        maxEntries: HOME_USAGE_MAX_ENTRIES,
        deadlineMs: HOME_USAGE_DEADLINE_MS,
      });
      const usage = homeUsageReport({
        root: layout.root,
        walk,
        warnAboveGb: settings.storageCleanup.homeSizeWarningGb,
        previous,
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      });
      last = usage;
      yield* write(usage);
      yield* input.publish(usage);
      const annotations = {
        level: usage.level,
        totalBytes: usage.totalBytes,
        worktreeCount: usage.worktreeCount,
        complete: usage.complete,
        entries: walk.entries,
        otherDevice: walk.otherDevice,
        unreadable: walk.unreadable,
      };
      yield* usage.level === "ok"
        ? Effect.logInfo(`app folder measured: ${describeHomeUsage(usage)}`).pipe(
            Effect.annotateLogs(annotations),
          )
        : Effect.logWarning(
            `app folder is ${usage.level === "large" ? "over its size warning" : "growing fast"}: ${describeHomeUsage(usage)}`,
          ).pipe(Effect.annotateLogs(annotations));

      const scratch = walk.parts.find((part) => part.key === "scratch");
      if (scratch === undefined || scratch.children.length === 0) return;
      const scratchReal = yield* fs
        .realPath(layout.scratchDir)
        .pipe(Effect.orElseSucceed(() => null));
      if (scratchReal === null) return;
      const removed = yield* runScratchRetention({
        scratchRoots: [scratchReal, layout.scratchDir].filter(
          (value, index, all) => all.indexOf(value) === index,
        ),
        children: scratch.children,
        afterDays: settings.storageCleanup.scratchAfterDays,
        // The sweep's time: later changes read as "in the future" and keep the folder.
        now: Effect.succeed(now),
        foldCase: input.foldCase,
        join: path.join,
        processCwds: input.processCwds,
        measureChildren: (names) =>
          measureTree({
            root: scratchReal,
            parts: [{ key: "scratch", paths: [scratchReal], children: true, onlyChildren: names }],
            maxEntries: HOME_USAGE_MAX_ENTRIES,
            deadlineMs: HOME_USAGE_DEADLINE_MS,
            measureRest: false,
          }).pipe(Effect.map((result) => result.parts[0]?.children ?? [])),
        isOwned: input.isOwned,
        remove: (folder) => input.guardRemoval(folder, fs.remove(folder, { recursive: true })),
      });
      if (removed.length > 0)
        yield* Effect.logInfo("storage cleanup removed old scratch folders", {
          folders: removed.length,
          bytes: removed.reduce((sum, entry) => sum + entry.bytes, 0),
        });
    });

    return { restore, run };
  });
