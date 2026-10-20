interface AssistantCandidate {
  workspaceSettings?:
    | { kind?: string | undefined; archived?: boolean | undefined }
    | null
    | undefined;
}

/** One entry point across the loaded fleet. Keep legacy duplicates and history intact. */
export function findPersonalAssistant<T extends AssistantCandidate>(
  projects: readonly T[],
): T | undefined {
  const assistants = projects.filter((project) => project.workspaceSettings?.kind === "personal");
  return assistants.find((project) => !project.workspaceSettings?.archived) ?? assistants[0];
}

/** All clients with the same fleet converge on one host, including when it is offline. */
export function personalAssistantCreationEnvironment<T extends string>(
  environmentIds: readonly T[],
): T | null {
  return [...environmentIds].sort()[0] ?? null;
}

/** What Set up says while private machines this app cannot see may hold an assistant. */
export const PERSONAL_ASSISTANT_ELSEWHERE_NOTICE =
  "An assistant on another Mac is not visible until that Mac is connected.";

export type PersonalAssistantSetupStep<T, M> =
  | { readonly kind: "open"; readonly assistant: T }
  | { readonly kind: "connect-first"; readonly machines: readonly M[] }
  | { readonly kind: "create" };

/**
 * What Set up does: open the assistant a connected machine has; otherwise,
 * while some private machine is hidden from this app, offer Connect before a
 * second assistant is made. `separate` is the explicit choice to make one anyway.
 */
export function personalAssistantSetupStep<T extends AssistantCandidate, M>(input: {
  readonly projects: readonly T[];
  readonly unseenMachines: readonly M[];
  readonly separate?: boolean;
}): PersonalAssistantSetupStep<T, M> {
  const assistant = findPersonalAssistant(input.projects);
  if (assistant) return { kind: "open", assistant };
  if (!input.separate && input.unseenMachines.length > 0)
    return { kind: "connect-first", machines: input.unseenMachines };
  return { kind: "create" };
}
