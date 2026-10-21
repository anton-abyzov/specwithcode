/**
 * The one escalation step of Auto model routing. A thread Auto moved to a
 * cheaper model whose run failed (not on a usage limit, which the provider
 * fallback owns) continues once, in the same thread, on the model it would
 * have used without Auto. The continuation carries the stopped run, so the
 * context, permissions and workspace stay; it never starts mid-turn, and its
 * command id is one per thread, so it can neither loop nor run twice.
 *
 * A delegated task is not escalated here: its failure has already gone to
 * the thread that started it, which may retry it, so continuing it as well
 * could do the work twice. That thread reads `routing.escalation` instead.
 *
 * @module TaskRoutingEscalationWorker
 */
import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { latestRootProviderFailure } from "@specweave-studio/shared/orchestrationV2ThreadError";
import { canTakeTurn } from "@specweave-studio/shared/providerFallback";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as Projects from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS } from "./ShellSnapshotCache.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const TASK_ROUTING_ESCALATION_INTERVAL_MS = 30_000;

/** Failures a stronger model can plausibly get past; a refused permission or a dropped connection is not one. */
const ESCALATING_FAILURES = new Set(["provider_error", "validation_error", "unknown"]);

export type EscalationThread = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "modelSelection"
  | "status"
  | "lastErrorClass"
  | "latestRunId"
  | "activeRunId"
  | "pendingRuntimeRequest"
  | "settledOverride"
> &
  Partial<
    Pick<
      OrchestrationV2ThreadShell,
      "routing" | "pendingBackgroundTasks" | "archivedAt" | "lineage"
    >
  >;

export const escalationCommandId = (threadId: string) =>
  CommandId.make(`route-escalate:${threadId}`);

/**
 * The continuation that escalates this thread, or null. Only a thread still
 * on the model Auto picked, idle, whose latest run failed for a reason a
 * stronger model may fix, with an escalation target that can take a turn.
 */
export function taskRoutingEscalationCommand(
  thread: EscalationThread,
  providers: ReadonlyArray<ServerProvider>,
): OrchestrationV2ServerCommand | null {
  const routing = thread.routing;
  if (!routing?.moved || routing.escalation === null) return null;
  if (thread.lineage?.relationshipToParent === "subagent") return null;
  if (
    thread.modelSelection.instanceId !== routing.selection.instanceId ||
    thread.modelSelection.model !== routing.selection.model
  )
    return null;
  if (thread.status !== "failed" || thread.latestRunId === null) return null;
  if (!thread.lastErrorClass || !ESCALATING_FAILURES.has(thread.lastErrorClass)) return null;
  if (thread.activeRunId !== null || thread.pendingRuntimeRequest !== null) return null;
  if (thread.settledOverride === "settled" || thread.archivedAt != null) return null;
  if ((thread.pendingBackgroundTasks?.length ?? 0) > 0) return null;
  const target = providers.find(
    (provider) => provider.instanceId === routing.escalation?.instanceId,
  );
  if (target === undefined || !canTakeTurn(target)) return null;
  const from =
    providers
      .find((provider) => provider.instanceId === routing.selection.instanceId)
      ?.models.find((model) => model.slug === routing.selection.model)?.name ??
    routing.selection.model;
  const to =
    target.models.find((model) => model.slug === routing.escalation?.model)?.name ??
    routing.escalation.model;
  return {
    type: "message.dispatch",
    commandId: escalationCommandId(thread.id),
    messageId: MessageId.make(`route-escalate:${thread.id}`),
    threadId: thread.id,
    manualContinuationOfRunId: thread.latestRunId,
    modelSelection: routing.escalation,
    text: `The attempt on ${from} stopped with an error. Continue the task where it left off; you now run on ${to}.`,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "server",
  };
}

export const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const projects = yield* Projects.ProjectService;
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const lastRunAt = yield* Ref.make(Number.NEGATIVE_INFINITY);
  const sent = yield* Ref.make(new Set<string>());
  return Effect.fn("TaskRoutingEscalationWorker.sweep")(function* () {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (now - (yield* Ref.get(lastRunAt)) < TASK_ROUTING_ESCALATION_INTERVAL_MS) return;
    yield* Ref.set(lastRunAt, now);
    const snapshot = yield* projections.getShellSnapshot({
      location: "active",
      unsettledOnly: true,
      maxAgeMs: SWEEP_SHELL_SNAPSHOT_MAX_AGE_MS,
    });
    const routed = snapshot.threads.filter(
      (thread) => thread.routing?.moved === true && thread.status === "failed",
    );
    if (routed.length === 0) return;
    const providers = yield* registry.getProviders;
    const preferences = Option.isSome(settings)
      ? yield* settings.value.getSettings.pipe(Effect.option)
      : Option.none();
    for (const thread of routed) {
      const commandId = escalationCommandId(thread.id);
      if ((yield* Ref.get(sent)).has(commandId)) continue;
      if (taskRoutingEscalationCommand(thread, providers) === null) continue;
      const project = yield* projects
        .getById(thread.projectId)
        .pipe(Effect.option, Effect.map(Option.flatten));
      if (
        Option.isNone(project) ||
        project.value.workspaceSettings?.paused ||
        project.value.workspaceSettings?.archived
      )
        continue;
      if (
        Option.isSome(preferences) &&
        !resolveProjectSettings(preferences.value, thread.projectId, project.value).settings
          .taskRouting.escalate
      )
        continue;
      // Checked again against the thread as it is now, and nothing may be queued behind it.
      const current = yield* projections
        .getThreadShell(thread.id)
        .pipe(Effect.orElseSucceed(() => null));
      const command = current === null ? null : taskRoutingEscalationCommand(current, providers);
      if (command === null) continue;
      const latestRunId = current?.latestRunId ?? null;
      const blocked = yield* projections
        .getThreadRecords(thread.id, ["runs", "turnItems"], {
          turnItemRunIds: latestRunId === null ? [] : [latestRunId],
        })
        .pipe(
          Effect.map(
            (records) =>
              records.runs.some((run) => run.status === "queued") ||
              // A provider that could not open is the provider fallback's to move (its
              // `switch` rule); continuing here as well would start the work twice.
              latestRootProviderFailure(
                records.runs.find((run) => run.id === latestRunId) ?? null,
                records.turnItems,
              )?.code === ORCHESTRATION_V2_PROVIDER_UNAVAILABLE_FAILURE_CODE,
          ),
          Effect.orElseSucceed(() => true),
        );
      if (blocked) continue;
      yield* Ref.update(sent, (current) => new Set(current).add(commandId));
      yield* threads.dispatch(command).pipe(
        Effect.tap(() =>
          Effect.logInfo("orchestration-v2.task-routing.escalated", {
            threadId: thread.id,
            from: thread.modelSelection.model,
            to: command.type === "message.dispatch" ? command.modelSelection?.model : undefined,
          }),
        ),
        // A replay of the one id this thread gets is a no-op; nothing retries it.
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.task-routing.escalation-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register(
      "task-routing-escalation",
      sweep().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.task-routing.sweep-failed", { cause }),
        ),
      ),
    );
  }),
);
