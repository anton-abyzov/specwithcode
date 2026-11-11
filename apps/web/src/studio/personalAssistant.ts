import {
  isPersonalAssistantProject,
  machineAssistantOf,
} from "@specweave-studio/shared/personalAssistant";

interface AssistantCandidate {
  id?: string;
  environmentId?: string;
  createdAt?: string;
  workspaceSettings?:
    | { kind?: string | undefined; archived?: boolean | undefined }
    | null
    | undefined;
}

/** The one line for anyone looking to move or transfer an assistant to another machine. */
export const PERSONAL_ASSISTANT_PER_MACHINE_LINE =
  "Each machine has its own private assistant. Nothing transfers between them.";

/**
 * Another machine's assistant, when this machine has none yet: the first one
 * listed whose machine is not `ownEnvironmentId`. Setup names it so the person
 * knows a new one here is separate and nothing carries over.
 */
export function otherMachineAssistant<T extends AssistantCandidate>(
  projects: readonly T[],
  ownEnvironmentId: string | null | undefined,
): T | undefined {
  if (ownEnvironmentId == null || findMachineAssistant(projects, ownEnvironmentId))
    return undefined;
  const machines = [
    ...new Set(
      projects
        .filter((project) => project.workspaceSettings?.kind === "personal")
        .flatMap((project) =>
          project.environmentId && project.environmentId !== ownEnvironmentId
            ? [project.environmentId]
            : [],
        ),
    ),
  ];
  for (const machine of machines) {
    const assistant = findMachineAssistant(projects, machine);
    if (assistant) return assistant;
  }
  return undefined;
}

/** "Percy on Anna's MacBook stays there. This creates a separate Percy for this machine." */
export function separateAssistantLine(
  title: string,
  machineLabel: string | null | undefined,
): string {
  const name = title.trim() || "Your assistant";
  const where = machineLabel?.trim() || "another machine";
  return `${name} on ${where} stays there. This creates a separate ${name} for this machine.`;
}

/**
 * One machine's personal assistant. Each machine has its own, private to it:
 * another machine's assistant is never opened, reused or merged in its place.
 * A duplicate from before that rule keeps its history; the earliest one is
 * the machine's assistant.
 */
export function findMachineAssistant<T extends AssistantCandidate>(
  projects: readonly T[],
  environmentId: string,
): T | undefined {
  const own = projects.filter((project) => project.environmentId === environmentId);
  const chosen = machineAssistantOf(
    own.map((project, index) => ({
      ...project,
      id: project.id ?? String(index),
      createdAt: project.createdAt ?? "",
    })),
  );
  return chosen === undefined
    ? undefined
    : own.find((project, index) => (project.id ?? String(index)) === chosen.id);
}

/** Whether `project` is a personal assistant but not its machine's own: a duplicate from before one assistant per machine. */
export function isExtraAssistant<T extends AssistantCandidate>(
  project: T,
  projects: readonly T[],
): boolean {
  if (project.workspaceSettings?.kind !== "personal" || project.environmentId === undefined)
    return false;
  const own = findMachineAssistant(projects, project.environmentId);
  return own !== undefined && own.id !== project.id;
}

/**
 * Whether this machine still lacks its assistant, so Set up stays offered even
 * while another machine's is listed. A client with no machine of its own only
 * sees other machines, so any assistant counts.
 */
export function machineNeedsAssistantSetup<T extends AssistantCandidate>(input: {
  readonly assistants: readonly T[];
  readonly ownEnvironmentId: string | null;
}): boolean {
  return input.ownEnvironmentId === null
    ? input.assistants.length === 0
    : findMachineAssistant(input.assistants, input.ownEnvironmentId) === undefined;
}

export type PersonalAssistantSetupStep<T> =
  | { readonly kind: "open"; readonly assistant: T }
  | { readonly kind: "create"; readonly environmentId: string }
  | { readonly kind: "choose-machine" };

/**
 * What Set up does: on this window's own machine, or without one the machine
 * in context (or the only connected one), open its assistant or make it one.
 * Looking at another machine's project never turns the assistant into that machine's.
 * Otherwise the user picks the machine; nothing crosses between them.
 */
export function personalAssistantSetupStep<T extends AssistantCandidate>(input: {
  readonly projects: readonly T[];
  readonly connectedEnvironmentIds: readonly string[];
  readonly ownEnvironmentId?: string | null | undefined;
  readonly preferredEnvironmentId?: string | null | undefined;
}): PersonalAssistantSetupStep<T> {
  const { connectedEnvironmentIds: connected, ownEnvironmentId: own } = input;
  // This machine unreachable: ask, so "Set up here" never lands on another machine.
  if (own != null && !connected.includes(own)) return { kind: "choose-machine" };
  const preferred = own ?? input.preferredEnvironmentId;
  const target =
    preferred != null && connected.includes(preferred)
      ? preferred
      : connected.length === 1
        ? connected[0]
        : undefined;
  if (target === undefined) return { kind: "choose-machine" };
  const assistant = findMachineAssistant(input.projects, target);
  return assistant ? { kind: "open", assistant } : { kind: "create", environmentId: target };
}

/** "Percy · Anna's MacBook" once more than one machine is connected; the plain name otherwise. */
export function assistantDisplayTitle(
  title: string,
  machineLabel: string | null | undefined,
  machineCount: number,
): string {
  return machineCount > 1 && machineLabel ? `${title} · ${machineLabel}` : title;
}

/**
 * The projects a list shows: every one while the personal assistant is on, and
 * all but personal ones while it is off. Hiding never deletes; turning it back
 * on brings the same assistant back.
 */
export function visibleWithAide<T extends Parameters<typeof isPersonalAssistantProject>[0]>(
  projects: readonly T[],
  aideEnabled: boolean,
): readonly T[] {
  if (aideEnabled || !projects.some(isPersonalAssistantProject)) return projects;
  return projects.filter((project) => !isPersonalAssistantProject(project));
}

/**
 * `visibleWithAide` for a picker that has a saved choice: a hidden personal
 * project stays listed while it is the one saved or selected (`keepIds`), so
 * hiding the assistant never silently changes or blanks what a setting points at.
 */
export function visibleWithAideKeeping<
  T extends Parameters<typeof isPersonalAssistantProject>[0] & { readonly id: string },
>(
  projects: readonly T[],
  aideEnabled: boolean,
  keepIds: ReadonlyArray<string | null | undefined>,
): readonly T[] {
  if (aideEnabled || !projects.some(isPersonalAssistantProject)) return projects;
  return projects.filter(
    (project) => !isPersonalAssistantProject(project) || keepIds.includes(project.id),
  );
}

/** The chats a list shows: a hidden personal assistant's chats leave with it. */
export function threadsVisibleWithAide<
  T extends { readonly environmentId: string; readonly projectId: string },
>(
  threads: readonly T[],
  projects: readonly {
    readonly environmentId: string;
    readonly id: string;
    readonly workspaceSettings?: { readonly kind?: string | undefined } | null | undefined;
  }[],
  aideEnabled: boolean,
): readonly T[] {
  if (aideEnabled) return threads;
  const hidden = new Set(
    projects
      .filter(isPersonalAssistantProject)
      .map((project) => `${project.environmentId}:${project.id}`),
  );
  if (hidden.size === 0) return threads;
  return threads.filter((thread) => !hidden.has(`${thread.environmentId}:${thread.projectId}`));
}

/**
 * Whether Set up may make an assistant on this machine. The switch is saved on
 * each machine, and a change reaches only the machines connected at the time,
 * so machines can disagree: only one whose own settings turn the assistant on (or that
 * already has its assistant, which is then opened) is offered.
 */
export function machineOffersAssistant<T extends AssistantCandidate>(input: {
  readonly environmentId: string;
  readonly aideEnabledOnMachine: boolean;
  readonly projects: readonly T[];
}): boolean {
  return (
    input.aideEnabledOnMachine ||
    findMachineAssistant(input.projects, input.environmentId) !== undefined
  );
}

/** Why Set up was refused, naming the machine that keeps the assistant off. */
export function personalAssistantDisabledMessage(machineLabel: string | null | undefined): string {
  return machineLabel
    ? `The personal assistant is turned off on ${machineLabel}. Turn it on in Settings > General while ${machineLabel} is connected.`
    : "The personal assistant is turned off on this machine. Turn it on in Settings > General.";
}

/** Whether a failed create is the server refusing a personal assistant because it is off there. */
export function isPersonalAssistantDisabledError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const reason = (error as { readonly reason?: unknown }).reason;
  if (reason === "project_assistant_disabled" || reason === "assistant_disabled") return true;
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" && message.startsWith("The personal assistant is turned off.");
}
