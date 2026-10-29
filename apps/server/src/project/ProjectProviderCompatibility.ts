import {
  fullAccessAcpProjectFolders,
  providerEnforcesProjectFolders,
  type ModelSelection,
  type Project,
  type ServerProvider,
} from "@specweave-studio/contracts";

type ProjectProviderContext = Pick<Project, "workspaceRoot" | "workspaceSettings">;

/** Match the directory-grant shape enforced by ProjectEnvironmentRuntime. */
export function projectNeedsAdditionalDirectoryGrants(
  project: ProjectProviderContext | null | undefined,
  cwd?: string | null,
): boolean {
  const environment = project?.workspaceSettings?.environment;
  // Empty legacy environments bypass the runtime directory-grant wrapper.
  if (!project || !environment) return false;
  if (environment.additionalFolders.length > 0) return true;
  return environment.repositories.length > 0 && cwd != null && cwd !== project.workspaceRoot;
}

/** Directory support is separate from readiness, quota and billing eligibility. */
export function projectCompatibleProviders(input: {
  readonly project: ProjectProviderContext | null | undefined;
  readonly cwd?: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly runtimePolicy?: Parameters<typeof fullAccessAcpProjectFolders>[0];
}): ReadonlyArray<ServerProvider> {
  if (!projectNeedsAdditionalDirectoryGrants(input.project, input.cwd)) return input.providers;
  return input.providers.filter(
    (provider) =>
      providerEnforcesProjectFolders(provider.driver) ||
      (provider.driver === "acpRegistry" &&
        input.runtimePolicy !== undefined &&
        fullAccessAcpProjectFolders(input.runtimePolicy) &&
        (provider.supportedRuntimeModes === undefined ||
          provider.supportedRuntimeModes.length === 0 ||
          provider.supportedRuntimeModes.includes("full-access"))),
  );
}

/** An explicit saved model stays saved, but cannot bypass the directory boundary. */
export function isProjectModelSelectionCompatible(input: {
  readonly project: ProjectProviderContext | null | undefined;
  readonly cwd?: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly selection: ModelSelection;
  readonly runtimePolicy?: Parameters<typeof fullAccessAcpProjectFolders>[0];
}): boolean {
  if (!projectNeedsAdditionalDirectoryGrants(input.project, input.cwd)) return true;
  return projectCompatibleProviders(input).some(
    (provider) => provider.instanceId === input.selection.instanceId,
  );
}
