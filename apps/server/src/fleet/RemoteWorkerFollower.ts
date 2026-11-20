import * as DateTime from "effect/DateTime";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2Notification,
  projectExecutionIsFenced,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  formatStudioThreadHref,
  studioThreadLinkLabel,
} from "@specweave-studio/shared/studioThreadLinks";
import { coordinatorSourceTitle } from "@specweave-studio/shared/coordinatorReplySources";
import type { RemoteWorkerRef } from "./remoteWorkerMatching.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { continuationThreadId } from "../handoff/HandoffReceiver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";
import {
  afterHandoffRunEnded,
  closedWith,
  endedWithoutResult,
  firstRunId,
  type HandoffFollowState,
  type ListedMessage,
  type ListedRun,
  listedMessages,
  listedRuns,
  movedOn as handedOn,
  nextHandoffStep,
  owesResult,
} from "./handoffDelivery.ts";
import * as HandoffLocalThread from "./handoffLocalThread.ts";
import { ownerMachineNames } from "./machineNames.ts";
import * as RemoteStudioMcpClient from "./RemoteStudioMcpClient.ts";
import {
  isTerminalThreadStatus,
  remoteWorkerLost,
  remoteWorkerWake,
} from "./remoteWorkerMatching.ts";
import * as RemoteWorkerStore from "./RemoteWorkerStore.ts";

/** How long the follower waits and backs off. Tests shorten them. */
export interface RemoteWorkerFollowerTimingsShape {
  readonly waitMs: number;
  readonly backoffStartMs: number;
  readonly backoffMaxMs: number;
  readonly lostContactMs: number;
  readonly wakeRetryMs: number;
  readonly authPollMs: number;
  readonly launchStaleMs: number;
  /** Wakes delivered this recently are re-sent at boot, in case the database lost them. */
  readonly redeliverWithinMs: number;
  readonly maxFollowsPerMachine: number;
  /**
   * How long a failed run is held back before it is reported, in case the
   * other machine's automatic fallback starts a newer run in the same thread.
   */
  readonly fallbackGraceMs: number;
  /**
   * Failed rows this recent are checked at boot for a fallback run reported
   * before fallback runs were followed. Older ones stay as they are: a later
   * run there is more likely someone's own message than a fallback.
   */
  readonly recheckFailedWithinMs: number;
  /** How often a start never confirmed is looked for again on its machine. */
  readonly recheckUnconfirmedMs: number;
}

export const RemoteWorkerFollowerTimings = Context.Reference<RemoteWorkerFollowerTimingsShape>(
  "studio/fleet/RemoteWorkerFollowerTimings",
  {
    defaultValue: () => ({
      waitMs: 120_000,
      backoffStartMs: 5_000,
      backoffMaxMs: 5 * 60_000,
      lostContactMs: 24 * 60 * 60_000,
      wakeRetryMs: 5 * 60_000,
      authPollMs: 60_000,
      launchStaleMs: 2 * 60_000,
      redeliverWithinMs: 6 * 60 * 60_000,
      maxFollowsPerMachine: 16,
      // The other machine's fallback sweep runs every 30s and is woken by the failure.
      fallbackGraceMs: 90_000,
      recheckFailedWithinMs: 2 * 24 * 60 * 60_000,
      recheckUnconfirmedMs: 5 * 60_000,
    }),
  },
);

/** A launch the other machine may have carried out, found again by its fingerprint. */
export interface ReconciledLaunch {
  readonly threadId: string;
  readonly runId: string | null;
  readonly status: string;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
}

/**
 * "transferred": the caller is the coordinator of a copy that gave the
 * coordinator to another machine. The orchestrator refuses it every message,
 * and the machine that took over follows the worker now.
 */
type WakeOutcome = "sent" | "pending" | "disposed" | "transferred";

const TRANSFERRED_MESSAGE = "Another machine took over as coordinator. It follows this worker now.";

/**
 * The status a followed worker shows while its run is blocked on the person
 * on its own machine (a question, a sign-in or an approval there), instead of
 * reading as working for as long as nobody answers it.
 */
export const REMOTE_WORKER_WAITING_ON_YOU = "waiting_on_you";

/**
 * Tells the caller, once per run, that its worker waits on the person. The
 * words are fixed; nothing from the remote agent is quoted.
 */
export function remoteWorkerWaitingOnYou(input: RemoteWorkerRef): {
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
} {
  const link = `[${studioThreadLinkLabel(input.title.slice(0, 200), "worker")}](${input.threadRef})`;
  return {
    text: `Remote worker ${link} on ${input.machineLabel} is waiting on the user: its run asked for an answer, a sign-in or an approval there. Tell the user; they answer it in that thread. You are woken again when its run finishes.`,
    notification: {
      source: { kind: "background_task" },
      replySources: [
        {
          kind: "thread",
          threadId: ThreadId.make(input.remoteThreadId),
          environmentId: EnvironmentId.make(input.environmentId),
          title: coordinatorSourceTitle(input.title) ?? "Worker",
        },
      ],
      outcome: "unknown",
      summary: `${link} on ${input.machineLabel} needs you.`,
    },
  };
}

export class RemoteWorkerFollower extends Context.Service<
  RemoteWorkerFollower,
  {
    /** Follows a row's remote run until it finishes, then wakes its caller. Idempotent. */
    readonly follow: (rowId: string) => Effect.Effect<void>;
    /** Looks for the thread a launch with an unknown outcome created. Never launches again. */
    readonly reconcile: (
      row: RemoteWorkerStore.RemoteWorkerRecord,
    ) => Effect.Effect<ReconciledLaunch | undefined, RemoteStudioMcpClient.RemoteMcpError>;
    /** Whether the last contact with a machine worked, for the UI. */
    readonly reachable: (machineId: string) => Effect.Effect<boolean>;
    /**
     * Runs a launch for `rowId`. If it is cut off (a client tool timeout, the
     * user stopping the turn), the launch is settled from the other machine's
     * thread list instead of staying "launching".
     */
    readonly trackLaunch: (
      rowId: string,
    ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** Picks rows back up after a restart; run once at boot. */
    readonly resume: Effect.Effect<void>;
  }
>()("specweave-studio/fleet/RemoteWorkerFollower") {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The most runs a released machine lists in one thread read, and the most messages. */
const HANDOFF_RUN_PAGE = 50;
const HANDOFF_ITEM_PAGE = 100;

/** The longest pause between looks for a continuation of a reported failure. */
const FALLBACK_WATCH_MAX_MS = 15 * 60_000;

/** Why a row stopped: its work was handed on to a machine this one has no way to ask. */
export const HANDED_ON_OUT_OF_REACH =
  "This thread was handed on to a machine this one cannot follow it on.";

/** Shown while a copy reads as handed on but does not yet say under which move. */
export const HANDED_ON_NOT_SAID =
  "This thread was handed on, and the machine it left has not yet said where its work continues. Asking again.";

/** Shown while the owed run was stopped and several runs may have started next. */
export const RESULT_RUN_UNSURE =
  "The run this handoff waited for was stopped, and more than one run started after it. Which came first cannot be told from here, so none is reported.";

/** The handoff state that outlives a step: what the row is, not what it was waiting for. */
const handoffBase = (handoff: HandoffFollowState): HandoffFollowState => ({
  sourceThreadId: handoff.sourceThreadId,
  epoch: handoff.epoch,
  ...(handoff.hops === undefined ? {} : { hops: handoff.hops }),
  ...(handoff.scanFrom === undefined ? {} : { scanFrom: handoff.scanFrom }),
  ...(handoff.runId === undefined ? {} : { runId: handoff.runId }),
  ...(handoff.woke === undefined ? {} : { woke: handoff.woke }),
});

const make = Effect.gen(function* () {
  const store = yield* RemoteWorkerStore.RemoteWorkerStore;
  const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
  const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
  const targets = yield* FleetTargets.FleetTargets;
  // Read here, not at each wake: a wake runs in the follower's own fibers.
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const timings = yield* RemoteWorkerFollowerTimings;
  // Absent where a caller builds the follower without it: nothing is then local.
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const self = Option.isSome(environment) ? yield* environment.value.getEnvironmentId : undefined;
  const here = HandoffLocalThread.make(threads);
  const scope = yield* Effect.scope;
  const active = yield* Ref.make<ReadonlySet<string>>(new Set());
  /** Launches this process is still carrying out; the stale sweep leaves them alone. */
  const launching = yield* Ref.make<ReadonlySet<string>>(new Set());
  const reachability = yield* Ref.make<ReadonlyMap<string, boolean>>(new Map());
  const permits = new Map<string, Semaphore.Semaphore>();

  const permitFor = (machineId: string) =>
    Effect.sync(() => {
      let semaphore = permits.get(machineId);
      if (!semaphore) {
        semaphore = Semaphore.makeUnsafe(timings.maxFollowsPerMachine);
        permits.set(machineId, semaphore);
      }
      return semaphore;
    });

  const now = Clock.currentTimeMillis;
  const isoNow = Effect.map(now, (millis) => DateTime.formatIso(DateTime.makeUnsafe(millis)));

  const findRow = (rowId: string) =>
    store.list.pipe(
      Effect.map((rows) => rows.find((row) => row.id === rowId)),
      Effect.orElseSucceed(() => undefined),
    );

  const update = (
    rowId: string,
    change: (
      row: RemoteWorkerStore.RemoteWorkerRecord,
    ) => Partial<RemoteWorkerStore.RemoteWorkerRecord>,
  ) =>
    Effect.gen(function* () {
      const updatedAt = yield* isoNow;
      return yield* store
        .modify(rowId, (row) => (row ? { ...row, ...change(row), updatedAt } : undefined))
        .pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Could not record a remote worker's state.", { rowId, error }),
          ),
          Effect.orElseSucceed(() => undefined),
        );
    });

  /**
   * Asks about the row's thread where it runs: on its machine, or here once a
   * handed-off thread came back to the machine it was launched from.
   */
  const ask = (
    row: RemoteWorkerStore.RemoteWorkerRecord,
    input: {
      readonly tool: "studio_thread_read" | "studio_thread_wait";
      readonly arguments: Record<string, unknown>;
      readonly timeoutMs?: number;
    },
  ) =>
    row.handoff !== undefined && row.environmentId === self
      ? here.call(input)
      : client.call({ machineId: row.machineId, ...input });

  const setReachable = (machineId: string, value: boolean) =>
    Ref.update(reachability, (current) => new Map(current).set(machineId, value));

  // The owner's name first: an agent reads this name in a wake and may ask for it next.
  const machineLabel = (machineId: string) =>
    Effect.all([
      targets.load,
      ownerMachineNames(settings),
      Option.isSome(environment) ? environment.value.getDescriptor : Effect.succeed(undefined),
    ]).pipe(
      Effect.map(([config, names, own]) => {
        if (own !== undefined && machineId === own.environmentId)
          return names.get(own.environmentId) ?? own.label;
        const machine = config?.machines.find((row) => row.id === machineId);
        if (machine === undefined) return machineId;
        return names.get(machine.environmentId) ?? machine.label;
      }),
      Effect.orElseSucceed(() => machineId),
    );

  /**
   * Queues `message` on the caller's thread; never interrupts what it is
   * doing. People see its notification, the agent its text.
   */
  const wake = (
    row: RemoteWorkerStore.RemoteWorkerRecord,
    id: string,
    message: { readonly text: string; readonly notification: OrchestrationV2Notification },
  ) =>
    Effect.gen(function* () {
      const shell = yield* threads
        .getThreadShell(ThreadId.make(row.callerThreadId))
        .pipe(Effect.orElseSucceed(() => undefined));
      if (shell === undefined) return "pending" satisfies WakeOutcome;
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null)
        return "disposed" satisfies WakeOutcome;
      const project = yield* projects.getById(shell.projectId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (project === undefined) return "pending" satisfies WakeOutcome;
      // Only a settled handoff: a coordinator still moving may come back here.
      if (
        project.workspaceSettings?.coordinatorBinding?.state === "transferred" &&
        projectExecutionIsFenced(project.workspaceSettings, project.id, row.callerThreadId)
      )
        return "transferred" satisfies WakeOutcome;
      if (project.workspaceSettings?.paused || project.workspaceSettings?.archived)
        return "pending" satisfies WakeOutcome;
      return yield* threads
        .sendToThread({
          projectId: shell.projectId,
          commandId: CommandId.make(id),
          threadId: shell.id,
          messageId: MessageId.make(id),
          text: message.text,
          notification: message.notification,
          attachments: [],
          mode: "queue",
          // The orchestrator shows a server's queued agent-facing message as a notice.
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.as("sent" satisfies WakeOutcome),
          Effect.catch((error) =>
            Effect.logWarning("Could not wake a coordinator about its remote worker.", {
              rowId: row.id,
              error: error._tag,
            }).pipe(
              Effect.as(
                (error._tag === "ThreadManagementThreadArchivedError"
                  ? "disposed"
                  : "pending") satisfies WakeOutcome,
              ),
            ),
          ),
        );
    });

  /**
   * One id per run for a launched worker. A handoff tells its launcher once,
   * whichever run turns out to be its result, so while it owes that result,
   * and when that message is sent again, the id is the row's alone. Runs the
   * launcher starts there afterwards are a worker's runs again.
   */
  const wakeId = (row: RemoteWorkerStore.RemoteWorkerRecord, key: string) =>
    owesResult(row) || (row.handoff !== undefined && row.handoff.woke?.key === key)
      ? `remote-worker-wake:${row.id}`
      : `remote-worker-wake:${row.id}:${key}`;

  /** Rows whose last poll saw a pending request. */
  const pendingSeen = new Set<string>();
  /**
   * Whether the worker's thread has a request open to the person: true only
   * once one is seen on two polls in a row. Undefined when the other machine
   * could not say or the request is new; the last answer then stands.
   */
  const waitsOnPerson = (row: RemoteWorkerStore.RemoteWorkerRecord) =>
    Effect.gen(function* () {
      if (row.remoteThreadId === null) return undefined;
      const semaphore = yield* permitFor(row.machineId);
      const read = yield* semaphore
        .withPermits(1)(
          ask(row, {
            tool: "studio_thread_read",
            arguments: { threadId: row.remoteThreadId, limit: 1, runLimit: 1 },
          }),
        )
        .pipe(Effect.result);
      if (read._tag === "Failure") return undefined;
      const thread = isRecord(read.success) ? read.success.thread : undefined;
      const count = isRecord(thread) ? thread.pendingRequestCount : undefined;
      if (typeof count !== "number") return undefined;
      if (count === 0) {
        pendingSeen.delete(row.id);
        return false;
      }
      // A Full access machine answers its own approvals within moments; only a
      // request still open on the next poll is waiting on the person.
      if (pendingSeen.has(row.id)) return true;
      pendingSeen.add(row.id);
      return undefined;
    });

  /** Notes a run blocked on the person and tells the caller once for that run. */
  const noteWaitingOnYou = (
    row: RemoteWorkerStore.RemoteWorkerRecord,
    runId: string | null,
    status: string,
  ) =>
    Effect.gen(function* () {
      const waiting = yield* waitsOnPerson(row);
      const shown =
        waiting === true ||
        (waiting === undefined && row.lastStatus === REMOTE_WORKER_WAITING_ON_YOU)
          ? REMOTE_WORKER_WAITING_ON_YOU
          : status;
      if (row.lastStatus !== shown) yield* update(row.id, () => ({ lastStatus: shown }));
      if (
        shown !== REMOTE_WORKER_WAITING_ON_YOU ||
        row.lastStatus === REMOTE_WORKER_WAITING_ON_YOU ||
        !row.reportBack ||
        row.remoteThreadId === null
      )
        return;
      // One notice per run: the orchestrator ignores a command id it already took.
      yield* wake(
        row,
        `remote-worker-waiting:${row.id}:${runId ?? "no-run"}`,
        remoteWorkerWaitingOnYou({
          environmentId: row.environmentId,
          remoteThreadId: row.remoteThreadId,
          title: row.title,
          threadRef: formatStudioThreadHref(row.remoteThreadId, row.environmentId),
          machineLabel: yield* machineLabel(row.machineId),
        }),
      );
    });

  const wakeMessage = (row: RemoteWorkerStore.RemoteWorkerRecord, status: string) =>
    Effect.map(machineLabel(row.machineId), (label) =>
      remoteWorkerWake({
        environmentId: row.environmentId,
        remoteThreadId: row.remoteThreadId ?? "",
        title: row.title,
        threadRef: formatStudioThreadHref(row.remoteThreadId ?? "", row.environmentId),
        machineLabel: label,
        status,
      }),
    );

  /**
   * Whether a newer run was noted on the row (a message sent to the worker)
   * while `runId` was being followed; that run still needs following.
   */
  const movedOn = (row: RemoteWorkerStore.RemoteWorkerRecord, runId: string | null) =>
    row.state === "following" &&
    row.followedRunId !== null &&
    runId !== null &&
    row.followedRunId !== runId;

  /**
   * After `runId` failed: the newer run the other machine started in the
   * same thread meanwhile, such as its automatic fallback after a usage
   * limit, or undefined once none appears within the grace window.
   */
  const newerRun = (
    row: RemoteWorkerStore.RemoteWorkerRecord,
    runId: string | null,
    graceMs = timings.fallbackGraceMs,
  ) =>
    Effect.gen(function* () {
      if (row.remoteThreadId === null || runId === null) return undefined;
      const deadline = (yield* now) + graceMs;
      while (true) {
        const semaphore = yield* permitFor(row.machineId);
        // No runId: the thread's latest run, answered at once.
        const latest = yield* semaphore
          .withPermits(1)(
            client.call({
              machineId: row.machineId,
              tool: "studio_thread_wait",
              arguments: { threadId: row.remoteThreadId, timeoutMs: 1 },
            }),
          )
          .pipe(Effect.result);
        if (latest._tag === "Failure") return undefined;
        const answer = isRecord(latest.success) ? latest.success : {};
        if (typeof answer.runId === "string" && answer.runId !== runId) return answer.runId;
        if ((yield* now) >= deadline) return undefined;
        yield* Effect.sleep(Duration.millis(timings.backoffStartMs));
      }
    });

  /**
   * A handed-off thread's result reached its launcher: the handoff owes
   * nothing more, and no later run there reopens it by itself.
   */
  const closing = (row: RemoteWorkerStore.RemoteWorkerRecord, runId: string | null) =>
    owesResult(row) && runId !== null ? { handoff: closedWith(row.handoff, runId) } : {};

  const delivered = (row: RemoteWorkerStore.RemoteWorkerRecord, key: string) =>
    row.deliveredRunIds.includes(key)
      ? row.deliveredRunIds
      : [...row.deliveredRunIds, key].slice(-50);

  /** Marks a handoff's one message as sent; a later run's message leaves the mark as it is. */
  const told = <A extends { readonly handoff?: HandoffFollowState }>(
    change: A,
    at: string,
    key: string,
  ): A =>
    change.handoff === undefined || change.handoff.woke !== undefined
      ? change
      : { ...change, handoff: { ...change.handoff, woke: { at, key } } };

  /**
   * Tells the caller a finished run's status once, whatever happens to this
   * server meanwhile. Returns whether the row moved on to a newer run.
   */
  const deliver = (
    row: RemoteWorkerStore.RemoteWorkerRecord,
    runId: string | null,
    status: string,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      // The caller may have seen this run finish itself meanwhile.
      row = (yield* findRow(row.id)) ?? row;
      const key = runId ?? "no-run";
      /** Idle after this run, unless a newer run was noted meanwhile. */
      const settled = (current: RemoteWorkerStore.RemoteWorkerRecord) => ({
        state: movedOn(current, runId) ? ("following" as const) : ("idle" as const),
        lastStatus: movedOn(current, runId) ? current.lastStatus : status,
        deliveredRunIds: delivered(current, key),
        ...closing(current, runId),
      });
      if (
        row.deliveredRunIds.includes(key) ||
        !row.reportBack ||
        row.remoteThreadId === null ||
        // Told once already: what a continuation of that failure ends as is only shown.
        (owesResult(row) && row.handoff.woke !== undefined)
      ) {
        const next = yield* update(row.id, settled);
        return next?.state === "following";
      }
      const outcome = yield* wake(row, wakeId(row, key), yield* wakeMessage(row, status));
      if (outcome === "sent") {
        const at = yield* isoNow;
        const next = yield* update(row.id, (current) => ({
          ...told(settled(current), at, key),
          lastError: null,
          lastWakeRunId: key,
        }));
        return next?.state === "following";
      }
      if (outcome === "disposed") {
        yield* update(row.id, () => ({ state: "disposed", lastStatus: status }));
        return false;
      }
      if (outcome === "transferred") {
        yield* update(row.id, () => ({
          state: "stopped",
          lastStatus: status,
          lastError: TRANSFERRED_MESSAGE,
        }));
        return false;
      }
      const next = yield* update(row.id, (current) =>
        // A newer run's own wake will tell the caller; keep following it.
        movedOn(current, runId)
          ? {}
          : { state: "wake_pending", lastStatus: status, followedRunId: runId },
      );
      if (next?.state === "following") return true;
      yield* retryWake(row.id);
      return false;
    });

  /** Retries a wake that could not be queued, such as while the project is paused. */
  const retryWake = (rowId: string) =>
    exclusive(
      `wake:${rowId}`,
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(Duration.millis(timings.wakeRetryMs));
          const row = yield* findRow(rowId);
          if (!row || row.state !== "wake_pending") return;
          const runId = row.followedRunId;
          const key = runId ?? "no-run";
          if (row.remoteThreadId === null) return;
          const outcome = yield* wake(
            row,
            wakeId(row, key),
            yield* wakeMessage(row, row.lastStatus ?? "finished"),
          );
          if (outcome === "sent") {
            const at = yield* isoNow;
            yield* update(rowId, (current) => ({
              state: "idle",
              lastError: null,
              lastWakeRunId: key,
              deliveredRunIds: delivered(current, key),
              ...told(closing(current, runId), at, key),
            }));
            // A failure told late is watched like one told at once.
            if (row.handoff !== undefined && row.lastStatus === "failed")
              yield* watchFallback(rowId);
            return;
          }
          if (outcome === "disposed") {
            yield* update(rowId, () => ({ state: "disposed" }));
            return;
          }
          if (outcome === "transferred") {
            yield* update(rowId, () => ({ state: "stopped", lastError: TRANSFERRED_MESSAGE }));
            return;
          }
        }
      }),
    );

  /** Runs `effect` in the background unless a fiber with the same key already does. */
  const exclusive = (key: string, effect: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const started = yield* Ref.modify(active, (current) =>
        current.has(key) ? [false, current] : [true, new Set(current).add(key)],
      );
      if (!started) return;
      yield* effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logError("A remote worker follower stopped unexpectedly.", { key, cause }),
        ),
        Effect.ensuring(
          Ref.update(active, (current) => {
            const next = new Set(current);
            next.delete(key);
            return next;
          }),
        ),
        Effect.forkIn(scope),
      );
    });

  /**
   * What one read of a handed-off thread does not show: the runs older than
   * the other machine lists at once, and the message that started each run,
   * listed or not (a long run pushes its own first message off the page).
   * Walks the thread forward from where earlier looks ruled everything out.
   * Undefined when it could not say; the pass is then made again later.
   */
  const olderRuns = (
    row: RemoteWorkerStore.RemoteWorkerRecord,
    owed: HandoffFollowState,
    page: ReadonlyArray<ListedRun>,
  ) =>
    Effect.gen(function* () {
      const listed = new Map(page.map((run) => [run.runId, run.status]));
      const started = new Map<string, ListedMessage>();
      const semaphore = yield* permitFor(row.machineId);
      let after = owed.scanFrom ?? -1;
      while (true) {
        const read = yield* semaphore
          .withPermits(1)(
            ask(row, {
              tool: "studio_thread_read",
              arguments: {
                threadId: row.remoteThreadId,
                view: "messages",
                afterPosition: after,
                limit: HANDOFF_ITEM_PAGE,
                runLimit: 1,
                // Ids are all that is read: pages are then cut by count, not by size.
                maxCharsPerItem: 1,
              },
            }),
          )
          .pipe(Effect.result);
        if (read._tag === "Failure") return undefined;
        const answer = isRecord(read.success) ? read.success : {};
        for (const message of listedMessages(answer)) {
          if (!started.has(message.runId)) started.set(message.runId, message);
        }
        const next = typeof answer.nextPosition === "number" ? answer.nextPosition : after;
        if (answer.hasMore !== true || next <= after) break;
        after = next;
      }
      const runs: Array<ListedRun> = [];
      /** How each run that started a message ended, as far as it is known. */
      const statusOf = new Map(listed);
      const messages = [...started.values()];
      for (const message of messages) {
        if (listed.has(message.runId)) continue;
        const waited = yield* semaphore
          .withPermits(1)(
            ask(row, {
              tool: "studio_thread_wait",
              arguments: { threadId: row.remoteThreadId, runId: message.runId, timeoutMs: 1 },
            }),
          )
          .pipe(Effect.result);
        if (waited._tag === "Failure") {
          // A run that is gone has no result to give.
          if (waited.failure.remoteCode === "run_not_found") {
            statusOf.set(message.runId, "cancelled");
            continue;
          }
          return undefined;
        }
        const status = isRecord(waited.success) ? waited.success.status : undefined;
        if (typeof status !== "string") return undefined;
        statusOf.set(message.runId, status);
        // Only its status is known. The ordinal is a place among the unlisted runs
        // for a stable sort, and says nothing about when it ran.
        runs.push({
          runId: message.runId,
          ordinal: runs.length - messages.length,
          status,
          startedAt: null,
          completedAt: null,
          unlisted: true,
        });
      }
      // The next look starts after the runs at the head of the thread that were
      // only stopped. It never passes a run that completed, failed or is still
      // open: a later pass needs that run to read what followed it.
      let scannedTo = owed.scanFrom ?? -1;
      for (const message of messages) {
        const status = statusOf.get(message.runId);
        if (status === undefined || !endedWithoutResult(status)) break;
        scannedTo = Math.max(scannedTo, message.position);
      }
      return { runs, messages, scannedTo };
    });

  /**
   * How a run that no listing shows stands now. A run the thread does not have
   * reads as cancelled: it has no result to give. Undefined when it could not be asked.
   */
  const statusOfRun = (row: RemoteWorkerStore.RemoteWorkerRecord, runId: string) =>
    Effect.gen(function* () {
      const semaphore = yield* permitFor(row.machineId);
      const waited = yield* semaphore
        .withPermits(1)(
          ask(row, {
            tool: "studio_thread_wait",
            arguments: { threadId: row.remoteThreadId, runId, timeoutMs: 1 },
          }),
        )
        .pipe(Effect.result);
      if (waited._tag === "Failure")
        return waited.failure.remoteCode === "run_not_found" ? "cancelled" : undefined;
      const status = isRecord(waited.success) ? waited.success.status : undefined;
      return typeof status === "string" ? status : undefined;
    });

  /**
   * One look at a handed-off thread that has no run pinned: reports its
   * result, pins the run to wait for, follows it to the machine it was handed
   * on to, or finds nothing yet. Returns what the loop does next.
   */
  const handoffPass = (
    row: RemoteWorkerStore.RemoteWorkerRecord,
    owed: HandoffFollowState,
    answer: Record<string, unknown>,
  ): Effect.Effect<"again" | "later" | "soon" | "done"> =>
    Effect.gen(function* () {
      const page = listedRuns(answer);
      const thread = isRecord(answer.thread) ? answer.thread : {};
      const runCount = typeof thread.runCount === "number" ? thread.runCount : page.length;
      const shown = listedMessages(answer);
      // More runs than it lists, or a listed run whose first message is off the page.
      const partial =
        runCount > page.length ||
        page.some((run) => !shown.some((message) => message.runId === run.runId));
      const older = partial ? yield* olderRuns(row, owed, page) : null;
      if (older === undefined || row.remoteThreadId === null) return "later";
      const runs: Array<ListedRun> = [...(older?.runs ?? []), ...page];
      // The run whose result is owed, by its id: the one pinned, or the thread's first.
      const from =
        owed.runId ??
        page.find((run) => run.ordinal === 1)?.runId ??
        firstRunId(row.remoteThreadId);
      if (runCount > 0 && !runs.some((run) => run.runId === from)) {
        const status = yield* statusOfRun(row, from);
        if (status === undefined) return "later";
        runs.push({
          runId: from,
          ordinal: 0,
          status,
          startedAt: null,
          completedAt: null,
          unlisted: true,
        });
      }
      const step = nextHandoffStep(runs, [...(older?.messages ?? []), ...shown], from);
      // Handed on from there: a run still queued on that copy never starts, and a
      // failure there is the next machine's to continue. Only a result stays.
      const moved = handedOn(answer, row.environmentId);
      const base: HandoffFollowState = {
        ...handoffBase(owed),
        ...(older === null ? {} : { scanFrom: older.scannedTo }),
      };
      /** Writes the row and says whether it was kept; one that cannot be written is asked later. */
      const keep = (change: Partial<RemoteWorkerStore.RemoteWorkerRecord>) =>
        Effect.map(
          update(row.id, () => change),
          (kept) => kept !== undefined,
        );
      /** Says on the row why it waits, once; the thread is asked again either way. */
      const waiting = (reason: string) =>
        row.lastError === reason && owed.awaiting === "run"
          ? Effect.succeed(true)
          : keep({ lastError: reason, handoff: { ...base, awaiting: "run" } });
      const noted = row.lastError === HANDED_ON_NOT_SAID || row.lastError === RESULT_RUN_UNSURE;
      const cleared = noted ? { lastError: null } : {};
      if (step.kind === "report") {
        // Its run is kept before the wake, so the wake's key survives a restart.
        const pinned = yield* keep({
          followedRunId: step.runId,
          lastStatus: step.status,
          handoff: base,
          ...cleared,
        });
        if (!pinned) return "later";
        if (yield* deliver(row, step.runId, step.status)) return "again";
        if (step.status === "failed") yield* watchFallback(row.id);
        return "done";
      }
      if (step.kind === "follow" && moved === undefined) {
        return (yield* keep({
          followedRunId: step.runId,
          lastStatus: step.status,
          handoff: {
            ...base,
            runId: step.pin,
            ...(step.failedRunId === undefined ? {} : { failedRunId: step.failedRunId }),
          },
          ...cleared,
        }))
          ? "again"
          : "later";
      }
      if (moved !== undefined) {
        // Handed on before it finished: the result comes from the machine that runs it now.
        if (moved.epoch === undefined) {
          yield* waiting(HANDED_ON_NOT_SAID);
          return "later";
        }
        let machineId: string | undefined = moved.environmentId === self ? self : undefined;
        if (machineId === undefined) {
          const config = yield* targets.load.pipe(Effect.result);
          // A fleet that could not be read says nothing about who is in it.
          if (config._tag === "Failure") return "later";
          machineId = config.success?.machines.find(
            (entry) => entry.environmentId === moved.environmentId,
          )?.id;
        }
        if (machineId === undefined) {
          yield* update(row.id, () => ({ state: "stopped", lastError: HANDED_ON_OUT_OF_REACH }));
          return "done";
        }
        return (yield* keep({
          machineId,
          environmentId: moved.environmentId,
          remoteProjectId: null,
          remoteThreadId: continuationThreadId(row.environmentId, row.remoteThreadId, moved.epoch),
          followedRunId: null,
          lastStatus: null,
          lastError: null,
          handoff: {
            sourceThreadId: owed.sourceThreadId,
            epoch: owed.epoch,
            awaiting: "continuation",
            hops: (owed.hops ?? 0) + 1,
            ...(owed.woke === undefined ? {} : { woke: owed.woke }),
          },
        }))
          ? "again"
          : "later";
      }
      if (step.kind === "unsure") {
        yield* waiting(RESULT_RUN_UNSURE);
        return "later";
      }
      if (step.kind === "hold") {
        // The other machine's fallback sweep may still continue the failed run.
        const held = owed.held?.runId === step.runId ? owed.held : undefined;
        const since = held === undefined ? yield* now : Date.parse(held.since);
        if ((yield* now) - since >= timings.fallbackGraceMs) {
          const pinned = yield* keep({
            followedRunId: step.runId,
            lastStatus: "failed",
            handoff: { ...base, runId: step.pin },
            ...cleared,
          });
          if (!pinned) return "later";
          if (yield* deliver(row, step.runId, "failed")) return "again";
          yield* watchFallback(row.id);
          return "done";
        }
        if (held === undefined)
          yield* keep({
            lastStatus: "failed",
            handoff: {
              ...base,
              runId: step.pin,
              awaiting: "run",
              held: { runId: step.runId, since: yield* isoNow },
            },
            ...cleared,
          });
        return "soon";
      }
      // The continuation is there with nothing to follow: not started, never finished.
      const lastStatus = runCount === 0 ? "idle" : row.lastStatus;
      if (
        owed.awaiting !== "run" ||
        owed.held !== undefined ||
        row.lastStatus !== lastStatus ||
        owed.scanFrom !== base.scanFrom ||
        noted
      )
        yield* keep({ lastStatus, handoff: { ...base, awaiting: "run" }, ...cleared });
      return "later";
    });

  const followLoop = (rowId: string) =>
    Effect.gen(function* () {
      let backoff = timings.backoffStartMs;
      let failingSince: number | undefined;
      /** How long until a handed-off thread is asked again for its continuation or a run. */
      let awaitPoll = timings.backoffStartMs;
      while (true) {
        const row = yield* findRow(rowId);
        if (!row || row.state !== "following" || row.remoteThreadId === null) return;
        // Once its result is delivered a handed-off thread is followed like any other worker.
        const owed = owesResult(row) ? row.handoff : undefined;
        const awaiting = owed?.awaiting;
        const semaphore = yield* permitFor(row.machineId);
        const result = yield* semaphore
          .withPermits(1)(
            ask(
              row,
              awaiting === undefined
                ? {
                    tool: "studio_thread_wait",
                    arguments: {
                      threadId: row.remoteThreadId,
                      ...(row.followedRunId === null ? {} : { runId: row.followedRunId }),
                      timeoutMs: timings.waitMs,
                    },
                    timeoutMs: timings.waitMs + 15_000,
                  }
                : {
                    // No run to wait on yet: its runs and their messages say what to do.
                    tool: "studio_thread_read",
                    arguments: {
                      threadId: row.remoteThreadId,
                      view: "messages",
                      limit: HANDOFF_ITEM_PAGE,
                      runLimit: HANDOFF_RUN_PAGE,
                      maxCharsPerItem: 1,
                    },
                  },
            ),
          )
          .pipe(Effect.result);
        if (result._tag === "Success") {
          yield* setReachable(row.machineId, true);
          backoff = timings.backoffStartMs;
          failingSince = undefined;
          // Contact is back: a later outage gets its own message.
          if (row.lostContactNotified) yield* update(rowId, () => ({ lostContactNotified: false }));
          const answer = isRecord(result.success) ? result.success : {};
          const status = typeof answer.status === "string" ? answer.status : "idle";
          if (owed !== undefined && awaiting !== undefined) {
            const next = yield* handoffPass(row, owed, answer);
            if (next === "done") return;
            if (next === "again") {
              awaitPoll = timings.backoffStartMs;
              continue;
            }
            yield* Effect.sleep(
              Duration.millis(next === "soon" ? timings.backoffStartMs : awaitPoll),
            );
            if (next === "later") awaitPoll = Math.min(awaitPoll * 2, timings.waitMs);
            continue;
          }
          const runId = typeof answer.runId === "string" ? answer.runId : row.followedRunId;
          if (owed !== undefined && status === "queued" && answer.timedOut === true) {
            // A queued run on a copy that was handed on never starts: look where it runs now.
            const look = yield* semaphore
              .withPermits(1)(
                ask(row, {
                  tool: "studio_thread_read",
                  arguments: {
                    threadId: row.remoteThreadId,
                    view: "messages",
                    limit: 1,
                    runLimit: 1,
                    maxCharsPerItem: 1,
                  },
                }),
              )
              .pipe(Effect.result);
            if (look._tag === "Success" && handedOn(look.success, row.environmentId) !== undefined) {
              yield* update(rowId, (current) => afterHandoffRunEnded(current, status) ?? {});
              continue;
            }
          }
          if (answer.timedOut === true || !isTerminalThreadStatus(status)) {
            // A run still open may be held on a question to the person over there.
            yield* noteWaitingOnYou(row, runId, status);
            if (answer.timedOut !== true)
              yield* Effect.sleep(Duration.millis(timings.backoffStartMs));
            continue;
          }
          if (owed !== undefined) {
            // Its run ended: what that means is read from the thread's runs, the same
            // way whoever saw it end. A run that was only stopped reports nothing.
            const kept = yield* update(rowId, (current) => afterHandoffRunEnded(current, status) ?? {});
            if (kept === undefined) yield* Effect.sleep(Duration.millis(timings.backoffMaxMs));
            continue;
          }
          // A failed run may be followed by the other machine's fallback run; report that one instead.
          const next = status === "failed" ? yield* newerRun(row, runId) : undefined;
          if (next !== undefined) {
            // The caller may have marked the failed run finished itself meanwhile.
            yield* update(rowId, (current) =>
              movedOn(current, runId) || (current.state !== "following" && current.state !== "idle")
                ? {}
                : { state: "following", followedRunId: next },
            );
            continue;
          }
          if (yield* deliver(row, runId, status)) continue;
          return;
        }
        const error = result.failure;
        switch (error.reason) {
          case "not_authorized":
            yield* update(rowId, () => ({ state: "paused_auth", lastError: error.message }));
            return;
          case "identity_mismatch":
          case "unknown_machine":
          case "unsupported":
          case "refused":
            yield* update(rowId, () => ({ state: "stopped", lastError: error.message }));
            return;
          case "tool_failure":
            if (error.remoteCode === "run_not_found" && row.followedRunId !== null) {
              // The thread is there without the run that was followed: its runs say what is.
              yield* setReachable(row.machineId, true);
              const kept = yield* update(
                rowId,
                (current) => afterHandoffRunEnded(current, "idle") ?? { followedRunId: null },
              );
              if (kept === undefined) yield* Effect.sleep(Duration.millis(timings.backoffMaxMs));
              continue;
            }
            if (
              error.remoteCode === "thread_not_found" ||
              /not found|was deleted/iu.test(error.remoteMessage ?? "")
            ) {
              if (awaiting === "continuation") {
                // The takeover that creates it may still be on its way, or its answer lost.
                yield* setReachable(row.machineId, true);
                yield* Effect.sleep(Duration.millis(awaitPoll));
                awaitPoll = Math.min(awaitPoll * 2, timings.backoffMaxMs);
                continue;
              }
              yield* update(rowId, () => ({ state: "stopped", lastError: error.message }));
              return;
            }
            break;
          default:
            break;
        }
        yield* setReachable(row.machineId, false);
        const current = yield* now;
        failingSince ??= current;
        // A continuation never seen is not a worker lost: its takeover may not have arrived.
        if (
          current - failingSince >= timings.lostContactMs &&
          !row.lostContactNotified &&
          awaiting !== "continuation"
        ) {
          yield* notifyLostContact(row, failingSince);
        }
        yield* Effect.sleep(Duration.millis(backoff));
        backoff = Math.min(backoff * 2, timings.backoffMaxMs);
      }
    });

  /** Says once per outage that the machine is gone; a held wake is tried again next pass. */
  const notifyLostContact = (row: RemoteWorkerStore.RemoteWorkerRecord, outage: number) =>
    Effect.gen(function* () {
      if (!row.reportBack || row.remoteThreadId === null) {
        yield* update(row.id, () => ({ lostContactNotified: true }));
        return;
      }
      const outcome = yield* wake(
        row,
        `remote-worker-lost:${row.id}:${outage}`,
        remoteWorkerLost({
          environmentId: row.environmentId,
          remoteThreadId: row.remoteThreadId,
          title: row.title,
          threadRef: formatStudioThreadHref(row.remoteThreadId, row.environmentId),
          machineLabel: yield* machineLabel(row.machineId),
        }),
      );
      if (outcome === "sent") yield* update(row.id, () => ({ lostContactNotified: true }));
      if (outcome === "disposed") yield* update(row.id, () => ({ state: "disposed" }));
      if (outcome === "transferred")
        yield* update(row.id, () => ({ state: "stopped", lastError: TRANSFERRED_MESSAGE }));
    });

  const follow: RemoteWorkerFollower["Service"]["follow"] = (rowId) =>
    exclusive(`follow:${rowId}`, followLoop(rowId));

  /**
   * A row reported failed before fallback runs were followed: picks up the
   * run the other machine started after it, so its card shows how it ended.
   */
  const recheckFailed = (rowId: string) =>
    exclusive(
      `recheck:${rowId}`,
      Effect.gen(function* () {
        const row = yield* findRow(rowId);
        if (!row || row.state !== "idle" || row.lastStatus !== "failed") return;
        if (row.handoff !== undefined) {
          yield* watchFallback(rowId);
          return;
        }
        const next = yield* newerRun(row, row.followedRunId, 0);
        if (next === undefined || row.deliveredRunIds.includes(next)) return;
        const moved = yield* update(rowId, (current) =>
          current.state === "idle" && current.lastStatus === "failed"
            ? { state: "following", followedRunId: next }
            : {},
        );
        if (moved?.state === "following") yield* follow(rowId);
      }),
    );

  /**
   * A handed-off thread whose failure was reported is followed again only when
   * the other machine itself continued that failed run. Any other later run
   * there is someone's own message, and its launcher is not told about it.
   */
  const reopenForFallback = (
    row: RemoteWorkerStore.RemoteWorkerRecord,
    handoff: HandoffFollowState,
  ) =>
    Effect.gen(function* () {
      const failedRunId = handoff.resultRunId;
      if (failedRunId === undefined || row.remoteThreadId === null) return;
      const read = yield* ask(row, {
          tool: "studio_thread_read",
          arguments: {
            threadId: row.remoteThreadId,
            view: "messages",
            limit: HANDOFF_ITEM_PAGE,
            runLimit: HANDOFF_RUN_PAGE,
            maxCharsPerItem: 1,
          },
        }).pipe(Effect.result);
      if (read._tag === "Failure") return;
      const runs = listedRuns(read.success);
      const failed = runs.find((run) => run.runId === failedRunId);
      if (failed === undefined || failed.status !== "failed") return;
      const step = nextHandoffStep(runs, listedMessages(read.success), failedRunId);
      const continued =
        (step.kind === "follow" && step.failedRunId !== undefined) ||
        (step.kind === "report" && step.runId !== failedRunId);
      if (!continued) return;
      const moved = yield* update(row.id, (current) =>
        current.state === "idle" && current.handoff?.resultRunId === failedRunId
          ? {
              state: "following",
              followedRunId: null,
              // Still owed how it ends, for the card; its one message was sent, by
              // this release or by one that kept no mark of it.
              handoff: {
                ...handoffBase(current.handoff),
                runId: failedRunId,
                awaiting: "run",
                woke: current.handoff.woke ?? { at: current.updatedAt, key: failedRunId },
              },
            }
          : {},
      );
      if (moved?.state === "following") yield* follow(row.id);
    });

  /**
   * After a handoff's failure was reported: looks, for as long as failed rows
   * are checked again, whether the other machine itself continued that run, so
   * the card shows how the work ended. It sends nothing: the launcher was told.
   */
  const watchFallback = (rowId: string): Effect.Effect<void> =>
    exclusive(
      `fallback:${rowId}`,
      Effect.gen(function* () {
        // Asked less often as time passes: a continuation comes soon or not at all.
        let pause = timings.waitMs;
        while (true) {
          const row = yield* findRow(rowId);
          if (!row || row.state !== "idle" || row.lastStatus !== "failed") return;
          if (row.handoff === undefined) return;
          const since = Date.parse(row.handoff.woke?.at ?? row.updatedAt);
          if ((yield* now) - since >= timings.recheckFailedWithinMs) return;
          yield* reopenForFallback(row, row.handoff);
          yield* Effect.sleep(Duration.millis(pause));
          pause = Math.min(pause * 2, FALLBACK_WATCH_MAX_MS);
        }
      }),
    );

  /**
   * The threads on the row's machine that carry its launch's fingerprint, created after it
   * started (and before `until`, when given). Undefined when there is no project to look in.
   */
  const launchMatches = (row: RemoteWorkerStore.RemoteWorkerRecord, until?: number) =>
    Effect.gen(function* () {
      if (row.remoteProjectId === null) return undefined;
      const listed = yield* client.call({
        machineId: row.machineId,
        tool: "studio_thread_list",
        arguments: {
          projectId: row.remoteProjectId,
          // The filter is capped; the exact title is compared below.
          ...(row.title.slice(0, 256).trim() === ""
            ? {}
            : { titleContains: row.title.slice(0, 256).trim() }),
          limit: 50,
        },
      });
      const since = Date.parse(row.launchStartedAt) - 5_000;
      const found = (isRecord(listed) && Array.isArray(listed.threads) ? listed.threads : [])
        .filter(isRecord)
        .filter(
          (thread) =>
            thread.title === row.title &&
            thread.createdBy === "agent" &&
            thread.creationSource === "mcp" &&
            typeof thread.createdAt === "string" &&
            Date.parse(thread.createdAt) >= since &&
            (until === undefined || Date.parse(thread.createdAt) <= until) &&
            typeof thread.threadId === "string",
        );
      return found.map((thread): ReconciledLaunch => ({
        threadId: thread.threadId as string,
        runId: typeof thread.latestRunId === "string" ? thread.latestRunId : null,
        status: typeof thread.status === "string" ? thread.status : "idle",
        providerInstanceId:
          typeof thread.providerInstanceId === "string" ? thread.providerInstanceId : null,
        model: typeof thread.model === "string" ? thread.model : null,
      }));
    });

  const reconcile: RemoteWorkerFollower["Service"]["reconcile"] = (row) =>
    launchMatches(row).pipe(Effect.map((found) => (found?.length === 1 ? found[0] : undefined)));

  const lastUnconfirmedCheck = new Map<string, number>();

  /**
   * Looks again for the thread of a start never confirmed, once its machine answers: it is
   * followed when found, and closed when that machine has no such thread. Without this the
   * row read "didn't confirm the start" in the Threads pane until it was pruned a month later.
   */
  const recheckUnconfirmed = (rowId: string) =>
    exclusive(
      `reconcile:${rowId}`,
      Effect.gen(function* () {
        const row = yield* findRow(rowId);
        if (!row || row.state !== "launch_unknown") return;
        // The thread a launch made exists before this server gave up on it; 5s for clock skew.
        const matches = yield* launchMatches(row, Date.parse(row.updatedAt) + 5_000).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        // Unreachable still, or nowhere to look; two matches are for a person to tell apart.
        if (matches === undefined || matches.length > 1) return;
        const rows = yield* store.list.pipe(Effect.orElseSucceed(() => []));
        const current = rows.find((candidate) => candidate.id === rowId);
        if (!current || current.state !== "launch_unknown") return;
        const found = matches[0];
        if (found === undefined) {
          const label = yield* machineLabel(row.machineId);
          yield* update(rowId, () => ({
            state: "disposed",
            lastError: `${label} has no thread from this start, so it never began.`,
          }));
          return;
        }
        // The coordinator found it and adopted or relaunched it: another row follows it.
        if (
          rows.some(
            (other) =>
              other.id !== rowId &&
              other.machineId === row.machineId &&
              other.remoteThreadId === found.threadId,
          )
        ) {
          yield* update(rowId, () => ({ state: "disposed" }));
          return;
        }
        yield* update(rowId, () => ({
          state: "following",
          remoteThreadId: found.threadId,
          followedRunId: found.runId,
          lastStatus: found.status,
          lastError: null,
        }));
        yield* follow(rowId);
      }),
    );

  /** Settles a launch this server stopped hearing about mid-way. */
  const reconcileStale = (rowId: string) =>
    exclusive(
      `reconcile:${rowId}`,
      Effect.gen(function* () {
        const row = yield* findRow(rowId);
        if (!row || row.state !== "launching") return;
        const age = (yield* now) - Date.parse(row.launchStartedAt);
        if (age < timings.launchStaleMs)
          yield* Effect.sleep(Duration.millis(timings.launchStaleMs - age));
        const current = yield* findRow(rowId);
        if (!current || current.state !== "launching") return;
        const found = yield* reconcile(current).pipe(Effect.orElseSucceed(() => undefined));
        if (found === undefined) {
          yield* update(rowId, () => ({
            state: "launch_unknown",
            lastError: "This server restarted while the launch was in flight.",
          }));
          return;
        }
        yield* update(rowId, () => ({
          state: "following",
          remoteThreadId: found.threadId,
          followedRunId: found.runId,
          lastStatus: found.status,
        }));
        yield* follow(rowId);
      }),
    );

  const trackLaunch: RemoteWorkerFollower["Service"]["trackLaunch"] = (rowId) => (effect) =>
    Ref.update(launching, (current) => new Set(current).add(rowId)).pipe(
      Effect.andThen(effect),
      Effect.onInterrupt(() => reconcileStale(rowId)),
      Effect.ensuring(
        Ref.update(launching, (current) => {
          const next = new Set(current);
          next.delete(rowId);
          return next;
        }),
      ),
    );

  /**
   * Resumes rows parked on a revoked or expired grant once the user allows
   * workers again, and settles launches nothing here is carrying out anymore.
   */
  const authSupervisor = Effect.gen(function* () {
    const rows = yield* store.list.pipe(Effect.orElseSucceed(() => []));
    const inFlight = yield* Ref.get(launching);
    const current = yield* now;
    for (const row of rows) {
      if (
        row.state === "launching" &&
        !inFlight.has(row.id) &&
        current - Date.parse(row.launchStartedAt) >= timings.launchStaleMs
      )
        yield* reconcileStale(row.id);
      if (
        row.state === "launch_unknown" &&
        current - (lastUnconfirmedCheck.get(row.id) ?? Date.parse(row.updatedAt)) >=
          timings.recheckUnconfirmedMs
      ) {
        lastUnconfirmedCheck.set(row.id, current);
        yield* recheckUnconfirmed(row.id);
      }
    }
    for (const row of rows.filter((candidate) => candidate.state === "paused_auth")) {
      const workers = yield* grants.status(row.machineId);
      if (workers.status === "allowed" || workers.status === "expiring") {
        yield* client.forget(row.machineId);
        yield* update(row.id, () => ({ state: "following", lastError: null }));
        yield* follow(row.id);
      }
    }
  });

  /**
   * Sends a recent wake again under its own command id. The orchestrator
   * replays a command it already handled, so this only adds the wake when
   * the database lost it, as when an update rolled back and restored the
   * database from before the wake while this file kept saying it was sent.
   */
  const redeliver = (row: RemoteWorkerStore.RemoteWorkerRecord) =>
    Effect.gen(function* () {
      // Only a wake this server queued itself; a run the caller saw finish had none.
      const key = row.lastWakeRunId;
      if (key === undefined || key === null || !row.reportBack || row.remoteThreadId === null)
        return;
      yield* wake(row, wakeId(row, key), yield* wakeMessage(row, row.lastStatus ?? "finished"));
    });

  const resume: RemoteWorkerFollower["Service"]["resume"] = Effect.gen(function* () {
    yield* store.prune(yield* now).pipe(Effect.ignore);
    const rows = yield* store.list.pipe(Effect.orElseSucceed(() => []));
    const current = yield* now;
    for (const row of rows) {
      if (row.state === "following") yield* follow(row.id);
      else if (row.state === "wake_pending") yield* retryWake(row.id);
      else if (row.state === "launching") yield* reconcileStale(row.id);
      else if (
        row.state === "idle" &&
        current - Date.parse(row.updatedAt) < timings.redeliverWithinMs
      )
        yield* redeliver(row);
      if (
        row.state === "idle" &&
        row.lastStatus === "failed" &&
        current - Date.parse(row.updatedAt) < timings.recheckFailedWithinMs
      )
        yield* recheckFailed(row.id);
    }
    yield* authSupervisor.pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(timings.authPollMs))),
      Effect.forkIn(scope),
    );
    yield* store
      .prune(yield* now)
      .pipe(Effect.ignore, Effect.repeat(Schedule.spaced(Duration.days(1))), Effect.forkIn(scope));
  });

  return RemoteWorkerFollower.of({
    follow,
    reconcile,
    reachable: (machineId) =>
      Ref.get(reachability).pipe(Effect.map((current) => current.get(machineId) ?? true)),
    trackLaunch,
    resume,
  });
});

export const layer = Layer.effect(RemoteWorkerFollower, make);

/** Picks up rows left by the previous run of this server. */
export const layerResume = Layer.effectDiscard(
  RemoteWorkerFollower.pipe(Effect.flatMap((follower) => follower.resume)),
);
