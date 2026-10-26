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
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Availability from "./UsageLimitAvailability.ts";
import { MachineLimitHandoff } from "./MachineLimitHandoff.ts";
import { apiCreditDetourResumeRefused } from "./providerOpenFailure.ts";
import { isBlockingRuntimeRequest, withPendingRequestDetail } from "./blockingRuntimeRequest.ts";
import {
  LIMIT_CHECK_INTERVAL_MS,
  LIMIT_REARM_MAX,
  LIMIT_REARM_MAX_DELAY_MS,
  SUBSCRIPTION_CHECK_INTERVAL_MS,
  accountChangeMark,
  accountChangeShowsRoom,
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
  accountChangedMs: number | null = null,
  /** The stop is on an API-credit detour the rule no longer allows (`apiCreditDetourResumeRefused`). */
  apiCreditDetourRefused = false,
): OrchestrationV2ServerCommand | null {
  if (!isLimitRecoveryCandidate(thread) || !thread.latestRunId) return null;
  // Neither armed nor resumed: the way back takes the thread home instead.
  if (apiCreditDetourRefused) return null;
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
  const waited =
    derivedAt === null ? validReset && resetMs <= nowMs : derivedRoom && derivedAt <= nowMs;
  // Another account with room needs no wait for the reset the old one reported.
  const accountChanged =
    accountChangedMs !== null &&
    accountChangedMs > limitStopMs(thread) &&
    accountChangedMs <= nowMs;
  const early = permitted || accountChanged;
  if (
    !recovery.autoResume ||
    (!early && !waited) ||
    // A Codex availability check binds the old account's pool; another
    // subscription with room is proof of its own.
    (recovery.availability !== undefined && !permitted && !accountChanged) ||
    recoverySnoozeBlocks(thread, nowMs, early)
  )
    return null;
  // Its own id, so a refused early resume never blocks the one at the reset.
  // A Codex stop whose availability check saw the old pool keeps the mark
  // after the reset too: the change is its only permission, and the
  // orchestrator refuses a plain id there, spending it for good.
  const mark =
    !permitted && accountChanged && (!waited || recovery.availability !== undefined)
      ? accountChangeMark(accountChangedMs)
      : "";
  const deliveryIdentity = `${identity}${mark}:${recovery.requestId ?? "legacy"}`;
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

/** The least time between two resumes on one instance after its account changed. */
export const ACCOUNT_RESUME_SPACING_MS = 5_000;

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
  // Optional too: tells whether a Codex process still holds the old subscription.
  const sessionManager = yield* Effect.serviceOption(ProviderSessionManagerV2);
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
  // Whether each stopped run sits on a detour the API-credit rule made; a
  // run's history up to it never changes.
  const detourRuns = yield* Ref.make<ReadonlyMap<string, boolean>>(new Map());
  /**
   * Whether recovery must leave this stop alone under `rule`: the API-credit
   * rule moved the thread to an API-key instance and is now off. With its
   * records unreadable the sweep goes on: the orchestrator checks the same
   * against the thread's own records before any resume starts a turn.
   */
  const detourRefused = (
    thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
    rule: { readonly providerLimitUseApiCredits?: boolean | undefined },
  ) =>
    Effect.gen(function* () {
      if (rule.providerLimitUseApiCredits === true) return false;
      const runId = thread.latestRunId;
      if (runId === null) return false;
      const known = (yield* Ref.get(detourRuns)).get(runId);
      if (known !== undefined) return known;
      const read = yield* Effect.exit(
        Effect.suspend(() => projections.getThreadProjection(thread.id)),
      );
      if (Exit.isFailure(read)) return false;
      const onDetour = apiCreditDetourResumeRefused(thread, read.value.runs ?? [], rule);
      yield* Ref.update(
        detourRuns,
        (previous) => new Map([...[...previous].slice(-255), [runId, onDetour]]),
      );
      return onDetour;
    });
  // Ids the orchestrator already refused. Each is fixed for one stop, so
  // sending it again would only repeat the refusal on every tick.
  const refused = yield* Ref.make<ReadonlySet<string>>(new Set());
  const send = (command: OrchestrationV2ServerCommand) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(refused)).has(command.commandId)) return false;
      return yield* threads.dispatch(command).pipe(
        Effect.as(true),
        Effect.catchTags({
          OrchestratorCommandPreviouslyRejectedError: () =>
            Ref.update(
              refused,
              (previous) => new Set([...[...previous].slice(-255), command.commandId]),
            ).pipe(Effect.as(false)),
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
  // When each instance was last read for a subscription change.
  const subscriptionCheckedAt = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
  /**
   * When the stopped thread's instance changed to a subscription with room,
   * or null. This is the watch Anton asked for: while a thread waits on a
   * limit, its instance is read at most once per SUBSCRIPTION_CHECK_INTERVAL_MS
   * (shared by every thread there), so a sign-in to another subscription in
   * the same CLI is noticed without the old account's reset. The login-file
   * watcher still re-reads at once when it sees the change.
   */
  const accountChange = (thread: ProjectionStore.ProjectionLimitRecoveryCandidate) =>
    Effect.gen(function* () {
      if (Option.isNone(registry)) return null;
      const stopMs = limitStopMs(thread);
      const own = (providers: ReadonlyArray<ServerProvider>) =>
        providers.find((provider) => provider.instanceId === thread.providerInstanceId);
      const withRoom = (provider: ServerProvider | undefined, atMs: number) => {
        const changedMs = Date.parse(provider?.usageLimits?.accountChangedAt ?? "");
        return Number.isFinite(changedMs) && accountChangeShowsRoom(provider, stopMs, atMs)
          ? changedMs
          : null;
      };
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = own(yield* registry.value.getProviders);
      const known = withRoom(cached, nowMs);
      if (known !== null) return known;
      // Paced by this watch's own reads, not the snapshot's `checkedAt`: rate
      // limit events from turns still running on the instance move that
      // forward without asking the CLI who is signed in.
      const instance = String(thread.providerInstanceId);
      const last = (yield* Ref.get(subscriptionCheckedAt)).get(instance);
      if (last !== undefined && nowMs - last >= 0 && nowMs - last < SUBSCRIPTION_CHECK_INTERVAL_MS)
        return null;
      yield* Ref.update(
        subscriptionCheckedAt,
        (previous) =>
          new Map([
            ...[...previous].filter(([, at]) => nowMs - at < SUBSCRIPTION_CHECK_INTERVAL_MS),
            [instance, nowMs],
          ]),
      );
      // Fresh: a cached probe would report the old sign-in for minutes.
      const refreshed = yield* registry.value
        .refreshInstance(thread.providerInstanceId, { fresh: true })
        .pipe(
          Effect.timeoutOption("20 seconds"),
          Effect.catchCause(() => Effect.succeed(Option.none<ReadonlyArray<ServerProvider>>())),
        );
      if (Option.isNone(refreshed)) return null;
      return withRoom(own(refreshed.value), yield* Clock.currentTimeMillis);
    });
  // When each instance last sent a resume for an account change. Paused
  // threads follow one at a time, so a new account that fills up stops the
  // rest at its next read instead of taking every thread at once.
  const accountResumedAt = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
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
        // A detour onto API credits the rule no longer allows is the way back's to end.
        if (yield* detourRefused(thread, rule)) return;
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
                    false,
                    null,
                    yield* detourRefused(current, currentRule),
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
          thread.limitRecovery.resetAt !== (thread.usageLimitResetAt ?? null) ||
          (!thread.limitRecovery.autoResume && !thread.limitRecovery.checkNow)
        ) {
          // Nothing resumes by itself, but the read still lets the thread
          // show the new subscription and ask the person to confirm it, while
          // the old limit still holds it: before its reset, or for a stop with
          // no reset, within the longest wait a re-arm would take.
          const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
          const limitHolds = Number.isFinite(resetMs)
            ? resetMs > nowMs
            : nowMs - limitStopMs(thread) < LIMIT_REARM_MAX_DELAY_MS;
          if (limitHolds && !recoverySnoozeBlocks(thread, nowMs, true))
            yield* accountChange(thread);
          return;
        }
        if (recoverySnoozeBlocks(thread, nowMs, true)) return;
        const checked = yield* availability.check(thread);
        const room = !checked.codex && (yield* derivedRoom(thread));
        // Codex too: a sign-in to another ChatGPT subscription moves its pool.
        // Watched until the longest re-arm wait past the reset (or the stop,
        // without one): a Codex stop bound to the old pool can still need
        // the change after its reset, but a stop nothing resumes is not read
        // every 2 minutes for days.
        const watchFromMs = Math.max(
          limitStopMs(thread),
          Date.parse(thread.usageLimitResetAt ?? "") || 0,
        );
        const changedMs =
          nowMs - watchFromMs < LIMIT_REARM_MAX_DELAY_MS ? yield* accountChange(thread) : null;
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
                const currentRule = resolveProjectSettings(
                  currentSettings,
                  shell.projectId,
                ).settings;
                // Another subscription is the person's to approve unless the
                // project approves it by itself (the default).
                const subscriptionChangeMs =
                  changedMs !== null && currentRule.autoApproveSubscriptionChange !== false
                    ? changedMs
                    : null;
                if (
                  checked.codex &&
                  subscriptionChangeMs === null &&
                  (checked.mayResume !== true || !hasFreshLimitPermission(current, at))
                )
                  return null;
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
                  current.latestRunId === thread.latestRunId &&
                    current.providerInstanceId === thread.providerInstanceId
                    ? subscriptionChangeMs
                    : null,
                  yield* detourRefused(current, currentRule),
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
            const forAccountChange = command.commandId.includes(":acct:");
            const instance = String(thread.providerInstanceId);
            if (forAccountChange) {
              const at = yield* Clock.currentTimeMillis;
              const lastAt = (yield* Ref.get(accountResumedAt)).get(instance);
              if (
                lastAt !== undefined &&
                at - lastAt >= 0 &&
                at - lastAt < ACCOUNT_RESUME_SPACING_MS
              )
                return;
              // A process still busy on the previous subscription would run the
              // resume there; wait until it is replaced (see replaceWhenIdle).
              const pending = Option.isSome(sessionManager)
                ? sessionManager.value.replacementPending
                : undefined;
              if (pending && (yield* pending(thread.providerInstanceId))) return;
            }
            // Persisted recovery remains authoritative; never hold the settings
            // lock across continuation admission or provider work.
            const sent = yield* send(command);
            // Only a resume that started a run uses the instance's slot, so a
            // thread the orchestrator keeps refusing never starves the others
            // on it. A refused resume commits too (and replays as committed),
            // but starts no run for its message. Unreadable records keep the
            // spacing.
            if (forAccountChange && sent && command.type === "message.dispatch") {
              const records = yield* Effect.exit(
                Effect.suspend(() => projections.getThreadProjection(thread.id)),
              );
              const started =
                Exit.isFailure(records) ||
                (records.value.runs ?? []).some((run) => run.userMessageId === command.messageId);
              if (!started) return;
              const at = yield* Clock.currentTimeMillis;
              yield* Ref.update(
                accountResumedAt,
                (previous) => new Map([...previous, [instance, at]]),
              );
            }
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
