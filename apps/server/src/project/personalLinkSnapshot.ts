// @effect-diagnostics nodeBuiltinImport:off -- node:fs reads the backups folder (never the live database).
/**
 * The database copy a machine saves before its personal assistant first
 * links (1448 AC-13), and the memory digest the owner's approval is bound to.
 *
 * @module personalLinkSnapshot
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { sha256 } from "../nodeCrypto.ts";
import {
  checkDatabaseCopy,
  freeBytesAt,
  LiveDatabaseSpaceError,
  removeStalePartials,
} from "../persistence/liveDatabaseSnapshot.ts";
import { snapshotProjectRows } from "../persistence/projectRowsSnapshot.ts";

/** Why this machine could not save its database copy; the join stops before any write. */
export class PersonalLinkSnapshotFailure extends Data.TaggedError("PersonalLinkSnapshotFailure")<{
  readonly message: string;
}> {}

export interface PersonalLinkSnapshotter {
  /**
   * Saves a copy of `projectId`'s rows for `operationId` and returns its path;
   * the same operation reuses its copy.
   */
  readonly snapshot: (
    operationId: string,
    projectId: string,
  ) => Effect.Effect<string, PersonalLinkSnapshotFailure>;
}

/**
 * Without the live layer every snapshot fails, so a join never proceeds
 * without its copy (fail closed).
 */
export class PersonalLinkSnapshot extends Context.Reference<PersonalLinkSnapshotter>(
  "specweave-studio/project/PersonalLinkSnapshot",
  {
    defaultValue: () => ({
      snapshot: () =>
        Effect.fail(
          new PersonalLinkSnapshotFailure({
            message: "This machine cannot save a database copy right now.",
          }),
        ),
    }),
  },
) {}

/**
 * One file name per operation id: a readable prefix plus a hash of the whole
 * id, so two ids that sanitize alike never share a copy.
 */
export const snapshotFileName = (operationId: string) =>
  `${operationId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64) || "operation"}-${sha256(
    [operationId],
    "hex",
  ).slice(0, 16)}.sqlite`;

/**
 * Whether `target` is an earlier complete copy for the same operation: a
 * regular file that is a database passing `quick_check`. Opens only the saved
 * copy, read-only and off the event loop, never the live database.
 */
const existingCopyIsSound = async (target: string): Promise<boolean> => {
  const stat = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isFile()) return false;
  try {
    return (await checkDatabaseCopy(target)).quickCheck === "ok";
  } catch {
    return false;
  }
};

/** A failed copy for one target: how often in a row, the reason, and when the next try may start. */
interface SnapshotFailureRecord {
  readonly failures: number;
  readonly message: string;
  readonly nextAt: number;
  /** Set when the copy failed for free space: the bytes it needed. */
  readonly neededBytes?: number;
}

/**
 * What the copies of one server process share. The layer is provided more
 * than once (`runtimeLayer.ts`), so the default state is per process, keyed by
 * the copy's resolved path: two callers never run two copies into one file.
 */
export interface PersonalLinkSnapshotState {
  readonly done: Map<string, string>;
  readonly running: Map<string, Promise<string>>;
  readonly failed: Map<string, SnapshotFailureRecord>;
}

export const makeSnapshotState = (): PersonalLinkSnapshotState => ({
  done: new Map(),
  running: new Map(),
  failed: new Map(),
});

const processState = makeSnapshotState();

export const SNAPSHOT_RETRY_FIRST_MS = 60_000;
export const SNAPSHOT_RETRY_MAX_MS = 3_600_000;

/** Wait after `failures` failed copies in a row: one minute, doubling, at most an hour. */
export const snapshotRetryDelayMs = (failures: number): number =>
  Math.min(SNAPSHOT_RETRY_MAX_MS, SNAPSHOT_RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1));

const withFullStop = (text: string) =>
  /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;

const inMinutes = (ms: number) => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
};

export interface PersonalLinkSnapshotterDeps {
  /** `<state>/backups/personal-link`. */
  readonly dir: string;
  readonly dbPath: string;
  readonly now?: () => number;
  /** Writes the copy; `snapshotProjectRows` unless a test supplies its own. */
  readonly copy?: (
    dbPath: string,
    target: string,
    projectId: string,
  ) => Promise<{ readonly quickCheck: string }>;
  /** Free bytes in `dir`, read to learn whether space freed since a copy failed for it. */
  readonly freeBytes?: (dir: string) => number;
  readonly state?: PersonalLinkSnapshotState;
}

/**
 * Copies the Percy project's rows of the live database (1505 D-01: never the
 * whole database) into `<state>/backups/personal-link/<operation>.sqlite`,
 * beside the database and outside every project folder. Never opens the live
 * files through `node:fs`.
 *
 * One copy runs at a time in the process: a caller for the same target that
 * comes while it runs waits for it, even when the caller that started it was
 * interrupted (a peer's call that timed out), because the copy itself cannot
 * be stopped; a caller for another target fails at once without a backoff. After a failure
 * the next copy waits `snapshotRetryDelayMs`; until then a call fails at once
 * with the last reason. A copy that failed for space tries again as soon as
 * the space is there.
 */
export const makePersonalLinkSnapshotter = (
  deps: PersonalLinkSnapshotterDeps,
): PersonalLinkSnapshotter => {
  const state = deps.state ?? processState;
  const now = deps.now ?? Date.now;
  const freeBytes = deps.freeBytes ?? freeBytesAt;
  const copy =
    deps.copy ??
    ((dbPath: string, target: string, projectId: string) =>
      snapshotProjectRows(dbPath, target, projectId, { freeBytes }));

  const spaceIsBack = (failure: SnapshotFailureRecord) => {
    if (failure.neededBytes === undefined) return false;
    try {
      return freeBytes(deps.dir) >= failure.neededBytes;
    } catch {
      return false;
    }
  };

  const attempt = async (target: string, projectId: string): Promise<string> => {
    if (NodeFS.existsSync(target)) {
      // A retry of the same operation after a restart: reuse its copy only when it is sound.
      if (!(await existingCopyIsSound(target)))
        throw new PersonalLinkSnapshotFailure({
          message: `An unusable file is in the way of the database copy at ${target}.`,
        });
      return target;
    }
    // No copy into `target` runs now, so partials beside it are leftovers of a stopped process.
    removeStalePartials(target);
    const written = await copy(deps.dbPath, target, projectId);
    if (written.quickCheck !== "ok")
      throw new PersonalLinkSnapshotFailure({
        message: `The copy failed its check (${written.quickCheck}).`,
      });
    return target;
  };

  const start = (target: string, projectId: string): Promise<string> => {
    const known = state.done.get(target);
    if (known !== undefined) return Promise.resolve(known);
    const running = state.running.get(target);
    if (running !== undefined) return running;
    const failure = state.failed.get(target);
    if (failure !== undefined && now() < failure.nextAt && !spaceIsBack(failure))
      return Promise.reject(
        new PersonalLinkSnapshotFailure({
          message: `${withFullStop(failure.message)} It tries again in ${inMinutes(failure.nextAt - now())}.`,
        }),
      );
    // One database copy at a time in this process, whatever its target: a join series that
    // began again (the switch turned off and on) must not start a second multi-gigabyte copy
    // beside one a timed-out call left running. Not a failure of this target: no backoff.
    if (state.running.size > 0)
      return Promise.reject(
        new PersonalLinkSnapshotFailure({
          message:
            "Another copy of the database is still being saved; it tries again once that copy ends.",
        }),
      );
    const run = attempt(target, projectId);
    state.running.set(target, run);
    // Settles the shared state even when every caller was interrupted, and handles the rejection.
    run.then(
      (path) => {
        state.running.delete(target);
        state.failed.delete(target);
        state.done.set(target, path);
      },
      (error: unknown) => {
        state.running.delete(target);
        const failures = (state.failed.get(target)?.failures ?? 0) + 1;
        state.failed.set(target, {
          failures,
          message: error instanceof Error ? error.message : String(error),
          nextAt: now() + snapshotRetryDelayMs(failures),
          ...(error instanceof LiveDatabaseSpaceError ? { neededBytes: error.needed } : {}),
        });
      },
    );
    return run;
  };

  return {
    snapshot: (operationId: string, projectId: string) =>
      Effect.tryPromise({
        try: () => start(NodePath.resolve(deps.dir, snapshotFileName(operationId)), projectId),
        catch: (error) =>
          error instanceof PersonalLinkSnapshotFailure
            ? error
            : new PersonalLinkSnapshotFailure({
                message: error instanceof Error ? error.message : String(error),
              }),
      }),
  };
};

export const layerLive = Layer.effect(
  PersonalLinkSnapshot,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return makePersonalLinkSnapshotter({
      dir: NodePath.join(config.stateDir, "backups", "personal-link"),
      dbPath: config.dbPath,
    });
  }),
);

interface HashedFile {
  readonly name: string;
  readonly sha256: string;
}

/** One digest of a seat's whole memory: names and content hashes, in name order. */
export const personalMemoryDigest = (files: ReadonlyArray<HashedFile>) =>
  sha256(files.map((file) => `${file.name}\u0000${file.sha256}\n`).toSorted(), "hex");

/**
 * The digest the memory had before `renames`, read from memory where they
 * already happened: lets a retried join match the owner's approval.
 */
export const memoryDigestBeforeRenames = (
  files: ReadonlyArray<HashedFile>,
  renames: ReadonlyArray<{ readonly from: string; readonly to: string }>,
) => {
  const back = new Map(renames.map((rename) => [rename.to, rename.from]));
  const present = new Map(files.map((file) => [file.name, file.sha256]));
  return personalMemoryDigest(
    files
      // A rename that stopped halfway left the same content under both names: count it once.
      .filter((file) => {
        const from = back.get(file.name);
        return from === undefined || present.get(from) !== file.sha256;
      })
      .map((file) => ({ name: back.get(file.name) ?? file.name, sha256: file.sha256 })),
  );
};
