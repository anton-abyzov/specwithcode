/**
 * Away intents an earlier release recorded here (1267 AC-09; 1390 AC-36).
 *
 * A machine going to sleep starts nothing, so no intent is recorded any more:
 * `AWAY_INTENT_PATH` answers a definite refusal. What is left is the drain of
 * intents this machine recorded before it updated, by the state each is in:
 *
 * - waiting: cancelled. Its grace is not waited out, and nothing is taken over.
 * - done: the takeover it made stands. A cancel that comes after is refused
 *   with what was taken over, and the source gives way.
 * - acting: unknown, the process stopped mid-takeover. It is settled from what
 *   the project bindings and handoff mode show: done when a project was taken
 *   over or one of its threads continued here, cancelled only when provably
 *   nothing was. While any of that cannot be read, or a thread's launch is in
 *   doubt, it stays acting and is checked again. Nothing new is started.
 *
 * `AWAY_INTENT_STATUS_PATH` answers, per project, whether this machine took it
 * over, so a source that never got the first answer still learns the outcome.
 *
 * Kept as a JSON file in the state directory, so an intent survives a restart.
 * A file that is there but does not read as intents is an error, never "no
 * intents": a source reads "no intent" as "nothing moved".
 */
import {
  AwayError,
  type AwayHandoverResult,
  type AwayIntentCancelAnswer,
  type AwayIntentProjectStatus,
  AwayIntentRecord,
  type AwayIntentState,
  type EnvironmentId,
  type Project,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { RemoteWorkerAdoption } from "../fleet/RemoteWorkerAdoption.ts";
import { HandoffReceiver } from "../handoff/HandoffReceiver.ts";
import type { ContinuationEvidence } from "../handoff/handoffState.ts";
import { parseJson, stringifyJson } from "../json.ts";
import { claimTargets } from "../project/CoordinatorPlannedHandover.ts";
import { CoordinatorStandbyStore } from "../project/CoordinatorStandbyStore.ts";
import { STANDBY_TICK_MS } from "../project/CoordinatorStandbyWatch.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";

const FILE_NAME = "away-intents.json";
/** Settled intents kept for the summary; older ones are dropped, except each source's receipts. */
const KEEP_SETTLED = 50;
/** Why a waiting intent ends: sleep no longer starts a move (1390 AC-36). */
export const SLEEP_START_RETIRED = "sleep-start-retired";

const StoreFile = Schema.Struct({
  version: Schema.Literal(1),
  intents: Schema.Array(AwayIntentRecord),
});
type StoreFile = typeof StoreFile.Type;
const EMPTY: StoreFile = { version: 1, intents: [] };
const decodeStore = Schema.decodeUnknownOption(StoreFile);
const encodeStore = Schema.encodeSync(StoreFile);

/** Where intents are kept; the live one is a file, tests use memory. */
export interface AwayIntentStore {
  readonly read: Effect.Effect<StoreFile, AwayError>;
  readonly write: (next: StoreFile) => Effect.Effect<void, AwayError>;
}

export const memoryIntentStore = (
  initial: StoreFile = EMPTY,
): AwayIntentStore & {
  readonly current: () => StoreFile;
} => {
  let held = initial;
  return {
    read: Effect.sync(() => held),
    write: (next) => Effect.sync(() => void (held = next)),
    current: () => held,
  };
};

export interface AwayIntentsDeps {
  readonly store: AwayIntentStore;
  /**
   * What an intent left `acting` really took over, one result per project, from
   * the bindings here. It starts no takeover; it may finish adopting the workers
   * of a project already taken over. Fails when the bindings cannot be read.
   */
  readonly settleActed: (
    intent: AwayIntentRecord,
  ) => Effect.Effect<ReadonlyArray<AwayHandoverResult>, AwayError>;
  /**
   * Whether the source's thread was continued here (handoff mode's receiver).
   * Never launches; `unresolved` when it cannot tell.
   */
  readonly continuation: (
    sourceEnvironmentId: EnvironmentId,
    sourceThreadId: string,
  ) => Effect.Effect<ContinuationEvidence>;
}

export interface AwayIntentsShape {
  /**
   * The source is back: its waiting intents are cancelled. When its latest
   * intent is already acting or done nothing is cancelled, and the answer
   * names the state and the projects taken over, so the source gives way.
   */
  readonly cancel: (
    sourceEnvironmentId: EnvironmentId,
    reason: string,
  ) => Effect.Effect<AwayIntentCancelAnswer, AwayError>;
  /** The state of the source's latest intent here, or null without one. */
  readonly latestState: (
    sourceEnvironmentId: EnvironmentId,
  ) => Effect.Effect<AwayIntentState | null, AwayError>;
  readonly list: Effect.Effect<ReadonlyArray<AwayIntentRecord>, AwayError>;
  /**
   * Drains what an earlier release left: cancels every waiting intent and
   * settles every acting one whose outcome reads. Returns the ones it settled.
   * An unreadable store settles nothing; an acting intent whose bindings or
   * threads do not read stays acting for the next tick.
   */
  readonly tick: Effect.Effect<ReadonlyArray<AwayIntentRecord>>;
}

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const makeAwayIntents = (deps: AwayIntentsDeps) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const modify = <A>(change: (current: StoreFile) => readonly [A, StoreFile | undefined]) =>
      lock.withPermit(
        Effect.gen(function* () {
          const [result, next] = change(yield* deps.store.read);
          if (next !== undefined) yield* deps.store.write(trim(next));
          return result;
        }),
      );

    const cancel: AwayIntentsShape["cancel"] = (sourceEnvironmentId, reason) =>
      Effect.gen(function* () {
        const at = isoAt(yield* Clock.currentTimeMillis);
        return yield* modify(
          (current): readonly [AwayIntentCancelAnswer, StoreFile | undefined] => {
            const latest = latestOf(current, sourceEnvironmentId);
            // Too late: the target is taking over or took over. The source must give way.
            if (latest?.state === "acting" || latest?.state === "done")
              return [
                {
                  cancelled: 0,
                  state: latest.state,
                  takenOver: takenOverBy(latest),
                },
                undefined,
              ];
            // An earlier delivery from this source acted while a later one still waits. A
            // source on an earlier release reads a count as "nothing moved" and runs its
            // work again, so it hears what was taken and settles through status instead.
            const acted = current.intents.findLast(
              (held) =>
                held.sourceEnvironmentId === sourceEnvironmentId &&
                (held.state === "acting" || held.state === "done"),
            );
            let cancelled = 0;
            const intents = current.intents.map((held) => {
              if (held.state !== "waiting" || held.sourceEnvironmentId !== sourceEnvironmentId)
                return held;
              cancelled += 1;
              return {
                ...held,
                state: "cancelled" as const,
                cancelledAt: at,
                cancelReason: reason.slice(0, 200),
              };
            });
            return [
              acted === undefined
                ? {
                    cancelled,
                    state: cancelled > 0 ? "cancelled" : (latest?.state ?? null),
                    takenOver: [],
                  }
                : { cancelled: 0, state: acted.state, takenOver: takenOverBy(acted) },
              cancelled === 0 ? undefined : { ...current, intents },
            ];
          },
        );
      });

    const settle = (
      intentId: string,
      from: AwayIntentState,
      change: (held: AwayIntentRecord) => AwayIntentRecord,
    ) =>
      modify((current) => {
        let settled: AwayIntentRecord | undefined;
        const intents = current.intents.map((held) => {
          if (held.intentId !== intentId || held.state !== from) return held;
          settled = change(held);
          return settled;
        });
        return [settled, settled === undefined ? undefined : { ...current, intents }];
      });

    const tick: AwayIntentsShape["tick"] = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const open = (yield* deps.store.read).intents.filter(
        (intent) => intent.state === "acting" || intent.state === "waiting",
      );
      const settled: AwayIntentRecord[] = [];
      for (const intent of open) {
        if (intent.state === "waiting") {
          // Under the lock, so a cancel from the source either came first or finds it cancelled.
          const cancelled = yield* settle(intent.intentId, "waiting", (held) => ({
            ...held,
            state: "cancelled",
            cancelledAt: isoAt(nowMs),
            cancelReason: SLEEP_START_RETIRED,
          }));
          if (cancelled !== undefined) settled.push(cancelled);
          continue;
        }
        // Left acting by a restart: it may have taken projects over or continued its
        // threads. With either it ends as done, and the source gives way. With provably
        // neither it ends as cancelled: a source reads "done" as "work moved" and would
        // bring back work that never left. Anything unreadable or in doubt writes nothing.
        const acted = yield* deps.settleActed(intent).pipe(Effect.result);
        if (acted._tag === "Failure") {
          yield* Effect.logWarning("Away: an acting intent stays acting; bindings did not read", {
            intentId: intent.intentId,
            cause: acted.failure.message,
          });
          continue;
        }
        const results = acted.success;
        const threads = yield* Effect.forEach(intent.threadIds, (threadId) =>
          deps.continuation(intent.sourceEnvironmentId, threadId),
        );
        if (threads.some((evidence) => evidence.kind === "unresolved")) {
          yield* Effect.logInfo("Away: an acting intent stays acting; a launch is in doubt", {
            intentId: intent.intentId,
          });
          continue;
        }
        const took =
          results.some((result) => result.outcome === "handed-over") ||
          threads.some((evidence) => evidence.kind === "continued");
        const ended = yield* settle(intent.intentId, "acting", (held) =>
          took
            ? {
                ...held,
                state: "done",
                actedAt: held.actedAt ?? isoAt(nowMs),
                results: [...results],
              }
            : {
                ...held,
                state: "cancelled",
                cancelledAt: isoAt(nowMs),
                cancelReason: SLEEP_START_RETIRED,
                results: [...results],
              },
        );
        if (ended !== undefined) settled.push(ended);
      }
      return settled;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Away intents could not be checked", { cause }).pipe(Effect.as([])),
      ),
    );

    return {
      cancel,
      latestState: (sourceEnvironmentId) =>
        deps.store.read.pipe(
          Effect.map((file) => latestOf(file, sourceEnvironmentId)?.state ?? null),
        ),
      list: deps.store.read.pipe(Effect.map((file) => file.intents)),
      tick,
    } satisfies AwayIntentsShape;
  });

/** The source's newest intent here. */
function latestOf(file: StoreFile, sourceEnvironmentId: string): AwayIntentRecord | undefined {
  return file.intents.findLast((intent) => intent.sourceEnvironmentId === sourceEnvironmentId);
}

/** The source projects an intent took over. */
function takenOverBy(intent: AwayIntentRecord): ProjectId[] {
  return (intent.results ?? [])
    .filter((result) => result.outcome === "handed-over")
    .map((result) => result.projectId);
}

/**
 * Whether this machine's copy took the source's project over: it coordinates
 * with the source's copy as its predecessor. The binding and this copy's
 * member travel, so the source can verify and give way.
 */
export function projectStatus(
  projects: ReadonlyArray<Project>,
  selfEnvironmentId: string,
  sourceEnvironmentId: string,
  sourceProjectId: ProjectId,
): AwayIntentProjectStatus {
  const copy = linkedCopyOf(projects, sourceEnvironmentId, sourceProjectId);
  const binding = copy?.workspaceSettings?.coordinatorBinding;
  const self = copy?.workspaceSettings?.logicalProject?.members.find(
    (member) => member.environmentId === selfEnvironmentId && member.projectId === copy.id,
  );
  if (
    copy === undefined ||
    binding === undefined ||
    self === undefined ||
    binding.state !== "active" ||
    binding.predecessor?.environmentId !== sourceEnvironmentId ||
    binding.predecessor.projectId !== sourceProjectId
  )
    return { projectId: sourceProjectId, takenOver: false };
  const { standby: _standby, ...coordinatorBinding } = binding;
  return {
    projectId: sourceProjectId,
    takenOver: true,
    epoch: binding.epoch,
    coordinatorBinding,
    successor: self,
  };
}

/**
 * What an intent really took over, read from this machine's project bindings:
 * `handed-over` where its copy coordinates with the source's copy as its
 * predecessor, `skipped` where it does not.
 */
export function actedResults(
  projects: ReadonlyArray<Project>,
  selfEnvironmentId: string,
  intent: Pick<AwayIntentRecord, "sourceEnvironmentId" | "projectIds">,
): Array<AwayHandoverResult> {
  return intent.projectIds.map((projectId) => {
    const status = projectStatus(
      projects,
      selfEnvironmentId,
      intent.sourceEnvironmentId,
      projectId,
    );
    return status.takenOver
      ? {
          projectId,
          outcome: "handed-over" as const,
          detail: "This machine coordinates the project now.",
          ...(status.epoch === undefined ? {} : { epoch: status.epoch }),
        }
      : {
          projectId,
          outcome: "skipped" as const,
          detail: "Not taken over: a machine going to sleep no longer hands work off.",
        };
  });
}

/**
 * The intents no compaction drops: each source's latest, which cancel and
 * status answer about, and its latest done one, the receipt that its work
 * moved here. One is retired only once a later one of the same kind from the
 * same source is recorded, which only an earlier release does, so other
 * sources' intents never push them out.
 */
function receiptsOf(intents: ReadonlyArray<AwayIntentRecord>): ReadonlySet<string> {
  const latest = new Map<string, string>();
  const done = new Map<string, string>();
  for (const intent of intents) {
    latest.set(intent.sourceEnvironmentId, intent.intentId);
    if (intent.state === "done") done.set(intent.sourceEnvironmentId, intent.intentId);
  }
  return new Set([...latest.values(), ...done.values()]);
}

/** Keeps every open intent, every source's receipts and the newest other settled ones. */
function trim(file: StoreFile): StoreFile {
  const settled = file.intents.filter(
    (intent) => intent.state !== "waiting" && intent.state !== "acting",
  );
  if (settled.length <= KEEP_SETTLED) return file;
  const kept = receiptsOf(file.intents);
  const drop = new Set(
    settled
      .filter((intent) => !kept.has(intent.intentId))
      .slice(0, settled.length - KEEP_SETTLED)
      .map((intent) => intent.intentId),
  );
  return { ...file, intents: file.intents.filter((intent) => !drop.has(intent.intentId)) };
}

/** This machine's copy linked to the source's `sourceProjectId`, if any. */
export function linkedCopyOf(
  projects: ReadonlyArray<Project>,
  sourceEnvironmentId: string,
  sourceProjectId: string,
): Project | undefined {
  return projects.find(
    (project) =>
      project.deletedAt === null &&
      (project.workspaceSettings?.logicalProject?.members ?? []).some(
        (member) =>
          member.environmentId === sourceEnvironmentId && member.projectId === sourceProjectId,
      ),
  );
}

// --- the service ---------------------------------------------------------------

export class AwayIntents extends Context.Service<AwayIntents, AwayIntentsShape>()(
  "specweave-studio/away/AwayIntents",
) {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const projects = yield* ProjectService.ProjectService;
  const standby = yield* CoordinatorStandbyStore;
  const adoption = yield* RemoteWorkerAdoption;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const selfEnvironmentId = yield* environment.getEnvironmentId;
  const file = path.join(config.stateDir, FILE_NAME);
  const failed = (message: string) => new AwayError({ code: "failed", message });

  const store: AwayIntentStore = {
    read: Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return EMPTY;
      const text = yield* fs.readFileString(file);
      let raw: unknown = null;
      try {
        raw = parseJson(text);
      } catch {
        raw = null;
      }
      const decoded = decodeStore(raw);
      // Unreadable is not empty: "no intent" would tell a source that nothing moved.
      if (Option.isNone(decoded)) return yield* failed("The away intents here do not read.");
      return decoded.value;
    }).pipe(Effect.mapError(() => failed("Could not read the away intents on this machine."))),
    write: (next) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(config.stateDir, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${yield* crypto.randomUUIDv4}.tmp`;
        yield* fs.writeFileString(temporary, stringifyJson(encodeStore(next)), { mode: 0o600 });
        yield* fs.rename(temporary, file);
      }).pipe(Effect.mapError(() => failed("Could not save the away intents on this machine."))),
  };

  // The receiver that records incoming threads: the one handoff moves take over with,
  // so a thread's outcome is read under its takeover's lock.
  const receiver = yield* HandoffReceiver;
  const core = yield* makeAwayIntents({
    store,
    continuation: receiver.continuation,
    settleActed: (intent) =>
      Effect.gen(function* () {
        const snapshot = yield* projects.snapshot.pipe(
          Effect.map((value) => value.projects),
          Effect.mapError(() => failed("Could not read the projects on this machine.")),
        );
        const results = actedResults(snapshot, selfEnvironmentId, intent);
        // The takeover and the adoption of the source's workers were two steps. For a
        // project already taken over the adoption is repeated: it replays by its
        // operation ids, so one that finished changes nothing.
        for (const result of results) {
          if (result.outcome !== "handed-over") continue;
          const copy = linkedCopyOf(snapshot, intent.sourceEnvironmentId, result.projectId);
          const binding = copy?.workspaceSettings?.coordinatorBinding;
          const logicalProject = copy?.workspaceSettings?.logicalProject;
          const self = logicalProject?.members.find(
            (member) => member.environmentId === selfEnvironmentId && member.projectId === copy?.id,
          );
          const predecessor = binding?.predecessor;
          if (
            copy === undefined ||
            binding === undefined ||
            logicalProject === undefined ||
            self === undefined ||
            predecessor === undefined
          )
            continue;
          // Unread, the source's workers would be adopted as none: settled on a later tick.
          const record = yield* standby
            .get(logicalProject.id)
            .pipe(Effect.mapError(() => failed("Could not read the standby records here.")));
          const shadowWorkers =
            record !== undefined && record.coordinator.environmentId === intent.sourceEnvironmentId
              ? record.shadowWorkers
              : [];
          yield* adoption
            .adopt({
              logicalProjectId: logicalProject.id,
              epoch: binding.epoch,
              projectId: copy.id,
              coordinatorThreadId: self.coordinatorThreadId,
              predecessor,
              shadowWorkers,
              claimOn: claimTargets(
                shadowWorkers,
                logicalProject.members,
                selfEnvironmentId,
                intent.sourceEnvironmentId,
              ),
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Away: could not finish adopting a taken project's workers", {
                  projectId: copy.id,
                  cause,
                }),
              ),
            );
        }
        return results;
      }),
  });

  return AwayIntents.of(core);
});

export const layer = Layer.effect(AwayIntents, make);

/** Checks the intents every 30 seconds, parked until the server is activated. */
export const layerLoop = Layer.effectDiscard(
  Effect.gen(function* () {
    const intents = yield* AwayIntents;
    yield* forkParked(
      intents.tick.pipe(
        Effect.repeat(Schedule.spaced(Duration.millis(STANDBY_TICK_MS))),
        Effect.asVoid,
      ),
    );
  }),
);
