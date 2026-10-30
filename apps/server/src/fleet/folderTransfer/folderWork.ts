/**
 * Folder copies in flight on this machine, so a normal update waits for them.
 *
 * A normal update (a fleet request, `update --if-idle`, the update agent's
 * automatic install) restarts the service only when that cuts nothing off, and
 * the database and process checks it makes cannot see a folder copy: the source
 * serves chunks in-process and the destination keeps its state in JSON files. The
 * handoff service registers what it serves and pulls here, `ServiceUpdatePreparation`
 * reports the count as `folderCopies`, and while any is in flight this process keeps
 * `<baseDir>/updates/folder-work.json` fresh for the macOS update helper
 * (`scripts/studio-fleet/folder_work.py`), which reads nothing else.
 *
 * Only work that progresses counts: a scan, build, chunk read or background step
 * running now, a destination that pulled within `SOURCE_RECENT_MS`, and a coordinator
 * fenced for one of those or within `MOVE_FENCE_RECENT_MS`. A measured folder nobody
 * pulls, a copy waiting on a person and a fence a crash left behind never hold an
 * update back.
 *
 * @module folderWork
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { stringifyJson } from "../../json.ts";
import type { DestinationCopies } from "./destinationService.ts";
import type { SourceTransfers } from "./sourceService.ts";

export type FolderWorkRole = "source" | "destination" | "move";

export interface FolderWorkItem {
  readonly operationId: string;
  readonly role: FolderWorkRole;
  /** The copy's state on this side, such as `ready` or `applying`. */
  readonly state: string;
}

/**
 * A destination retries a source that does not answer with waits of up to 30 s,
 * so a source pulled from within this long is still being copied. A held copy's
 * hourly keepalive is not a pull.
 */
export const SOURCE_RECENT_MS = 2 * 60_000;
/**
 * A coordinator fence with no live copy behind it counts for this long after it was
 * written: a Git handoff's destination takes over within it, and a fence left behind
 * by a crash stops holding updates back after it.
 */
export const MOVE_FENCE_RECENT_MS = 10 * 60_000;
/** `updates/folder-work.json`; `folder_work.py` FILE. */
export const HEARTBEAT_FILE = "folder-work.json";
/** How often the file is written again while the same copies run. */
export const HEARTBEAT_EVERY_MS = 10_000;
/**
 * How often what runs is looked at: a copy that starts, or one more, is in the file
 * within this, not up to `HEARTBEAT_EVERY_MS` later, so an install that reads it right
 * after a copy began still waits.
 */
export const HEARTBEAT_SAMPLE_MS = 1_000;
/** How long one write counts for, so a process that died stops holding updates soon after. */
export const HEARTBEAT_TTL_MS = 60_000;
/** How far ahead of its reader's clock a write may be dated; `folder_work.py` SKEW. */
const HEARTBEAT_SKEW_MS = 30_000;

export class FolderWorkActivity extends Context.Service<
  FolderWorkActivity,
  {
    /** Adds what one handoff service serves and pulls, until the caller's scope closes. */
    readonly register: (
      probe: Effect.Effect<ReadonlyArray<FolderWorkItem>>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly inFlight: Effect.Effect<ReadonlyArray<FolderWorkItem>>;
  }
>()("specweave-studio/fleet/folderTransfer/folderWork/FolderWorkActivity") {}

/** The number an update reports as `folderCopies`: one per operation, whichever sides run here. */
export const countOperations = (items: ReadonlyArray<FolderWorkItem>): number =>
  new Set(items.map((item) => item.operationId)).size;

/** "1 folder copy" or "3 folder copies". */
export const folderCopiesText = (count: number): string =>
  `${count} folder ${count === 1 ? "copy" : "copies"}`;

export const make = Effect.gen(function* () {
  const probes = yield* Ref.make<ReadonlyArray<Effect.Effect<ReadonlyArray<FolderWorkItem>>>>([]);
  const register = (probe: Effect.Effect<ReadonlyArray<FolderWorkItem>>) =>
    Effect.acquireRelease(
      Ref.update(probes, (all) => [...all, probe]),
      () => Ref.update(probes, (all) => all.filter((each) => each !== probe)),
    );
  const inFlight = Ref.get(probes).pipe(
    Effect.flatMap((all) => Effect.forEach(all, (probe) => probe)),
    Effect.map((lists) => lists.flat()),
  );
  return FolderWorkActivity.of({ register, inFlight });
});

/** A coordinator fenced for a move, as `projection_projects` keeps it. */
export interface FencedCoordinator {
  readonly operationId: string | null;
  readonly updatedAt: string | null;
}

/** The fences that count: tied to a copy in flight here, or written within `MOVE_FENCE_RECENT_MS`. */
export function liveMoves(
  fenced: ReadonlyArray<FencedCoordinator>,
  live: ReadonlySet<string>,
  nowMs: number,
): Array<FolderWorkItem> {
  return fenced.flatMap((fence): Array<FolderWorkItem> => {
    if (fence.operationId === null) return [];
    const fencedAt = Option.map(
      Option.fromNullishOr(fence.updatedAt).pipe(Option.flatMap(DateTime.make)),
      DateTime.toEpochMillis,
    );
    const recent = Option.exists(fencedAt, (atMs) => nowMs - atMs <= MOVE_FENCE_RECENT_MS);
    return live.has(fence.operationId) || recent
      ? [{ operationId: fence.operationId, role: "move", state: "transferring" }]
      : [];
  });
}

/** What the handoff service serves and pulls now; what cannot be read counts as nothing. */
export const handoffProbe = (input: {
  readonly sources: Pick<SourceTransfers, "activeOperations">;
  readonly destinations: Pick<DestinationCopies, "activeOperations">;
  readonly fenced: Effect.Effect<ReadonlyArray<FencedCoordinator>>;
}): Effect.Effect<ReadonlyArray<FolderWorkItem>> =>
  Effect.gen(function* () {
    const sources = input.sources
      .activeOperations(SOURCE_RECENT_MS)
      .map((item): FolderWorkItem => ({ ...item, role: "source" }));
    const destinations = (yield* Effect.tryPromise(() =>
      input.destinations.activeOperations(),
    ).pipe(Effect.orElseSucceed(() => []))).map((item): FolderWorkItem => ({
      ...item,
      role: "destination",
    }));
    const live = new Set([...sources, ...destinations].map((item) => item.operationId));
    const moves = liveMoves(yield* input.fenced, live, yield* Clock.currentTimeMillis);
    return [...sources, ...destinations, ...moves];
  }).pipe(Effect.orElseSucceed(() => []));

/** Coordinators fenced for a move on this machine. */
export const readFencedCoordinators = (sql: SqlClient.SqlClient) =>
  sql<{ readonly operation_id: string | null; readonly updated_at: string | null }>`
    SELECT json_extract(workspace_settings_json, '$.coordinatorBinding.operationId') AS operation_id,
           updated_at
      FROM projection_projects
     WHERE deleted_at IS NULL
       AND json_extract(workspace_settings_json, '$.coordinatorBinding.state') = 'transferring'
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({ operationId: row.operation_id, updatedAt: row.updated_at })),
    ),
    Effect.orElseSucceed((): ReadonlyArray<FencedCoordinator> => []),
  );

/** Registers the handoff service's copies; a no-op where the activity service is absent. */
export const registerHandoff = (input: {
  readonly sources: Pick<SourceTransfers, "activeOperations">;
  readonly destinations: Pick<DestinationCopies, "activeOperations">;
  readonly sql: SqlClient.SqlClient;
}) =>
  Effect.gen(function* () {
    const activity = yield* Effect.serviceOption(FolderWorkActivity);
    if (Option.isNone(activity)) return;
    yield* activity.value.register(
      handoffProbe({ ...input, fenced: readFencedCoordinators(input.sql) }),
    );
  });

/** The heartbeat file's content for `count` operations. */
export const heartbeatOf = (count: number, nowMs: number) => ({
  schemaVersion: 1,
  operations: count,
  at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
  until: DateTime.formatIso(DateTime.makeUnsafe(nowMs + HEARTBEAT_TTL_MS)),
});

/**
 * The operations a heartbeat file's text reports at `nowMs`, as `folder_work.py` reads
 * it: 0 for none, an unreadable file, or one whose `until` passed or lies further ahead
 * than one write lasts.
 */
export function heartbeatOperations(text: string, nowMs: number): number {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return 0;
  }
  if (typeof value !== "object" || value === null) return 0;
  const { schemaVersion, operations, until } = value as Record<string, unknown>;
  if (schemaVersion !== 1 || typeof operations !== "number" || !Number.isInteger(operations))
    return 0;
  const untilMs = Option.match(
    Option.fromNullishOr(typeof until === "string" ? until : null).pipe(
      Option.flatMap(DateTime.make),
    ),
    { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis },
  );
  return operations >= 1 &&
    nowMs < untilMs &&
    untilMs <= nowMs + HEARTBEAT_TTL_MS + HEARTBEAT_SKEW_MS
    ? operations
    : 0;
}

/**
 * Writes the heartbeat while copies run and removes it once none do. It looks every
 * `sampleMs` and writes when the count changes, or again after `everyMs`.
 */
export const keepHeartbeat = (
  activity: FolderWorkActivity["Service"],
  file: string,
  everyMs = HEARTBEAT_EVERY_MS,
  sampleMs = HEARTBEAT_SAMPLE_MS,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const remove = fs.remove(file, { force: true }).pipe(Effect.ignore);
    /** The count last written, and when; 0 once the file is gone. */
    const written = yield* Ref.make({ count: 0, atMs: 0 });
    /** True while writes fail: logged once per run of failures, not every second. */
    const failing = yield* Ref.make(false);
    const write = (count: number, nowMs: number) =>
      Effect.gen(function* () {
        const temporary = `${file}.tmp`;
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(temporary, `${stringifyJson(heartbeatOf(count, nowMs))}\n`, {
          mode: 0o600,
        });
        yield* fs.rename(temporary, file);
        yield* Ref.set(written, { count, atMs: nowMs });
      });
    const beat = Effect.gen(function* () {
      const count = countOperations(yield* activity.inFlight);
      const last = yield* Ref.get(written);
      const nowMs = yield* Clock.currentTimeMillis;
      if (count === 0) {
        if (last.count === 0) return;
        yield* remove;
        return yield* Ref.set(written, { count: 0, atMs: nowMs });
      }
      if (count !== last.count || nowMs - last.atMs >= everyMs) yield* write(count, nowMs);
      yield* Ref.set(failing, false);
    }).pipe(
      // Unwritten, it reads as no copy to the update helper, which may then restart over one.
      Effect.catch((cause) =>
        Effect.flatMap(Ref.getAndSet(failing, true), (already) =>
          already
            ? Effect.void
            : Effect.logWarning("folder copy heartbeat could not be written", {
                file,
                cause: String(cause),
              }),
        ),
      ),
    );
    // A file left by an earlier process says nothing about this one.
    yield* remove;
    yield* Effect.addFinalizer(() => remove);
    yield* beat.pipe(
      Effect.andThen(Effect.sleep(Duration.millis(Math.min(sampleMs, everyMs)))),
      Effect.forever,
      Effect.forkScoped,
    );
  });

export const layer = Layer.effect(
  FolderWorkActivity,
  Effect.gen(function* () {
    const activity = yield* make;
    // Absent in tools and tests that build the runtime alone: no heartbeat then.
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
    const path = yield* Effect.serviceOption(Path.Path);
    if (Option.isSome(config) && Option.isSome(fs) && Option.isSome(path))
      yield* keepHeartbeat(
        activity,
        path.value.join(config.value.baseDir, "updates", HEARTBEAT_FILE),
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fs.value),
        Effect.provideService(Path.Path, path.value),
      );
    return activity;
  }),
);
