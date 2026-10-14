/** One entry point across the loaded fleet. Keep legacy duplicates and history intact. */
export function findPersonalAssistant<
  T extends {
    workspaceSettings?:
      | { kind?: string | undefined; archived?: boolean | undefined }
      | null
      | undefined;
  },
>(projects: readonly T[]): T | undefined {
  const assistants = projects.filter((project) => project.workspaceSettings?.kind === "personal");
  return assistants.find((project) => !project.workspaceSettings?.archived) ?? assistants[0];
}

/** All clients with the same fleet converge on one host, including when it is offline. */
export function personalAssistantCreationEnvironment<T extends string>(
  environmentIds: readonly T[],
): T | null {
  return [...environmentIds].sort()[0] ?? null;
}
