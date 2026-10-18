import { projectExecutionIsFenced } from "@specweave-studio/contracts";
import * as ProjectAdmission from "../project/ProjectAdmission.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Option from "effect/Option";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ServerCommand,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { limitStopWaitsForReset } from "@specweave-studio/shared/providerFallback";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as Availability from "./UsageLimitAvailability.ts";
import {
  hasFreshLimitPermission,
  isLimitRecoveryCandidate,
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

/** The persisted run and reset form the identity of one recovery opportunity. */
export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2ServerCommand | null {
  if (!isLimitRecoveryCandidate(thread) || !thread.latestRunId) return null;
  const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
  const validReset =
    Number.isFinite(resetMs) &&
    resetMs > DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt);
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (
    recovery?.runId !== thread.latestRunId ||
    recovery.resetAt !== (thread.usageLimitResetAt ?? null)
  ) {
    // Never auto-arm a second failure in the same observed reset window.
    if (
      !validReset ||
      (recovery &&
        recovery.runId !== thread.latestRunId &&
        recovery.resetAt === thread.usageLimitResetAt) ||
      (!autoResume && (!snooze || resetMs <= nowMs))
    )
      return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecoveryPolicyArm: true,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt ?? null,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  const permitted = hasFreshLimitPermission(thread, nowMs);
  if (
    !recovery.autoResume ||
    (!permitted && (!validReset || resetMs > nowMs)) ||
    (recovery.availability !== undefined && !permitted) ||
    recoverySnoozeBlocks(thread, nowMs, permitted)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
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

export const makeSweep = Effect.gen(function* () {
  const admission = yield* ProjectAdmission.ProjectAdmission;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const availability = yield* Availability.UsageLimitAvailability;
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const preferences = yield* settings.getSettings;
    const now = yield* DateTime.now;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: true,
      snooze: preferences.snoozeLimitedThreads,
    });
    const nowMs = DateTime.toEpochMillis(now);
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
                  const current = yield* projections.getThreadShell(thread.id);
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
                  if (freshArm?.type === "thread.metadata.update")
                    yield* threads.dispatch(freshArm);
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
        if (checked.observation) {
          yield* threads.dispatch({
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
          const current = yield* projections.getThreadShell(thread.id);
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
                const current = yield* projections.getThreadShell(thread.id);
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
                );
                // The observed stop may have changed during the probe. Any new
                // policy arm uses the same settings/commit ordering as above.
                if (next?.type === "thread.metadata.update") {
                  yield* threads.dispatch(next);
                  return null;
                }
                return next;
              }),
            );
            // Persisted recovery remains authoritative; never hold the settings
            // lock across continuation admission or provider work.
            if (command) yield* threads.dispatch(command);
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
