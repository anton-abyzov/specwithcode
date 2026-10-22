import { projectExecutionIsFenced } from "@specweave-studio/contracts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Option from "effect/Option";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
  type ThreadId,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { limitStopWaitsForReset } from "@specweave-studio/shared/providerFallback";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Availability from "./UsageLimitAvailability.ts";
import { MachineLimitHandoff } from "./MachineLimitHandoff.ts";
import { isBlockingRuntimeRequest, withPendingRequestDetail } from "./blockingRuntimeRequest.ts";
import {
  LIMIT_CHECK_INTERVAL_MS,
  LIMIT_REARM_MAX,
  derivedLimitResumeAt,
  hasFreshLimitPermission,
  hasValidLimitReset,
  isLimitRecoveryCandidate,
  limitChainSuffix,
  limitReadShowsRoom,
  limitStopMs,
  nextLimitChainAttempt,
  recoverySnoozeBlocks,
} from "./usageLimitRecovery.ts";

/**
 * New limit stops arm auto-resume when the project or the global setting asks
 * for it. Every project stores `autoResume: false` by default, so letting the
 * project value win made the global setting a no-op.
 */
export function autoResumeByDefault(
  projectAutoResume: boolean | undefined,
  preferences: { readonly autoResumeLimitedThreads: boolean },
): boolean {
  return projectAutoResume === true || preferences.autoResumeLimitedThreads;
}

/**
 * The persisted run and reset form the identity of one recovery opportunity.
 * A stop with no usable reset, or one that came back in the window an earlier
 * resume already used, resumes only on `derivedRoom`: a provider read taken
 * after the stop that shows room (see `derivedLimitResumeAt`). Such resumes
 * back off and stop after LIMIT_REARM_MAX re-arms, so a limit that keeps
 * coming back is left for the person instead of looping.
 */
export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
  derivedRoom = false,
): OrchestrationV2ServerCommand | null {
  if (!isLimitRecoveryCandidate(thread) || !thread.latestRunId) return null;
  const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
  const validReset = hasValidLimitReset(thread);
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (
    recovery?.runId !== thread.latestRunId ||
    recovery.resetAt !== (thread.usageLimitResetAt ?? null)
  ) {
    const attempt = nextLimitChainAttempt(thread);
    const derived = !validReset || attempt > 0;
    // A snooze alone lasts until a known reset; it never re-arms a repeat.
    if (attempt > LIMIT_REARM_MAX || (!autoResume && (derived || !snooze || resetMs <= nowMs)))
      return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(
        `limit-arm:${identity}${derived ? limitChainSuffix(attempt, limitStopMs(thread)) : ""}`,
      ),
      threadId: thread.id,
      limitRecoveryPolicyArm: true,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt ?? null,
        autoResume,
        snooze: snooze && !derived && resetMs > nowMs,
      },
    };
  }
  const permitted = hasFreshLimitPermission(thread, nowMs);
  const derivedAt = derivedLimitResumeAt(thread);
  if (
    !recovery.autoResume ||
    (!permitted &&
      (derivedAt === null ? !validReset || resetMs > nowMs : !derivedRoom || derivedAt > nowMs)) ||
    (recovery.availability !== undefined && !permitted) ||
    recoverySnoozeBlocks(thread, nowMs, permitted)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  const base = {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  } as const;
  // A derived resume is a usage-limit continuation too: the orchestrator
  // checks its derived wait, and that the recovery still stands, under the
  // thread lock.
  return {
    ...base,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
  };
}

/**
 * The project would otherwise act on this stop by itself (switch, redeem,
 * spend), but its reset is within the wait, so the thread resumes there
 * instead: the wait arms the resume even where auto-resume is off.
 */
export function waitRuleArmsResume(
  thread: Pick<ProjectionStore.ProjectionLimitRecoveryCandidate, "usageLimitResetAt">,
  rule: {
    readonly providerLimitAction: string;
    readonly providerLimitWaitUnderMinutes?: number;
    readonly providerLimitRedeemResets?: boolean;
    readonly providerLimitSpendCredits?: boolean;
    readonly providerLimitUseApiCredits?: boolean;
  },
  nowMs: number,
): boolean {
  const automatic =
    rule.providerLimitAction === "switch" ||
    rule.providerLimitRedeemResets === true ||
    rule.providerLimitSpendCredits === true ||
    rule.providerLimitUseApiCredits === true;
  return (
    automatic &&
    rule.providerLimitAction !== "wait" &&
    limitStopWaitsForReset({
      resetAt: thread.usageLimitResetAt,
      waitUnderMinutes: rule.providerLimitWaitUnderMinutes,
      nowMs,
    })
  );
}

/**
 * With no projection write since a read found no candidate, only the clock can
 * make one (a snooze running out), so the read is repeated this often instead
 * of on every five-second tick.
 */
export const LIMIT_RECOVERY_QUIET_RECHECK_MS = 30_000;

export const makeSweep = Effect.gen(function* () {
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const availability = yield* Availability.UsageLimitAvailability;
  const machineHandoff = yield* MachineLimitHandoff;
  // Optional, so a sweep built without the registry keeps to reported resets.
  const registry = yield* Effect.serviceOption(Providers.ProviderRegistry);
  // When a derived resume last refreshed each thread's instance.
  const refreshedAt = yield* Ref.make<ReadonlyMap<ThreadId, number>>(new Map());
  // A summary that hides whether a pending request blocks is filled in from
  // the thread's own records, so a question the next message answers does not
  // hold the thread. The summary names only the newest pending request, so
  // when any other one still blocks the bare summary (which blocks) is kept.
  const readShell = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* projections.getThreadShell(threadId);
      if (!shell || shell.pendingRuntimeRequest === null) return shell;
      const records = yield* Effect.option(projections.getThreadProjection(threadId));
      if (Option.isNone(records) || isBlockingRuntimeRequest(records.value, shell.latestRunId))
        return shell;
      return withPendingRequestDetail(shell, records.value);
    });
  // The instance each stopped run ran on; a run's instance never changes.
  const runInstances = yield* Ref.make<
    ReadonlyMap<string, ProjectionStore.ProjectionLimitRecoveryCandidate["providerInstanceId"]>
  >(new Map());
  /**
   * The instance the stopped run ran on, or undefined when its records cannot
   * be read. The orchestrator arms recovery only while the thread is still on
   * that instance.
   */
  const stoppedOn = (thread: ProjectionStore.ProjectionLimitRecoveryCandidate) =>
    Effect.gen(function* () {
      const runId = thread.latestRunId;
      if (runId === null) return undefined;
      const known = (yield* Ref.get(runInstances)).get(runId);
      if (known !== undefined) return known;
      const read = yield* Effect.exit(
        Effect.suspend(() => projections.getThreadProjection(thread.id)),
      );
      const instance = Exit.isSuccess(read)
        ? read.value.runs?.find((run) => run.id === runId)?.providerInstanceId
        : undefined;
      if (instance !== undefined)
        yield* Ref.update(
          runInstances,
          (previous) => new Map([...[...previous].slice(-255), [runId, instance]]),
        );
      return instance;
    });
  // Ids the orchestrator already refused. Each is fixed for one stop, so
  // sending it again would only repeat the refusal on every tick.
  const refused = yield* Ref.make<ReadonlySet<string>>(new Set());
  const send = (command: OrchestrationV2ServerCommand) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(refused)).has(command.commandId)) return;
      yield* threads.dispatch(command).pipe(
        Effect.asVoid,
        Effect.catchTags({
          OrchestratorCommandPreviouslyRejectedError: () =>
            Ref.update(
              refused,
              (previous) => new Set([...[...previous].slice(-255), command.commandId]),
            ),
        }),
      );
    });
  /**
   * Whether a stop that resumes on a derived reset may resume now: its wait is
   * over and a provider read taken after the stop shows room. Reads at most
   * once per LIMIT_CHECK_INTERVAL_MS per thread, and never before a reset the
   * provider still reports.
   */
  const derivedRoom = (thread: ProjectionStore.ProjectionLimitRecoveryCandidate) =>
    Effect.gen(function* () {
      if (Option.isNone(registry)) return false;
      const dueAt = derivedLimitResumeAt(thread);
      const nowMs = yield* Clock.currentTimeMillis;
      if (dueAt === null || dueAt > nowMs) return false;
      const stopMs = limitStopMs(thread);
      const own = (providers: ReadonlyArray<ServerProvider>) =>
        providers.find((provider) => provider.instanceId === thread.providerInstanceId);
      const cached = limitReadShowsRoom(own(yield* registry.value.getProviders), stopMs, nowMs);
      if (cached !== "check") return cached === "room";
      const last = (yield* Ref.get(refreshedAt)).get(thread.id);
      if (last !== undefined && nowMs - last >= 0 && nowMs - last < LIMIT_CHECK_INTERVAL_MS)
        return false;
      yield* Ref.update(
        refreshedAt,
        (previous) =>
          new Map([
            ...[...previous].filter(([, at]) => nowMs - at < LIMIT_CHECK_INTERVAL_MS),
            [thread.id, nowMs],
          ]),
      );
      const refreshed = yield* registry.value.refreshInstance(thread.providerInstanceId).pipe(
        Effect.timeoutOption("20 seconds"),
        Effect.catchCause(() => Effect.succeed(Option.none<ReadonlyArray<ServerProvider>>())),
      );
      return (
        Option.isSome(refreshed) &&
        limitReadShowsRoom(own(refreshed.value), stopMs, yield* Clock.currentTimeMillis) === "room"
      );
    });
  // The last read that found no candidate, and what it was read against.
  const quiet = yield* Ref.make<{
    readonly writeCount: number;
    readonly snooze: boolean;
    readonly readAtMs: number;
  } | null>(null);
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    // Taken before the read, so a write that lands during it forces the next
    // one. A store that cannot count its writes is read on every tick.
    const counted =
      projections.writeCount === undefined ? undefined : yield* Effect.exit(projections.writeCount);
    const writeCount = counted !== undefined && Exit.isSuccess(counted) ? counted.value : undefined;
    const last = yield* Ref.get(quiet);
    if (
      writeCount !== undefined &&
      last !== null &&
      last.writeCount === writeCount &&
      last.snooze === preferences.snoozeLimitedThreads &&
      nowMs - last.readAtMs >= 0 &&
      nowMs - last.readAtMs < LIMIT_RECOVERY_QUIET_RECHECK_MS
    )
      return;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: true,
      snooze: preferences.snoozeLimitedThreads,
    });
    yield* Ref.set(
      quiet,
      writeCount !== undefined && candidates.length === 0
        ? { writeCount, snooze: preferences.snoozeLimitedThreads, readAtMs: nowMs }
        : null,
    );
    for (const candidate of candidates) {
      yield* Effect.gen(function* () {
        let thread = candidate;
        if (!isLimitRecoveryCandidate(thread)) return;
        const shell = yield* projections.getThreadShell(thread.id);
        if (!shell) return;
        const project = yield* projects.get(shell.projectId);
        if (
          Option.isNone(project) ||
          projectExecutionIsFenced(project.value.workspaceSettings, shell.projectId, thread.id) ||
          project.value.workspaceSettings?.paused ||
          project.value.workspaceSettings?.archived
        )
          return;
        // This is an auto-arm default. Existing explicit per-thread recovery remains authoritative.
        const rule = resolveProjectSettings(preferences, shell.projectId).settings;
        const autoResume =
          autoResumeByDefault(project.value.workspaceSettings?.autoResume, preferences) ||
          waitRuleArmsResume(thread, rule, nowMs);
        const arm = limitRecoveryCommand(
          thread,
          autoResume,
          nowMs,
          preferences.snoozeLimitedThreads,
        );
        if (arm?.type === "thread.metadata.update") {
          if ((yield* Ref.get(refused)).has(arm.commandId)) return;
          yield* admission.withLock(
            shell.projectId,
            Effect.gen(function* () {
              const currentProject = yield* projects.get(shell.projectId);
              if (
                Option.isNone(currentProject) ||
                currentProject.value.deletedAt != null ||
                projectExecutionIsFenced(
                  currentProject.value.workspaceSettings,
                  shell.projectId,
                  thread.id,
                ) ||
                currentProject.value.workspaceSettings?.paused ||
                currentProject.value.workspaceSettings?.archived
              )
                return;
              // Lock order: project admission -> settings -> metadata dispatch.
              // A completed settings write must precede this decision, or wait
              // until its arm commits. Policy arms never bind native availability.
              yield* settings.withSettingsSnapshot((currentSettings) =>
                Effect.gen(function* () {
                  const current = yield* readShell(thread.id);
                  if (!current || current.projectId !== shell.projectId) return;
                  const armAt = DateTime.toEpochMillis(yield* DateTime.now);
                  const currentRule = resolveProjectSettings(
                    currentSettings,
                    shell.projectId,
                  ).settings;
                  const freshArm = limitRecoveryCommand(
                    current,
                    autoResumeByDefault(
                      currentProject.value.workspaceSettings?.autoResume,
                      currentSettings,
                    ) || waitRuleArmsResume(current, currentRule, armAt),
                    armAt,
                    currentSettings.snoozeLimitedThreads,
                  );
                  if (freshArm?.type !== "thread.metadata.update") return;
                  // A thread moved off the stopped run's instance is refused
                  // an arm; it is armed once it is back there.
                  const ranOn = yield* stoppedOn(current);
                  if (ranOn !== undefined && ranOn !== current.providerInstanceId) return;
                  yield* send(freshArm);
                }),
              );
            }),
          );
          return; // Observe only a committed user/policy choice on the next sweep.
        }
        if (
          thread.limitRecovery?.runId !== thread.latestRunId ||
          thread.limitRecovery.resetAt !== (thread.usageLimitResetAt ?? null)
        )
          return;
        if (!thread.limitRecovery.autoResume && !thread.limitRecovery.checkNow) return;
        if (recoverySnoozeBlocks(thread, nowMs, true)) return;
        const checked = yield* availability.check(thread);
        const room = !checked.codex && (yield* derivedRoom(thread));
        if (checked.observation) {
          yield* send({
            type: "thread.metadata.update",
            commandId: CommandId.make(
              `limit-check:${thread.id}:${thread.limitRecovery.requestId ?? "legacy"}:${checked.observation.checkedAt}`,
            ),
            threadId: thread.id,
            limitAvailability: {
              runId: thread.limitRecovery.runId,
              requestId: thread.limitRecovery.requestId,
              expectedUpdatedAt: DateTime.formatIso(thread.updatedAt),
              observation: checked.observation,
            },
          });
          const current = yield* readShell(thread.id);
          if (!current) return;
          thread = current;
        }
        // Provider refresh may be slow. Serialize only the final fresh policy
        // check and dispatch with pause/archive/delete, never the network probe.
        yield* admission.withLock(
          shell.projectId,
          Effect.gen(function* () {
            const currentProject = yield* projects.get(shell.projectId);
            if (
              Option.isNone(currentProject) ||
              currentProject.value.deletedAt != null ||
              projectExecutionIsFenced(
                currentProject.value.workspaceSettings,
                shell.projectId,
                thread.id,
              ) ||
              currentProject.value.workspaceSettings?.paused ||
              currentProject.value.workspaceSettings?.archived
            )
              return;
            const command = yield* settings.withSettingsSnapshot((currentSettings) =>
              Effect.gen(function* () {
                const current = yield* readShell(thread.id);
                if (!current || current.projectId !== shell.projectId) return null;
                const at = DateTime.toEpochMillis(yield* DateTime.now);
                if (
                  checked.codex &&
                  (checked.mayResume !== true || !hasFreshLimitPermission(current, at))
                )
                  return null;
                const currentRule = resolveProjectSettings(
                  currentSettings,
                  shell.projectId,
                ).settings;
                const next = limitRecoveryCommand(
                  current,
                  autoResumeByDefault(
                    currentProject.value.workspaceSettings?.autoResume,
                    currentSettings,
                  ) || waitRuleArmsResume(current, currentRule, at),
                  at,
                  currentSettings.snoozeLimitedThreads,
                  // The read was taken for this stop on this instance.
                  room &&
                    current.latestRunId === thread.latestRunId &&
                    current.providerInstanceId === thread.providerInstanceId,
                );
                // The observed stop may have changed during the probe. Any new
                // policy arm uses the same settings/commit ordering as above.
                if (next?.type === "thread.metadata.update") {
                  const ranOn = yield* stoppedOn(current);
                  if (ranOn === undefined || ranOn === current.providerInstanceId)
                    yield* send(next);
                  return null;
                }
                return next;
              }),
            );
            // A run handed to another machine (or whose move is in doubt)
            // continues there, never here as well. The handoff state on disk
            // says so after a restart, when the in-memory moves are gone.
            if (
              command &&
              ((yield* machineHandoff.holds(
                thread.id,
                command.type === "message.dispatch"
                  ? (command.usageLimitContinuationOfRunId ?? null)
                  : null,
              )) ||
                (command.type === "message.dispatch" &&
                  (yield* machineHandoff.localTurnBlocked(thread.id))))
            )
              return;
            if (!command) return;
            // Persisted recovery remains authoritative; never hold the settings
            // lock across continuation admission or provider work.
            yield* send(command);
          }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: candidate.id,
            cause,
          }),
        ),
      );
    }
  });
});

// The shared scheduler derives due work from persisted failures and recovery
// choices, so restarts need no timer restoration or connected client.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
).pipe(Layer.provide(ProjectAdmission.layer));
