/**
 * The assistant is proactive by default: once this machine's assistant may
 * read the person's Gmail or Calendar, it gets the daily briefing routine
 * without being asked. Set up once per Google account, so a briefing the
 * person deleted or retimed stays as they left it.
 */
import {
  CommandId,
  type ModelSelection,
  type ProjectId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
} from "@specweave-studio/contracts";
import { machineAssistantOf } from "@specweave-studio/shared/personalAssistant";
import {
  PROACTIVE_BRIEFING_COMMAND,
  PROACTIVE_BRIEFING_PROMPT,
  PROACTIVE_BRIEFING_TITLE,
} from "@specweave-studio/shared/routineTemplates";
import { teamRulesClampRoutineMode } from "@specweave-studio/shared/teamRules";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import * as Google from "../integrations/google/GoogleAccountService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { currentTeamRules } from "../teamRules/TeamRules.ts";

/** How often a new sign-in or a newly set up assistant is noticed. */
const CHECK_EVERY = Duration.minutes(5);

const BRIEFING_SERVICES = new Set(["gmail", "calendar"]);

export interface BriefingSetupInput {
  readonly aideEnabled: boolean;
  readonly projects: ReadonlyArray<{
    readonly projectId: string;
    readonly createdAt: string;
    readonly deletedAt: string | null;
    readonly defaultModelSelection: ModelSelection | null;
    readonly workspaceSettings?:
      | { readonly kind?: string | undefined; readonly archived?: boolean | undefined }
      | null
      | undefined;
  }>;
  readonly google: {
    readonly email: string | null;
    readonly services: ReadonlyArray<string>;
    readonly projects: ReadonlyArray<{
      readonly projectId: string;
      readonly services: ReadonlyArray<string>;
    }>;
    readonly briefingSetUp: ReadonlyArray<string>;
  };
  readonly tasks: ReadonlyArray<{
    readonly projectId: string;
    readonly title: string;
    readonly prompt: string;
  }>;
}

export type BriefingSetupStep =
  | { readonly kind: "create"; readonly projectId: string; readonly model: ModelSelection }
  /** A briefing exists already (the person made one): only remember it. */
  | { readonly kind: "mark"; readonly projectId: string };

const isBriefing = (task: { readonly title: string; readonly prompt: string }) => {
  const prompt = task.prompt.trimStart();
  return (
    task.title.trim() === PROACTIVE_BRIEFING_TITLE ||
    prompt.startsWith(PROACTIVE_BRIEFING_COMMAND) ||
    prompt.startsWith(PROACTIVE_BRIEFING_PROMPT.split("\n")[0]!)
  );
};

/** What to do now for this machine's assistant, or null when nothing is due. */
export function briefingSetupStep(input: BriefingSetupInput): BriefingSetupStep | null {
  if (!input.aideEnabled || input.google.email === null) return null;
  const assistant = machineAssistantOf(input.projects);
  if (assistant === undefined || assistant.workspaceSettings?.archived === true) return null;
  const projectId = assistant.projectId;
  if (input.google.briefingSetUp.includes(projectId)) return null;
  const granted = new Set(input.google.services);
  const switches = input.google.projects.find((entry) => entry.projectId === projectId);
  const readable = (switches?.services ?? []).some(
    (service) => granted.has(service) && BRIEFING_SERVICES.has(service),
  );
  if (!readable) return null;
  if (input.tasks.some((task) => task.projectId === projectId && isBriefing(task))) {
    return { kind: "mark", projectId };
  }
  // Without a model there is nothing to run it on yet; try again later.
  if (assistant.defaultModelSelection === null) return null;
  return { kind: "create", projectId, model: assistant.defaultModelSelection };
}

export function briefingRoutine(
  projectId: ProjectId,
  model: ModelSelection,
  runtimeMode: ScheduledTaskUpsertInput["runtimeMode"],
): ScheduledTaskUpsertInput {
  return {
    // One id per assistant, so a repeated setup cannot make a second briefing.
    commandId: CommandId.make(`aide-briefing:${projectId}`),
    title: PROACTIVE_BRIEFING_TITLE,
    // The short form expands at run time, so the briefing improves with releases.
    prompt: PROACTIVE_BRIEFING_COMMAND,
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "08:00" },
    projectId,
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: model,
    runtimeMode,
    interactionMode: "default",
    ownThread: true,
  };
}

/** Early setups saved the briefing under this id, in the app's built-in approval mode. */
const EARLY_BRIEFING_ID = "scheduled-task:assistant-setup:";

/**
 * An early setup's briefing waits on approval for every tool, a mode nobody
 * chose. It becomes the briefing today's setup makes, keeping its thread,
 * schedule and model. Only the early id matches, so this happens once and a
 * mode the person sets later stays.
 */
/** Save today's briefing in place of the early one, or only drop the early one once it exists. */
export type EarlyBriefingStep =
  | { readonly kind: "replace"; readonly input: ScheduledTaskUpsertInput }
  | { readonly kind: "drop" };

export function earlyBriefingReplacement(
  task: ScheduledTask,
  tasks: ReadonlyArray<Pick<ScheduledTask, "id">>,
  runtimeMode: ScheduledTaskUpsertInput["runtimeMode"],
): EarlyBriefingStep | null {
  if (
    !task.id.startsWith(EARLY_BRIEFING_ID) ||
    task.runtimeMode !== "approval-required" ||
    task.schedule.type === "webhook"
  )
    return null;
  const commandId = `aide-briefing:${task.projectId}`;
  // Saved by an earlier pass whose delete did not finish.
  if (tasks.some((other) => other.id === `scheduled-task:${commandId}`)) return { kind: "drop" };
  return {
    kind: "replace",
    input: {
      commandId: CommandId.make(commandId),
      title: task.title,
      prompt: task.prompt,
      enabled: task.enabled,
      schedule: task.schedule as ScheduledTaskUpsertInput["schedule"],
      projectId: task.projectId,
      threadId: task.threadId,
      workspaceStrategy: task.workspaceStrategy,
      modelSelection: task.modelSelection,
      runtimeMode,
      interactionMode: task.interactionMode,
      createdBy: task.createdBy,
      creationSource: task.creationSource,
      ...(task.modelPinned === undefined ? {} : { modelPinned: task.modelPinned }),
      ...(task.check === undefined ? {} : { check: task.check }),
      ...(task.brief === undefined ? {} : { brief: task.brief }),
      ownThread: true,
    },
  };
}

const replaceEarlyBriefings = Effect.gen(function* () {
  const scheduledTasks = yield* ScheduledTaskService;
  const { tasks } = yield* scheduledTasks.list();
  const rules = yield* currentTeamRules;
  for (const task of tasks) {
    const step = earlyBriefingReplacement(
      task,
      tasks,
      teamRulesClampRoutineMode(rules, "full-access"),
    );
    if (step === null) continue;
    yield* (step.kind === "replace" ? scheduledTasks.upsert(step.input) : Effect.void).pipe(
      Effect.andThen(scheduledTasks.delete({ id: task.id })),
      Effect.andThen(
        Effect.logInfo("Replaced an early briefing that waited on approval", { taskId: task.id }),
      ),
      // One routine that cannot be saved must not stop setup or the others.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not replace an early briefing", { taskId: task.id, cause }),
      ),
    );
  }
});

export const runOnce = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const google = yield* Google.GoogleAccountService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const scheduledTasks = yield* ScheduledTaskService;
  const { aideEnabled } = yield* settings.getSettings;
  if (!aideEnabled) return;
  yield* replaceEarlyBriefings;
  const googleState = yield* google.briefingState;
  if (googleState.email === null) return;
  const { tasks } = yield* scheduledTasks.list();
  const step = briefingSetupStep({
    aideEnabled,
    projects: yield* projects.list(),
    google: googleState,
    tasks,
  });
  if (step === null) return;
  const projectId = step.projectId as ProjectId;
  if (step.kind === "create") {
    const rules = yield* currentTeamRules;
    yield* scheduledTasks.upsert(
      briefingRoutine(projectId, step.model, teamRulesClampRoutineMode(rules, "full-access")),
    );
    yield* Effect.logInfo("Set up the assistant's proactive briefing", { projectId });
  }
  yield* google.markBriefingSetUp(projectId);
});

export const start = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const google = yield* Google.GoogleAccountService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const scheduledTasks = yield* ScheduledTaskService;
  yield* forkParked(
    runOnce.pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, settings),
      Effect.provideService(Google.GoogleAccountService, google),
      Effect.provideService(ProjectStore.ProjectStoreV2, projects),
      Effect.provideService(ScheduledTaskService, scheduledTasks),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not set up the assistant's briefing", { cause }),
      ),
      Effect.repeat(Schedule.spaced(CHECK_EVERY)),
    ),
  );
});
