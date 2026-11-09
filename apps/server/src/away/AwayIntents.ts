/**
 * Away intents (1267 AC-09, the target's half). Within the five seconds a
 * Mac gives before it sleeps, the source records here that it is going away:
 * which of its projects' coordinators this machine should take over, and
 * which of its threads were replicated here to continue. The intent waits out
 * its grace on this machine's clock. It is cancelled when the source asks
 * (`AWAY_INTENT_CANCEL_PATH`), when it is heard awake (a lease that is not
 * its going-to-sleep lease, after the intent), or when it answers at the
 * moment the grace runs out. Otherwise it turns `acting` under the lock, from
 * when no cancel can stop it, and this machine takes over each project like
 * an armed standby (`ProjectLink.awayTakeover`), claims the epoch and adopts
 * the source's workers, then hands the intent to whoever registered
 * `onIntentDue` (the Away runner continues the replicated threads). A cancel
 * that comes too late is refused with what was taken over, and the source
 * gives way; `AWAY_INTENT_STATUS_PATH` answers the same for each project.
 *
 * Kept as a JSON file in the state directory, like the standby records, so
 * an intent survives a restart of this machine.
 */
import {
  AWAY_INTENT_CANCEL_PATH,
  AWAY_INTENT_PATH,
  AwayError,
  type AwayHandoverResult,
  type AwayIntentCancelAnswer,
  type AwayIntentProjectStatus,
  AwayIntentRecord,
  type AwayIntentRequest,
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
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { RemoteWorkerAdoption } from "../fleet/RemoteWorkerAdoption.ts";
import { HandoffPeers } from "../handoff/handoffPeers.ts";
import { parseJson, stringifyJson } from "../json.ts";
import { claimTargets } from "../project/CoordinatorPlannedHandover.ts";
import { CoordinatorStandbyStore } from "../project/CoordinatorStandbyStore.ts";
import { heardAwakeSince, STANDBY_TICK_MS } from "../project/CoordinatorStandbyWatch.ts";
import { ProjectLink } from "../project/ProjectLink.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import { type AwayPeerPost, makeAwayPeerPost } from "./awayPeerCall.ts";

const FILE_NAME = "away-intents.json";
/** Settled intents kept for the summary; older ones are dropped. */
const KEEP_SETTLED = 50;
const SEND_TIMEOUT_MS = 4_000;

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
  readonly newId: Effect.Effect<string>;
  /** Whether the source was heard awake since the intent arrived, or answers now. */
  readonly heardAwake: (intent: AwayIntentRecord) => Effect.Effect<boolean>;
  /** Takes over each of the source's projects; one result per project, never fails. */
  readonly act: (intent: AwayIntentRecord) => Effect.Effect<ReadonlyArray<AwayHandoverResult>>;
}

export interface AwayIntentsShape {
  /** Records the source's intent; it replaces one still waiting from the same source. */
  readonly record: (
    sourceEnvironmentId: EnvironmentId,
    request: Omit<AwayIntentRequest, "sourceEnvironmentId">,
  ) => Effect.Effect<AwayIntentRecord, AwayError>;
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
  /** Acts on every intent whose grace ran out; returns the ones it settled. */
  readonly tick: Effect.Effect<ReadonlyArray<AwayIntentRecord>>;
  /**
   * Runs `handler` with each intent this machine acted on, after its
   * takeovers. The Away runner continues the replicated threads here.
   */
  readonly onIntentDue: (
    handler: (intent: AwayIntentRecord) => Effect.Effect<void>,
  ) => Effect.Effect<void>;
  /** Every intent this machine acted on, as it acts. */
  readonly due: Stream.Stream<AwayIntentRecord>;
}

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

export const makeAwayIntents = (deps: AwayIntentsDeps) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const published = yield* PubSub.unbounded<AwayIntentRecord>();
    const handlers: Array<(intent: AwayIntentRecord) => Effect.Effect<void>> = [];

    const modify = <A>(change: (current: StoreFile) => readonly [A, StoreFile | undefined]) =>
      lock.withPermit(
        Effect.gen(function* () {
          const [result, next] = change(yield* deps.store.read);
          if (next !== undefined) yield* deps.store.write(trim(next));
          return result;
        }),
      );

    const record: AwayIntentsShape["record"] = (sourceEnvironmentId, request) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const intentId = yield* deps.newId;
        const intent: AwayIntentRecord = {
          intentId,
          sourceEnvironmentId,
          graceMinutes: request.graceMinutes,
          projectIds: [...request.projectIds],
          threadIds: [...request.threadIds],
          receivedAt: isoAt(nowMs),
          dueAt: isoAt(nowMs + request.graceMinutes * 60_000),
          state: "waiting",
        };
        return yield* modify((current) => [
          intent,
          {
            ...current,
            intents: [
              ...current.intents.map((held) =>
                held.state === "waiting" && held.sourceEnvironmentId === sourceEnvironmentId
                  ? {
                      ...held,
                      state: "cancelled" as const,
                      cancelledAt: intent.receivedAt,
                      cancelReason: "replaced",
                    }
                  : held,
              ),
              intent,
            ],
          },
        ]);
      });

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
              {
                cancelled,
                state: cancelled > 0 ? "cancelled" : (latest?.state ?? null),
                takenOver: [],
              },
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
      // An intent left acting by a restart is finished first; it can no longer be cancelled.
      const due = (yield* deps.store.read).intents.filter(
        (intent) =>
          intent.state === "acting" ||
          (intent.state === "waiting" && Date.parse(intent.dueAt) <= nowMs),
      );
      const settled: AwayIntentRecord[] = [];
      for (const intent of due) {
        let acting: AwayIntentRecord | undefined = intent.state === "acting" ? intent : undefined;
        if (acting === undefined) {
          if (yield* deps.heardAwake(intent)) {
            const cancelled = yield* settle(intent.intentId, "waiting", (held) => ({
              ...held,
              state: "cancelled",
              cancelledAt: isoAt(nowMs),
              cancelReason: "heard-awake",
            }));
            if (cancelled !== undefined) settled.push(cancelled);
            continue;
          }
          // Under the lock, so a cancel either came first (nothing happens) or is refused.
          acting = yield* settle(intent.intentId, "waiting", (held) => ({
            ...held,
            state: "acting",
            actedAt: isoAt(nowMs),
          }));
          if (acting === undefined) continue;
        }
        // Takeovers replay by their operation ids, so a restart before the
        // intent is marked done only repeats them.
        const results = yield* deps.act(acting);
        const done =
          (yield* settle(intent.intentId, "acting", (held) => ({
            ...held,
            state: "done",
            actedAt: held.actedAt ?? isoAt(nowMs),
            results: [...results],
          }))) ??
          // Nothing else moves an acting intent; if the write was lost, the hooks still run.
          ({ ...acting, state: "done", results: [...results] } satisfies AwayIntentRecord);
        settled.push(done);
        yield* PubSub.publish(published, done);
        for (const handler of handlers)
          yield* handler(done).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("An away intent hook failed", { intentId: done.intentId, cause }),
            ),
          );
      }
      return settled;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Away intents could not be checked", { cause }).pipe(Effect.as([])),
      ),
    );

    return {
      record,
      cancel,
      latestState: (sourceEnvironmentId) =>
        deps.store.read.pipe(
          Effect.map((file) => latestOf(file, sourceEnvironmentId)?.state ?? null),
        ),
      list: deps.store.read.pipe(Effect.map((file) => file.intents)),
      tick,
      onIntentDue: (handler) => Effect.sync(() => void handlers.push(handler)),
      due: Stream.fromPubSub(published),
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

/** Keeps every open intent and the newest settled ones. */
function trim(file: StoreFile): StoreFile {
  const settled = file.intents.filter(
    (intent) => intent.state !== "waiting" && intent.state !== "acting",
  );
  if (settled.length <= KEEP_SETTLED) return file;
  const drop = new Set(settled.slice(0, settled.length - KEEP_SETTLED).map((i) => i.intentId));
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

export class AwayIntents extends Context.Service<
  AwayIntents,
  AwayIntentsShape & {
    /** On the source: records the intent on the target before this machine sleeps. */
    readonly send: (
      targetEnvironmentId: EnvironmentId,
      request: AwayIntentRequest,
    ) => Effect.Effect<void, AwayError>;
    /** On the source, back: cancels the intent it left on the target. */
    readonly sendCancel: (
      targetEnvironmentId: EnvironmentId,
      sourceEnvironmentId: EnvironmentId,
    ) => Effect.Effect<void, AwayError>;
  }
>()("specweave-studio/away/AwayIntents") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const link = yield* ProjectLink;
  const projects = yield* ProjectService.ProjectService;
  const standby = yield* CoordinatorStandbyStore;
  const peers = yield* HandoffPeers;
  const adoption = yield* RemoteWorkerAdoption;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const selfEnvironmentId = yield* environment.getEnvironmentId;
  const post: AwayPeerPost = yield* makeAwayPeerPost;
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
      return Option.getOrElse(decodeStore(raw), () => EMPTY);
    }).pipe(Effect.mapError(() => failed("Could not read the away intents on this machine."))),
    write: (next) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(config.stateDir, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${yield* crypto.randomUUIDv4}.tmp`;
        yield* fs.writeFileString(temporary, stringifyJson(encodeStore(next)), { mode: 0o600 });
        yield* fs.rename(temporary, file);
      }).pipe(Effect.mapError(() => failed("Could not save the away intents on this machine."))),
  };

  const core = yield* makeAwayIntents({
    store,
    newId: crypto.randomUUIDv4.pipe(Effect.orDie),
    heardAwake: (intent) =>
      Effect.gen(function* () {
        const receivedMs = Date.parse(intent.receivedAt);
        const records = yield* standby.list.pipe(Effect.orElseSucceed(() => []));
        if (
          records.some(
            (record) =>
              record.coordinator.environmentId === intent.sourceEnvironmentId &&
              heardAwakeSince(record, receivedMs),
          )
        )
          return true;
        // Answering now means it is awake and still coordinating: taking over would make two.
        return yield* peers.reachable(intent.sourceEnvironmentId);
      }),
    act: (intent) =>
      Effect.gen(function* () {
        const snapshot = yield* projects.snapshot.pipe(
          Effect.map((value) => value.projects),
          Effect.orElseSucceed(() => []),
        );
        const results: AwayHandoverResult[] = [];
        for (const sourceProjectId of intent.projectIds) {
          const result = (
            outcome: AwayHandoverResult["outcome"],
            detail: string,
            epoch?: number,
          ): AwayHandoverResult => ({
            projectId: sourceProjectId,
            outcome,
            detail: detail.slice(0, 500),
            ...(epoch === undefined ? {} : { epoch }),
          });
          const copy = linkedCopyOf(snapshot, intent.sourceEnvironmentId, sourceProjectId);
          if (copy === undefined) {
            results.push(result("failed", "This project has no linked copy on this machine."));
            continue;
          }
          const taken = yield* link
            .awayTakeover({ projectId: copy.id, sourceEnvironmentId: intent.sourceEnvironmentId })
            .pipe(Effect.result);
          if (taken._tag === "Failure") {
            results.push(
              result(
                taken.failure.code === "superseded_conflict" ? "skipped" : "failed",
                taken.failure.detail ?? `Not taken over (${taken.failure.code}).`,
              ),
            );
            continue;
          }
          const { coordinatorBinding, logicalProject } = taken.success;
          const self = logicalProject.members.find(
            (member) => member.environmentId === selfEnvironmentId && member.projectId === copy.id,
          );
          const predecessor = coordinatorBinding.predecessor;
          const record = yield* standby
            .get(logicalProject.id)
            .pipe(Effect.orElseSucceed(() => undefined));
          const shadowWorkers =
            record !== undefined && record.coordinator.environmentId === intent.sourceEnvironmentId
              ? record.shadowWorkers
              : [];
          if (self !== undefined && predecessor !== undefined)
            yield* adoption.adopt({
              logicalProjectId: logicalProject.id,
              epoch: coordinatorBinding.epoch,
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
            });
          results.push(
            result(
              "handed-over",
              "This machine coordinates the project now.",
              coordinatorBinding.epoch,
            ),
          );
        }
        return results;
      }),
  });

  const send = (targetEnvironmentId: EnvironmentId, path: string, body: unknown) =>
    post(targetEnvironmentId, path, body, SEND_TIMEOUT_MS).pipe(
      Effect.asVoid,
      Effect.mapError(
        (error) =>
          new AwayError({
            code: error.uncertain ? "unreachable" : "failed",
            message: error.message,
          }),
      ),
    );

  return AwayIntents.of({
    ...core,
    send: (targetEnvironmentId, request) => send(targetEnvironmentId, AWAY_INTENT_PATH, request),
    sendCancel: (targetEnvironmentId, sourceEnvironmentId) =>
      send(targetEnvironmentId, AWAY_INTENT_CANCEL_PATH, { sourceEnvironmentId }),
  });
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
