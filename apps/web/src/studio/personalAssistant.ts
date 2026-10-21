import { machineAssistantOf } from "@specweave-studio/shared/personalAssistant";

interface AssistantCandidate {
  id?: string;
  environmentId?: string;
  createdAt?: string;
  workspaceSettings?:
    | { kind?: string | undefined; archived?: boolean | undefined }
    | null
    | undefined;
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

export type PersonalAssistantSetupStep<T> =
  | { readonly kind: "open"; readonly assistant: T }
  | { readonly kind: "create"; readonly environmentId: string }
  | { readonly kind: "choose-machine" };

/**
 * What Set up does: on the machine in context (or the only connected one),
 * open its assistant or make it one. With several machines and none in
 * context, the user picks the machine; nothing crosses between them.
 */
export function personalAssistantSetupStep<T extends AssistantCandidate>(input: {
  readonly projects: readonly T[];
  readonly connectedEnvironmentIds: readonly string[];
  readonly preferredEnvironmentId?: string | null | undefined;
}): PersonalAssistantSetupStep<T> {
  const { connectedEnvironmentIds: connected, preferredEnvironmentId: preferred } = input;
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

/** "Aide · Anna's MacBook" once more than one machine is connected; the plain name otherwise. */
export function assistantDisplayTitle(
  title: string,
  machineLabel: string | null | undefined,
  machineCount: number,
): string {
  return machineCount > 1 && machineLabel ? `${title} · ${machineLabel}` : title;
}
