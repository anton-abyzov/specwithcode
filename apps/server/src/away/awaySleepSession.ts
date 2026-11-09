/**
 * A lid-close Away as a normal Away session (1267 AC-09, D-02). The sleep
 * trigger (`awaySleepRoute`) keeps its state in the same `AwaySession` the
 * Leave button writes to `handoff-mode.json`, with `trigger: "sleep"`, stage
 * `pending-intent` and the intent in `sleep`, so the summary, the wake card,
 * Bring back and "Bring back automatically on power" all read one record that
 * survives a restart and a wake with no window open.
 *
 * At sleep (inside the five-second window, local only) the routines the
 * target would otherwise run too are turned off here with a note and listed:
 * worker routines of threads in the intent, and the coordinator's own
 * routines of projects in the intent. Threads left out because handoff mode
 * is off for them are listed as staying, with why.
 *
 * On wake: back before the target acted, everything stays and the routines
 * turn on again. After it, coordinators read what the target took over and
 * threads read the continuation the handoff heartbeat recorded (which also
 * fences the copy here); the session then waits for Bring back. The
 * coordinator routines of a project the target did not take turn on here at
 * once. Each outcome is one write of the session together with its `sleep`
 * record, retried when it fails, so a session never stays `pending-intent`.
 */
import {
  AWAY_SESSION_MAX_ITEMS,
  type AwayCoordinatorScope,
  type AwayItemResult,
  AwaySession,
  type AwaySleepSession,
  type EnvironmentId,
  isProjectCoordinatorThreadId,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ScheduledTask,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as FleetTargets from "../fleet/FleetTargets.ts";
import { HandoffMode } from "../handoff/HandoffMode.ts";
import { effectiveHandoffMode, type HandoffDocument } from "../handoff/handoffState.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { coordinatorRoleOf } from "../project/CoordinatorRole.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { awayPausedNote, makePauseHere } from "../scheduledTasks/ScheduledTaskTransfer.ts";
import { isAwayCandidate } from "./AwayPlanner.ts";

const decodeSession = Schema.decodeUnknownOption(AwaySession);
const clip = (text: string, max = 500) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** The saved session, or null when there is none or another version wrote it. */
export const readAwaySession = (raw: unknown): AwaySession | null =>
  raw == null ? null : Option.getOrNull(decodeSession(raw));

/** A lid-close session whose wake has not been handled yet. */
export const isPendingSleep = (session: AwaySession | null): session is AwaySession =>
  session !== null && session.trigger === "sleep" && session.stage === "pending-intent";

/**
 * Whether a new lid close may start a session: none is open, and the last one
 * has nothing left on its target.
 */
export function sleepMayStart(session: AwaySession | null): boolean {
  if (session === null) return true;
  if (session.stage === "pending-intent") return false;
  if (session.finishedAt === null) return false;
  if (session.broughtBackAt !== null) return true;
  return !session.items.some(
    (item) =>
      (item.back === undefined || item.back.outcome === "failed") &&
      (item.outcome === "moved" || item.outcome === "paused"),
  );
}

/**
 * The routines to turn off here before the target may act: enabled,
 * non-webhook, bound to a thread in the intent or owned by the coordinator of
 * a project in it.
 */
export function routinesToPauseOnSleep(
  tasks: ReadonlyArray<ScheduledTask>,
  ids: { readonly projectIds: ReadonlyArray<string>; readonly threadIds: ReadonlyArray<string> },
): ReadonlyArray<ScheduledTask> {
  const projects = new Set(ids.projectIds);
  const threads = new Set(ids.threadIds);
  return tasks.filter(
    (task) =>
      task.enabled &&
      task.schedule.type !== "webhook" &&
      ((task.threadId !== null && threads.has(task.threadId)) ||
        (task.ownThread === true && projects.has(task.projectId))),
  );
}

export interface SleepSessionFacts {
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly threadTitles: ReadonlyMap<string, string>;
  /** Live threads left out of the intent because handoff mode is off for them. */
  readonly handoffOff: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly projectId: ProjectId;
  }>;
}

/** The session a lid close records, before any routine is paused. */
export function sleepSessionOf(input: {
  readonly sessionId: string;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetLabel: string;
  readonly coordinatorScope: AwayCoordinatorScope;
  readonly sleep: AwaySleepSession;
  readonly facts: SleepSessionFacts;
}): AwaySession {
  const label = input.targetLabel;
  const after = `if this machine sleeps longer than ${input.sleep.graceMinutes} minute${input.sleep.graceMinutes === 1 ? "" : "s"}`;
  const items: AwayItemResult[] = [
    ...input.sleep.projectIds.map((projectId): AwayItemResult => ({
      kind: "coordinator",
      id: projectId,
      projectId,
      title: clip(input.facts.projectTitles.get(projectId) ?? projectId),
      outcome: "pending",
      detail: clip(`${label} takes over its coordinator ${after}.`),
    })),
    ...input.sleep.threadIds.map((threadId): AwayItemResult => ({
      kind: "thread",
      id: threadId,
      title: clip(input.facts.threadTitles.get(threadId) ?? threadId),
      outcome: "pending",
      detail: clip(`Continues on ${label} ${after}.`),
    })),
    ...input.facts.handoffOff.map((thread): AwayItemResult => ({
      kind: "thread",
      id: thread.id,
      title: clip(thread.title),
      projectId: thread.projectId,
      outcome: "stayed",
      detail: clip(`Handoff mode is off, so it had no copy on ${label}.`),
    })),
  ];
  return {
    sessionId: input.sessionId,
    targetEnvironmentId: input.targetEnvironmentId,
    targetLabel: clip(label, 120),
    trigger: "sleep",
    coordinatorScope: input.coordinatorScope,
    startedAt: input.sleep.sentAt,
    finishedAt: null,
    stage: "pending-intent",
    items: items.slice(0, AWAY_SESSION_MAX_ITEMS),
    bringBackStartedAt: null,
    broughtBackAt: null,
    sleep: input.sleep,
  };
}

/** The routines a lid close turned off here, as session items. */
export function pausedRoutineItems(
  paused: ReadonlyArray<Pick<ScheduledTask, "id" | "title" | "projectId">>,
  targetLabel: string,
): ReadonlyArray<AwayItemResult> {
  return paused.map((task) => ({
    kind: "routine",
    id: task.id,
    title: clip(task.title),
    projectId: task.projectId,
    outcome: "paused",
    via: "paused",
    wasEnabled: true,
    detail: awayPausedNote(targetLabel),
  }));
}

/**
 * Back before the target acted: everything stayed. `resumed` says which paused
 * routines turned on again; one that did not keeps the session open, so Bring
 * back tries again.
 */
export function settleSleepNothingMoved(
  session: AwaySession,
  now: string,
  resumed: ReadonlyMap<string, boolean>,
): AwaySession {
  const label = session.targetLabel;
  const items = session.items.map((item): AwayItemResult => {
    if (item.kind === "routine" && item.outcome === "paused") {
      const ok = resumed.get(item.id) ?? false;
      return {
        ...item,
        back: ok
          ? { outcome: "returned", detail: "Runs here again.", at: now }
          : { outcome: "failed", detail: "Could not turn it back on here.", at: now },
      };
    }
    if (item.outcome !== "pending") return item;
    return {
      ...item,
      outcome: "stayed",
      detail: clip(`This machine woke before ${label} took over, so it stayed here.`),
    };
  });
  const allBack = items.every(
    (item) =>
      !(item.kind === "routine" && item.outcome === "paused" && item.back?.outcome !== "returned"),
  );
  return {
    ...session,
    items,
    stage: "done",
    finishedAt: session.finishedAt ?? now,
    broughtBackAt: allBack ? now : null,
  };
}

/**
 * Thread items still pending take the continuation the handoff heartbeat
 * recorded here. `final` (Bring back) settles the rest as staying.
 */
export function fillSleepThreads(
  session: AwaySession,
  continued: ReadonlyMap<string, string>,
  final: boolean,
): AwaySession {
  const label = session.targetLabel;
  let changed = false;
  const items = session.items.map((item): AwayItemResult => {
    if (item.kind !== "thread" || item.outcome !== "pending") return item;
    const there = continued.get(item.id);
    if (there !== undefined) {
      changed = true;
      return {
        ...item,
        outcome: "moved",
        targetId: there,
        detail: clip(`Continued on ${label} while this machine slept.`),
      };
    }
    if (!final) return item;
    changed = true;
    return {
      ...item,
      outcome: "stayed",
      detail: clip(`It did not continue on ${label}, so it stays here.`),
    };
  });
  return changed ? { ...session, items } : session;
}

/**
 * Back after the grace: coordinators read what the target took over (null
 * when it did not say), threads their continuation. The session then waits
 * for Bring back.
 */
export function settleSleepMoved(
  session: AwaySession,
  now: string,
  takenOver: ReadonlyArray<string> | null,
  continued: ReadonlyMap<string, string>,
  more: {
    /** Coordinator routines of a project the target did not take: whether each runs here again. */
    readonly resumed?: ReadonlyMap<string, boolean>;
    /** Threads with queued messages here, kept and listed when the thread continued there. */
    readonly queued?: ReadonlySet<string>;
  } = {},
): AwaySession {
  const label = session.targetLabel;
  const taken = takenOver === null ? null : new Set(takenOver);
  const items = session.items.map((item): AwayItemResult => {
    if (item.kind === "routine" && more.resumed?.get(item.id) === true) {
      const { via: _via, wasEnabled: _wasEnabled, ...rest } = item;
      return {
        ...rest,
        outcome: "stayed",
        detail: clip(`${label} did not take this project, so its routines stayed here.`),
      };
    }
    if (item.kind === "thread" && item.outcome === "pending") {
      const there = continued.get(item.id);
      return there === undefined
        ? { ...item, detail: clip(`Checking whether it continued on ${label}.`) }
        : {
            ...item,
            outcome: "moved",
            targetId: there,
            detail: clip(
              more.queued?.has(item.id) === true
                ? `Continued on ${label} while this machine slept. Its queued messages are held here; open it on ${label} and send them there.`
                : `Continued on ${label} while this machine slept.`,
            ),
          };
    }
    if (item.kind !== "coordinator" || item.outcome !== "pending") return item;
    if (taken === null)
      return {
        ...item,
        outcome: "moved",
        detail: clip(`${label} was due to take over its coordinator while this machine slept.`),
      };
    return taken.has(item.projectId ?? item.id)
      ? {
          ...item,
          outcome: "moved",
          detail: clip(`${label} took over its coordinator while this machine slept.`),
        }
      : {
          ...item,
          outcome: "stayed",
          detail: clip(`${label} did not take over its coordinator, so it coordinates here.`),
        };
  });
  return { ...session, items, stage: "done", finishedAt: session.finishedAt ?? now };
}

// --- the port the sleep trigger calls -----------------------------------------------

/** What the sleep trigger does with the Away session; the live one is `makeSleepSessionPort`. */
export interface SleepSessionPort {
  /** Whether a lid close may start a session now (nothing open, nothing left away). */
  readonly mayStart: Effect.Effect<boolean>;
  /** After the intent was recorded: lists the items and turns the routines off here. */
  readonly begin: (
    sleep: AwaySleepSession,
    coordinatorScope: AwayCoordinatorScope,
  ) => Effect.Effect<void>;
  /**
   * The wake found nothing moved: routines on again, the session closed and
   * its `sleep` record dropped, in one write. False when it could not be saved.
   */
  readonly nothingMoved: Effect.Effect<boolean>;
  /**
   * The wake found work moved, after this machine gave way where the target
   * took over (so a copy that no longer coordinates was taken over). Saves the
   * items, the stage and `sleep` (the wake prompt) in one write; false when
   * it could not be saved, so the check runs again.
   */
  readonly moved: (sleep?: AwaySleepSession) => Effect.Effect<boolean>;
}

export interface SleepSessionDeps {
  readonly load: Effect.Effect<AwaySession | null>;
  /** Changes the saved session in one write; null removes nothing. */
  readonly update: (
    change: (session: AwaySession | null) => AwaySession | null,
  ) => Effect.Effect<boolean | void>;
  readonly now: Effect.Effect<string>;
  readonly newId: Effect.Effect<string>;
  readonly targetLabel: (target: EnvironmentId) => Effect.Effect<string>;
  readonly facts: (ids: {
    readonly projectIds: ReadonlyArray<string>;
    readonly threadIds: ReadonlyArray<string>;
    readonly target: EnvironmentId;
  }) => Effect.Effect<SleepSessionFacts & { readonly tasks: ReadonlyArray<ScheduledTask> }>;
  /** Turns a routine off here with the note (true when done), or back on with null. */
  readonly pauseHere: (taskId: string, note: string | null) => Effect.Effect<boolean>;
  /** Heartbeats the replica machines once, so a thread continued there is fenced here now. */
  readonly heartbeat: Effect.Effect<void>;
  /** Source thread id to the thread that continues it on `target`, from the handoff record. */
  readonly continuedOn: (target: EnvironmentId) => Effect.Effect<ReadonlyMap<string, string>>;
  /** Whether this copy still coordinates the project (it gave way where the target took over). */
  readonly coordinates: (projectId: string) => Effect.Effect<boolean>;
  /** Each routine's worker thread, or null for a coordinator's own; absent: none turn on early. */
  readonly routineThreads?: Effect.Effect<ReadonlyMap<string, string | null>> | undefined;
  /** Threads with queued messages here. */
  readonly queued?: Effect.Effect<ReadonlySet<string>> | undefined;
}

/** Without its `sleep` record: the wake was handled. */
const withoutSleep = (session: AwaySession): AwaySession => {
  const { sleep: _sleep, ...rest } = session;
  return rest;
};

export const makeSleepSessionPort = (deps: SleepSessionDeps): SleepSessionPort => {
  const begin: SleepSessionPort["begin"] = (sleep, coordinatorScope) =>
    Effect.gen(function* () {
      const target = sleep.targetEnvironmentId;
      const label = yield* deps.targetLabel(target);
      const facts = yield* deps.facts({
        projectIds: sleep.projectIds,
        threadIds: sleep.threadIds,
        target,
      });
      const held = yield* deps.load;
      const session = sleepSessionOf({
        // The store already saved this lid close (`sleepStoreOver`): keep its id.
        sessionId:
          isPendingSleep(held) && held.sleep?.sentAt === sleep.sentAt
            ? held.sessionId
            : yield* deps.newId,
        targetEnvironmentId: target,
        targetLabel: label,
        coordinatorScope,
        sleep,
        facts,
      });
      // Saved before any routine is paused: a crash in between still lists them.
      const toPause = routinesToPauseOnSleep(facts.tasks, sleep);
      yield* deps.update(() => ({
        ...session,
        items: [...session.items, ...pausedRoutineItems(toPause, label)].slice(
          0,
          AWAY_SESSION_MAX_ITEMS,
        ),
      }));
      const note = awayPausedNote(label);
      const failed = new Set<string>();
      for (const task of toPause) if (!(yield* deps.pauseHere(task.id, note))) failed.add(task.id);
      if (failed.size === 0) return;
      yield* deps.update((current) =>
        current === null || current.sessionId !== session.sessionId
          ? current
          : {
              ...current,
              items: current.items.map((item) =>
                item.kind === "routine" && failed.has(item.id)
                  ? {
                      ...item,
                      outcome: "stayed",
                      detail: "Could not turn it off here; it runs here as before.",
                    }
                  : item,
              ),
            },
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Away: could not record the lid close", { cause }),
      ),
    );

  const saved = (change: (session: AwaySession | null) => AwaySession | null) =>
    deps.update(change).pipe(Effect.map((result) => result !== false));

  const nothingMoved = Effect.gen(function* () {
    const session = yield* deps.load;
    if (!isPendingSleep(session)) return true;
    const resumed = new Map<string, boolean>();
    for (const item of session.items)
      if (item.kind === "routine" && item.outcome === "paused")
        resumed.set(
          item.id,
          item.wasEnabled === false ? true : yield* deps.pauseHere(item.id, null),
        );
    const now = yield* deps.now;
    // The items, the stage and the dropped `sleep` record in one write.
    return yield* saved((current) =>
      current?.sessionId === session.sessionId && isPendingSleep(current)
        ? withoutSleep(settleSleepNothingMoved(current, now, resumed))
        : current,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Away: could not close the lid-close session", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  const moved: SleepSessionPort["moved"] = (sleep) =>
    Effect.gen(function* () {
      const session = yield* deps.load;
      if (!isPendingSleep(session)) return true;
      // A thread the target continued is fenced here on this heartbeat, not 30 seconds later.
      yield* deps.heartbeat;
      const continued = yield* deps.continuedOn(session.targetEnvironmentId);
      const now = yield* deps.now;
      const taken: string[] = [];
      const kept = new Set<string>();
      for (const item of session.items) {
        if (item.kind !== "coordinator") continue;
        const projectId = item.projectId ?? item.id;
        if (!(yield* deps.coordinates(projectId))) taken.push(projectId);
        else kept.add(projectId);
      }
      // The coordinator's own routines of a project the target did not take run here again now.
      const threadOf =
        deps.routineThreads === undefined
          ? new Map<string, string | null>()
          : yield* deps.routineThreads;
      const resumed = new Map<string, boolean>();
      for (const item of session.items)
        if (
          item.kind === "routine" &&
          item.outcome === "paused" &&
          item.back === undefined &&
          item.projectId !== undefined &&
          kept.has(item.projectId) &&
          threadOf.has(item.id) &&
          threadOf.get(item.id) === null
        )
          resumed.set(
            item.id,
            item.wasEnabled === false ? true : yield* deps.pauseHere(item.id, null),
          );
      const queued = deps.queued === undefined ? new Set<string>() : yield* deps.queued;
      // The items, the stage and the wake prompt in one write.
      return yield* saved((current) =>
        current?.sessionId === session.sessionId && isPendingSleep(current)
          ? {
              ...settleSleepMoved(current, now, taken, continued, { resumed, queued }),
              ...(sleep === undefined ? {} : { sleep }),
            }
          : current,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Away: could not record what moved while asleep", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  return {
    mayStart: deps.load.pipe(
      Effect.map(sleepMayStart),
      Effect.orElseSucceed(() => true),
    ),
    begin,
    nothingMoved,
    moved,
  };
};

// --- the sleep trigger's store, over the session ------------------------------------------

/**
 * The sleep trigger's own record as a thin pointer into the Away session:
 * reading answers the open lid-close session's `sleep`, writing changes it
 * (starting a bare session when none is open, so a wake always finds the
 * intent to cancel), and clearing drops it once the wake was handled.
 */
export const sleepStoreOver = (
  deps: Pick<SleepSessionDeps, "load" | "update" | "newId" | "targetLabel">,
) => ({
  read: deps.load.pipe(
    Effect.map((session) =>
      session !== null &&
      session.trigger === "sleep" &&
      session.sleep !== undefined &&
      session.broughtBackAt === null
        ? session.sleep
        : null,
    ),
  ),
  write: (next: AwaySleepSession | null): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (next === null) {
        yield* deps.update((current) => {
          if (current === null || current.trigger !== "sleep" || current.sleep === undefined)
            return current;
          const { sleep: _sleep, ...rest } = current;
          return rest;
        });
        return;
      }
      const held = yield* deps.load;
      const open =
        held !== null &&
        held.trigger === "sleep" &&
        held.broughtBackAt === null &&
        (held.stage === "pending-intent" || held.sleep?.sentAt === next.sentAt);
      const fresh = open
        ? null
        : sleepSessionOf({
            sessionId: yield* deps.newId,
            targetEnvironmentId: next.targetEnvironmentId,
            targetLabel: yield* deps.targetLabel(next.targetEnvironmentId),
            coordinatorScope: "live",
            sleep: next,
            facts: { projectTitles: new Map(), threadTitles: new Map(), handoffOff: [] },
          });
      yield* deps.update((current) =>
        fresh !== null
          ? fresh
          : current === null || current.trigger !== "sleep"
            ? current
            : { ...current, sleep: next },
      );
    }),
});

// --- live ---------------------------------------------------------------------------------

/** Whether handoff mode is off for a thread: it keeps no copy on another machine to continue. */
export const handoffOffFor =
  (document: Pick<HandoffDocument, "config" | "projectModes" | "threads">) =>
  (shell: Pick<OrchestrationV2ThreadShell, "id" | "projectId">): boolean =>
    effectiveHandoffMode(
      document,
      shell.projectId,
      document.threads[shell.id]?.mode ?? "inherit",
    ) !== "on";

const encodeSession = Schema.encodeSync(AwaySession);
const HEARTBEAT_WAIT_MS = 8_000;
const UPDATE_RETRY = { times: 4, schedule: Schedule.exponential(Duration.millis(100)) } as const;

/** The store and the port over this server's handoff document, projects, threads and routines. */
export const makeLiveSleepSession = Effect.gen(function* () {
  const handoff = yield* HandoffMode;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scheduled = yield* ScheduledTaskService;
  const sql = yield* SqlClient.SqlClient;
  const fleet = yield* FleetTargets.FleetTargets;
  const crypto = yield* Crypto.Crypto;
  const self = handoff.environmentId;

  const load = handoff.document.pipe(
    Effect.map((document) => readAwaySession(document.awaySession)),
    Effect.orElseSucceed(() => null),
  );
  // One write per change, retried; false when it still failed, so the caller tries again later.
  const update = (change: (session: AwaySession | null) => AwaySession | null) =>
    handoff
      .updateDocument((document) => {
        const before = readAwaySession(document.awaySession);
        const after = change(before);
        return [
          undefined,
          after === before || after === null
            ? document
            : { ...document, awaySession: encodeSession(after) },
        ] as const;
      })
      .pipe(
        Effect.retry(UPDATE_RETRY),
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("Away could not save its session", { cause }).pipe(Effect.as(false)),
        ),
      );
  const newId = crypto.randomUUIDv4.pipe(Effect.orDie);
  const targetLabel = (target: EnvironmentId) =>
    fleet.load.pipe(
      Effect.map(
        (config) =>
          config?.machines.find((machine) => machine.environmentId === target)?.label ?? target,
      ),
      Effect.orElseSucceed(() => target as string),
    );

  const deps: SleepSessionDeps = {
    load,
    update,
    now: Effect.map(DateTime.now, DateTime.formatIso),
    newId,
    targetLabel,
    facts: (ids) =>
      Effect.gen(function* () {
        const projectList = yield* projects.snapshot.pipe(
          Effect.map((snapshot) => snapshot.projects),
          Effect.orElseSucceed(() => []),
        );
        const shells = yield* projections.getShellSnapshot({ unsettledOnly: false }).pipe(
          Effect.map((snapshot) => snapshot.threads),
          Effect.orElseSucceed((): ReadonlyArray<OrchestrationV2ThreadShell> => []),
        );
        const tasks = yield* scheduled.list().pipe(
          Effect.map((listed) => listed.tasks),
          Effect.orElseSucceed((): ReadonlyArray<ScheduledTask> => []),
        );
        const off = yield* handoff.document.pipe(
          Effect.map(handoffOffFor),
          Effect.orElseSucceed(() => () => false),
        );
        const byId = new Map(projectList.map((project) => [project.id as string, project]));
        const inIntent = new Set(ids.threadIds);
        const handoffOff = shells.flatMap((shell) => {
          if (inIntent.has(shell.id) || isAwayCandidate(shell, self) === null) return [];
          const project = byId.get(shell.projectId);
          if (project === undefined || project.deletedAt !== null) return [];
          if (isProjectCoordinatorThreadId(shell.id, project)) return [];
          return off(shell)
            ? [{ id: shell.id as string, title: shell.title, projectId: shell.projectId }]
            : [];
        });
        return {
          projectTitles: new Map(
            projectList.map((project) => [project.id as string, project.title]),
          ),
          threadTitles: new Map(shells.map((shell) => [shell.id as string, shell.title])),
          handoffOff,
          tasks,
        };
      }),
    pauseHere: makePauseHere(scheduled, sql),
    heartbeat: handoff.heartbeat.pipe(Effect.timeout(HEARTBEAT_WAIT_MS), Effect.ignore),
    continuedOn: (target) =>
      handoff.document.pipe(
        Effect.map(
          (document) =>
            new Map(
              Object.entries(document.threads).flatMap(([id, record]) =>
                record.continuedOn?.environmentId === target
                  ? [[id, record.continuedOn.threadId as string] as const]
                  : [],
              ),
            ),
        ),
        Effect.orElseSucceed(() => new Map<string, string>()),
      ),
    coordinates: (projectId) =>
      projects.getById(projectId as ProjectId).pipe(
        Effect.map((found) =>
          Option.isSome(found) ? coordinatorRoleOf(found.value).active : false,
        ),
        // Unknown counts as still here: the summary then never claims it moved.
        Effect.orElseSucceed(() => true),
      ),
    routineThreads: scheduled.list().pipe(
      Effect.map(
        (listed) =>
          new Map(listed.tasks.map((task) => [task.id as string, task.threadId as string | null])),
      ),
      Effect.orElseSucceed(() => new Map<string, string | null>()),
    ),
    queued: projections.getShellSnapshot({ unsettledOnly: false }).pipe(
      Effect.map(
        (snapshot) =>
          new Set(
            snapshot.threads
              .filter((shell) => isAwayCandidate(shell, self)?.queued === true)
              .map((shell) => shell.id as string),
          ),
      ),
      Effect.orElseSucceed(() => new Set<string>()),
    ),
  };
  return {
    store: sleepStoreOver(deps),
    port: makeSleepSessionPort(deps),
    /** For the intent: live threads with handoff mode off have no copy to continue. */
    handoffOff: handoff.document.pipe(
      Effect.map(handoffOffFor),
      Effect.orElseSucceed(
        () => (_shell: Pick<OrchestrationV2ThreadShell, "id" | "projectId">) => false,
      ),
    ),
  };
});
