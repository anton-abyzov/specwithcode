import * as DateTime from "effect/DateTime";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  projectExecutionIsFenced,
  ThreadId,
} from "@specweave-studio/contracts";
import {
  formatStudioThreadHref,
  studioThreadLinkLabel,
} from "@specweave-studio/shared/studioThreadLinks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as FleetTargets from "./FleetTargets.ts";
import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";
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
export function remoteWorkerWaitingOnYou(input: {
  readonly title: string;
  readonly threadRef: string;
  readonly machineLabel: string;
}): { readonly text: string; readonly notification: OrchestrationV2Notification } {
  const link = `[${studioThreadLinkLabel(input.title.slice(0, 200), "worker")}](${input.threadRef})`;
  return {
    text: `Remote worker ${link} on ${input.machineLabel} is waiting on the user: its run asked for an answer, a sign-in or an approval there. Tell the user; they answer it in that thread. You are woken again when its run finishes.`,
    notification: {
      source: { kind: "background_task" },
      outcome: "unknown",
      summary: `${link} on ${input.machineLabel} is waiting on you.`,
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

const make = Effect.gen(function* () {
  const store = yield* RemoteWorkerStore.RemoteWorkerStore;
  const client = yield* RemoteStudioMcpClient.RemoteStudioMcpClient;
  const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
  const targets = yield* FleetTargets.FleetTargets;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const timings = yield* RemoteWorkerFollowerTimings;
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

  const setReachable = (machineId: string, value: boolean) =>
    Ref.update(reachability, (current) => new Map(current).set(machineId, value));

  const machineLabel = (machineId: string) =>
    targets.load.pipe(
      Effect.map(
        (config) =>
          config?.machines.find((machine) => machine.id === machineId)?.label ?? machineId,
      ),
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

  const wakeId = (row: RemoteWorkerStore.RemoteWorkerRecord, key: string) =>
    `remote-worker-wake:${row.id}:${key}`;

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
          client.call({
            machineId: row.machineId,
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
          title: row.title,
          threadRef: formatStudioThreadHref(row.remoteThreadId, row.environmentId),
          machineLabel: yield* machineLabel(row.machineId),
        }),
      );
    });

  const wakeMessage = (row: RemoteWorkerStore.RemoteWorkerRecord, status: string) =>
    Effect.map(machineLabel(row.machineId), (label) =>
      remoteWorkerWake({
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

  const delivered = (row: RemoteWorkerStore.RemoteWorkerRecord, key: string) =>
    row.deliveredRunIds.includes(key)
      ? row.deliveredRunIds
      : [...row.deliveredRunIds, key].slice(-50);

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
      });
      if (row.deliveredRunIds.includes(key) || !row.reportBack || row.remoteThreadId === null) {
        const next = yield* update(row.id, settled);
        return next?.state === "following";
      }
      const outcome = yield* wake(row, wakeId(row, key), yield* wakeMessage(row, status));
      if (outcome === "sent") {
        const next = yield* update(row.id, (current) => ({
          ...settled(current),
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
            yield* update(rowId, (current) => ({
              state: "idle",
              lastError: null,
              lastWakeRunId: key,
              deliveredRunIds: delivered(current, key),
            }));
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

  const followLoop = (rowId: string) =>
    Effect.gen(function* () {
      let backoff = timings.backoffStartMs;
      let failingSince: number | undefined;
      while (true) {
        const row = yield* findRow(rowId);
        if (!row || row.state !== "following" || row.remoteThreadId === null) return;
        const semaphore = yield* permitFor(row.machineId);
        const result = yield* semaphore
          .withPermits(1)(
            client.call({
              machineId: row.machineId,
              tool: "studio_thread_wait",
              arguments: {
                threadId: row.remoteThreadId,
                ...(row.followedRunId === null ? {} : { runId: row.followedRunId }),
                timeoutMs: timings.waitMs,
              },
              timeoutMs: timings.waitMs + 15_000,
            }),
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
          const runId = typeof answer.runId === "string" ? answer.runId : row.followedRunId;
          if (answer.timedOut === true || !isTerminalThreadStatus(status)) {
            // A run still open may be held on a question to the person over there.
            yield* noteWaitingOnYou(row, runId, status);
            if (answer.timedOut !== true)
              yield* Effect.sleep(Duration.millis(timings.backoffStartMs));
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
            if (
              error.remoteCode === "thread_not_found" ||
              /not found|was deleted/iu.test(error.remoteMessage ?? "")
            ) {
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
        if (current - failingSince >= timings.lostContactMs && !row.lostContactNotified) {
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

  const reconcile: RemoteWorkerFollower["Service"]["reconcile"] = (row) =>
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
            typeof thread.threadId === "string",
        );
      if (found.length !== 1) return undefined;
      const thread = found[0]!;
      return {
        threadId: thread.threadId as string,
        runId: typeof thread.latestRunId === "string" ? thread.latestRunId : null,
        status: typeof thread.status === "string" ? thread.status : "idle",
        providerInstanceId:
          typeof thread.providerInstanceId === "string" ? thread.providerInstanceId : null,
        model: typeof thread.model === "string" ? thread.model : null,
      };
    });

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
