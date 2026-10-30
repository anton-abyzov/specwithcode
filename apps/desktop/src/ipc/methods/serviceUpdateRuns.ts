import {
  type StudioServiceUpdateRun,
  type StudioServiceUpdateRunAction,
  StudioServiceUpdateRunActionSchema,
  type StudioServiceUpdateRunResult,
  StudioServiceUpdateRunResultSchema,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A run id is a random UUID, made once per Update now press.
import * as NodeCrypto from "node:crypto";

import * as DesktopObservability from "../../app/DesktopObservability.ts";
import type {
  ServiceAgentConfigChange,
  ServiceUpdateController,
} from "../../updates/studioServiceUpdates.ts";
import {
  configNamesRun,
  createRun,
  INSTALL_MARKER_FILE,
  INSTALL_PROGRESS_FILE,
  isoAt,
  isoMillis,
  isValidRunId,
  parseInstallProgress,
  preparingAbandoned,
  readRun,
  readRunApp,
  readRunView,
  type RunFiles,
  runIsTerminal,
  serviceReachedTarget,
  shouldExpire,
  shouldRekick,
  transitionRun,
  type UpdateRunRecord,
  writeRunApp,
} from "../../updates/updateRun.ts";
import { markRestartStep } from "../../updates/restartTrace.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

/**
 * The main process's side of an Update now run (updates/run.json, 0988):
 * `begin` creates it once (O_EXCL), the install request moves it from
 * `preparing` to `requested` and names it to the agent, and a 2-second loop
 * while it is live publishes it to every window, kicks the agent again when
 * the lease lapsed, expires an ownerless run long past its deadline, and runs
 * the app follow-up once the service is verified. Main ends a run only while
 * nobody owns it: a `preparing` run whose window went away, an install
 * request that could not be written or handed to the agent, a run whose
 * target the service already runs, and an ownerless run long past its
 * deadline. A run the agent owns ends only by the agent.
 */

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger("service-update-runs");

/** How often main looks at a live run: publish, re-kick, expire, app follow-up. */
export const RUN_POLL_INTERVAL = Duration.seconds(2);
export const RUN_EXPIRED_MESSAGE =
  "The update stopped without finishing and nothing is installing it. Try again.";
export const RUN_CANCELLED_MESSAGE = "Update cancelled";
export const RUN_ABANDONED_MESSAGE =
  "The window that started the update closed before it asked for the install. Try again.";
export const runReachedMessage = (version: string) => `The service runs SpecWithCode ${version}.`;

/** The config change that withdraws a request: it never installs later on its own. */
const withdrawRequest = (at: string): ServiceAgentConfigChange => ({
  installRequestedAt: null,
  installCancelledAt: at,
  installMode: "normal",
  installHoldUntil: null,
  installRequest: null,
  installRunId: null,
});

/** The app half of a run: installed by main once the service is verified (T-04). */
export interface RunFollowUp {
  /** Called on every tick while a verified run still has its app to install. */
  readonly advance: (run: UpdateRunRecord) => Effect.Effect<void>;
  /** "Restart now": install the app again, on the same run. */
  readonly retry: (run: UpdateRunRecord) => Effect.Effect<void>;
}

export interface ServiceUpdateRunsDeps {
  readonly controller: Effect.Effect<ServiceUpdateController>;
  /** Sends every window the current state; a failure only skips one send. */
  readonly publish: Effect.Effect<unknown, Schema.SchemaError>;
  /** Kicks the update agent (refresh then kickstart) in the background. */
  readonly kick: (reason: string) => Effect.Effect<void>;
  /** Writes the agent's config.json with this change; false when it could not. */
  readonly writeConfig: (change: ServiceAgentConfigChange) => Effect.Effect<boolean>;
  readonly followUp?: RunFollowUp;
  /**
   * The app release a new run installs after the service when its window
   * named none (DesktopUpdates.appTargetForRun): a window that has not yet
   * heard of the app's update would otherwise leave the app to a later quit.
   * Kept only when it is the run's own release.
   */
  readonly appTarget?: Effect.Effect<string | null>;
  /** A fresh run id; random UUIDs outside tests. */
  readonly newRunId?: () => string;
  /**
   * On every look: the app release the live run installs after its service,
   * or null, so the app stages that download as soon as its gate opens
   * (DesktopUpdates.stageForRun).
   */
  readonly stageApp?: (version: string | null) => Effect.Effect<void>;
}

const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);

function filesOf(controller: ServiceUpdateController): RunFiles | null {
  return controller.installation() === null ? null : controller.runFiles();
}

export function makeServiceUpdateRuns(deps: ServiceUpdateRunsDeps) {
  const newRunId = deps.newRunId ?? (() => NodeCrypto.randomUUID());
  // One creation at a time in this process; O_EXCL covers any other writer.
  const creating = Semaphore.makeUnsafe(1);
  let lastKickMs: number | null = null;
  // The run whose verified service this process already marked for the press trace.
  let verifiedMarked: string | null = null;
  // Runs made by this process, and when it first looked: a `preparing` run
  // from before then lost its window with the process that made it.
  const madeHere = new Set<string>();
  let processStartedMs: number | null = null;
  const started = Effect.map(nowMillis, (nowMs) => {
    processStartedMs ??= nowMs;
    return nowMs;
  });
  const publish = deps.publish.pipe(Effect.catchCause(() => Effect.void));

  const view = (files: RunFiles) => Effect.map(nowMillis, (nowMs) => readRunView(files, nowMs));

  const result = (
    supported: boolean,
    created: boolean,
    run: StudioServiceUpdateRun | null,
  ): StudioServiceUpdateRunResult => ({ supported, created, run });

  /** Ends a `preparing` run whose window went away; nothing else would ever request it. */
  const endAbandoned = (files: RunFiles, nowMs: number) =>
    Effect.gen(function* () {
      const run = readRun(files);
      if (
        run === null ||
        !preparingAbandoned({
          run,
          nowMs,
          processStartedMs,
          madeHere: madeHere.has(run.runId),
        })
      ) {
        return null;
      }
      const at = isoAt(nowMs);
      const ended = transitionRun(files, run.runId, (current) =>
        current.phase === "preparing" && current.owner === null && current.requestedAt === null
          ? {
              ...current,
              phase: "expired",
              message: RUN_ABANDONED_MESSAGE,
              endedAt: at,
              leaseUntil: at,
            }
          : null,
      );
      if (ended !== null) {
        yield* logWarning("update run never requested; its window went away", {
          runId: run.runId,
        });
      }
      return ended;
    });

  const begin = (targetVersion: string, windowAppTarget: string | null) =>
    creating.withPermits(1)(
      Effect.gen(function* () {
        const controller = yield* deps.controller;
        const files = filesOf(controller);
        if (files === null) return result(false, false, null);
        yield* endAbandoned(files, yield* started);
        // A run going on is followed, even when the agent stopped advertising runs since.
        const current = yield* view(files);
        if (current !== null && !current.terminal) return result(true, false, current);
        if (!controller.runSupported()) return result(false, false, null);
        const desktopAppTarget =
          windowAppTarget !== null || deps.appTarget === undefined ? null : yield* deps.appTarget;
        // Only the run's own release: a newer app would wait for a service the
        // agent does not install, and an older cached one may be gone from the
        // feed. Either way the app half would fail; the app updates on its own.
        const appTargetVersion =
          windowAppTarget ?? (desktopAppTarget === targetVersion ? desktopAppTarget : null);
        if (desktopAppTarget !== null && appTargetVersion === null) {
          yield* logInfo("update run leaves the app release to the app", {
            targetVersion,
            appRelease: desktopAppTarget,
          });
        }
        const nowMs = yield* nowMillis;
        const progress = parseInstallProgress(files.read(INSTALL_PROGRESS_FILE));
        const made = createRun(files, {
          runId: newRunId(),
          nowMs,
          targetVersion,
          fromVersion: controller.readState().installedVersion,
          appTargetVersion,
          expectedMs: progress?.expectedMs ?? null,
        });
        if (made.created) {
          madeHere.add(made.run.runId);
          yield* logInfo("update run created", {
            runId: made.run.runId,
            targetVersion,
            appTargetVersion,
            appTargetFrom: windowAppTarget !== null ? "window" : "desktop",
            deadlineAt: made.run.deadlineAt,
          });
        }
        yield* publish;
        return result(true, made.created, yield* view(files));
      }),
    );

  /**
   * The install request of `runId`: moves it from `preparing` to `requested`.
   * Returns the config change that names the run to the agent, with the run's
   * deadline as the hold, or null when the run is gone or past preparing.
   */
  const request = (runId: unknown, at: string) =>
    Effect.gen(function* () {
      if (!isValidRunId(runId)) return null;
      const files = filesOf(yield* deps.controller);
      if (files === null) return null;
      const moved = transitionRun(files, runId, (run) =>
        run.phase === "preparing" ? { ...run, phase: "requested", requestedAt: at } : null,
      );
      if (moved === null) return null;
      return {
        installRunId: moved.runId,
        installHoldUntil: moved.deadlineAt,
      } satisfies ServiceAgentConfigChange;
    });

  /**
   * Ends a run nobody has claimed: cancelled, or failed with `failure` (its
   * install request could not be written or handed to the agent). A claimed
   * one ends when its agent reads the cancel.
   */
  const cancelUnclaimed = (
    files: RunFiles,
    runId: string | null,
    at: string,
    failure: string | null = null,
  ) =>
    Effect.sync(() => {
      const current = readRun(files);
      if (current === null || (runId !== null && current.runId !== runId)) return null;
      return transitionRun(files, current.runId, (run) =>
        run.owner === null && (run.phase === "preparing" || run.phase === "requested")
          ? {
              ...run,
              phase: failure === null ? "cancelled" : "failed",
              message: failure ?? RUN_CANCELLED_MESSAGE,
              endedAt: at,
              leaseUntil: at,
            }
          : null,
      );
    });

  /**
   * Withdraws the run's request from config.json, only while config.json
   * still asks for it: a newer request (the fleet, the CLI) is left alone.
   */
  const withdrawIfNamed = (files: RunFiles, run: UpdateRunRecord, at: string) =>
    configNamesRun(files, run) ? deps.writeConfig(withdrawRequest(at)) : Effect.succeed(false);

  const cancel = (runId: string, reason: string | null = null) =>
    Effect.gen(function* () {
      const controller = yield* deps.controller;
      const files = filesOf(controller);
      if (files === null) return result(false, false, null);
      const at = isoAt(yield* nowMillis);
      const run = readRun(files);
      if (run !== null && run.runId === runId) {
        // The agent reads a cancel from its config, whether or not it holds the run.
        yield* withdrawIfNamed(files, run, at);
      }
      yield* cancelUnclaimed(files, runId, at, reason);
      yield* publish;
      return result(true, false, yield* view(files));
    });

  /**
   * The install request of `runId` was not written, or no agent could be
   * started for it: the run has no owner and never will, so it fails now with
   * `message` instead of waiting out its deadline.
   */
  const failRequest = (runId: string, message: string) =>
    Effect.gen(function* () {
      const files = filesOf(yield* deps.controller);
      if (files === null) return null;
      const at = isoAt(yield* nowMillis);
      const run = readRun(files);
      if (run === null || run.runId !== runId) return null;
      yield* withdrawIfNamed(files, run, at);
      const ended = yield* cancelUnclaimed(files, runId, at, message);
      if (ended !== null) {
        yield* logWarning("update run failed before the agent took it", { runId, message });
      }
      return ended;
    });

  const acknowledge = (runId: string) =>
    Effect.gen(function* () {
      const files = filesOf(yield* deps.controller);
      if (files === null) return result(false, false, null);
      const app = readRunApp(files);
      if (app !== null && app.runId === runId && app.reportedAt === null) {
        writeRunApp(files, { ...app, reportedAt: isoAt(yield* nowMillis) });
      }
      return result(true, false, yield* view(files));
    });

  const retryApp = (runId: string) =>
    Effect.gen(function* () {
      const files = filesOf(yield* deps.controller);
      if (files === null) return result(false, false, null);
      const run = readRun(files);
      if (run !== null && run.runId === runId && deps.followUp !== undefined) {
        yield* deps.followUp.retry(run);
      }
      yield* publish;
      return result(true, false, yield* view(files));
    });

  const handle = (action: StudioServiceUpdateRunAction) => {
    switch (action.type) {
      case "begin":
        return begin(action.targetVersion, action.appTargetVersion);
      case "acknowledge":
        return acknowledge(action.runId);
      case "retry-app":
        return retryApp(action.runId);
      case "cancel":
        return cancel(action.runId, action.reason ?? null);
    }
  };

  /**
   * One look at the run. Returns whether it is live, so the loop keeps
   * publishing every 2 seconds only while a window has something to follow.
   */
  const tick = Effect.gen(function* () {
    const controller = yield* deps.controller;
    const files = filesOf(controller);
    if (files === null) return false;
    const nowMs = yield* started;
    yield* endAbandoned(files, nowMs);
    const run = readRun(files);
    if (run === null) return false;
    const progress = parseInstallProgress(files.read(INSTALL_PROGRESS_FILE));
    const markerPresent = files.read(INSTALL_MARKER_FILE) !== null;
    if (
      serviceReachedTarget({
        run,
        installedVersion: controller.readState().installedVersion,
        progress,
        markerPresent,
        nowMs,
      })
    ) {
      // The install finished after its agent pass let go of the run, or under
      // a request the fleet or the CLI wrote: it is not a failure.
      const at = isoAt(nowMs);
      const ended = transitionRun(files, run.runId, (current) =>
        current.owner === null || (isoMillis(current.leaseUntil) ?? 0) <= nowMs
          ? {
              ...current,
              phase: "verified",
              owner: null,
              message: runReachedMessage(current.targetVersion),
              endedAt: at,
              leaseUntil: at,
            }
          : null,
      );
      if (ended !== null) {
        yield* logInfo("update run verified: the service runs its target", { runId: run.runId });
      }
    } else if (
      shouldExpire({
        run,
        progress,
        markerPresent,
        nowMs,
      })
    ) {
      const at = isoAt(nowMs);
      const ended = transitionRun(files, run.runId, (current) =>
        current.owner === null || (isoMillis(current.leaseUntil) ?? 0) <= nowMs
          ? {
              ...current,
              phase: "expired",
              owner: null,
              message: RUN_EXPIRED_MESSAGE,
              endedAt: at,
            }
          : null,
      );
      if (ended !== null) {
        yield* logWarning("update run expired without an owner", { runId: run.runId });
        // Its request must never install later on its own; a newer one is not its to withdraw.
        yield* withdrawIfNamed(files, run, at);
      }
    } else if (shouldRekick({ run, nowMs, lastKickMs })) {
      lastKickMs = nowMs;
      yield* logInfo("update run lease lapsed; asking the agent again", { runId: run.runId });
      yield* deps.kick("update run lease lapsed");
    }
    const latest = readRun(files) ?? run;
    if (latest.phase === "verified" && verifiedMarked !== latest.runId) {
      verifiedMarked = latest.runId;
      yield* markRestartStep("verified-observed", { detail: latest.runId });
    }
    if (
      latest.phase === "verified" &&
      latest.appTargetVersion !== null &&
      deps.followUp !== undefined
    ) {
      yield* deps.followUp.advance(latest);
    }
    const live = !runIsTerminal(readRun(files) ?? latest, readRunApp(files));
    if (deps.stageApp !== undefined) {
      yield* deps.stageApp(live ? latest.appTargetVersion : null);
    }
    return live;
  }).pipe(
    Effect.catchCause((cause) =>
      logWarning("update run check failed", { cause: String(cause) }).pipe(Effect.as(false)),
    ),
  );

  return {
    begin,
    request,
    cancel,
    cancelUnclaimed,
    failRequest,
    acknowledge,
    retryApp,
    handle,
    tick,
  };
}

export type ServiceUpdateRuns = ReturnType<typeof makeServiceUpdateRuns>;

/** Registers the run channel and the 2-second loop that follows a live run. */
export const installServiceUpdateRuns = Effect.fn("desktop.ipc.installServiceUpdateRuns")(
  function* (runs: ServiceUpdateRuns, publishState: Effect.Effect<unknown, Schema.SchemaError>) {
    const ipc = yield* DesktopIpc.DesktopIpc;
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: IpcChannels.SERVICE_UPDATE_RUN_CHANNEL,
        payload: StudioServiceUpdateRunActionSchema,
        result: StudioServiceUpdateRunResultSchema,
        handler: (action) => runs.handle(action),
      }),
    );
    let wasLive = false;
    yield* Effect.gen(function* () {
      const live = yield* runs.tick;
      // One more publish when a run ends, so every window sees its outcome now.
      if (live || wasLive) yield* publishState.pipe(Effect.catchCause(() => Effect.void));
      wasLive = live;
    }).pipe(
      Effect.andThen(Effect.sleep(RUN_POLL_INTERVAL)),
      Effect.forever,
      Effect.ignoreCause,
      Effect.forkScoped,
    );
  },
);
