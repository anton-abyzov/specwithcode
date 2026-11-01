import type { ProjectId, RuntimeMode, ServerSettings } from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";

/**
 * The access a new chat starts with. A chat on another of the person's machines
 * starts with the access they chose on this one, not that machine's untouched
 * default; a project setting saved on that machine still wins.
 */
export function resolveDraftDefaultRuntimeMode(input: {
  readonly environmentSettings: ServerSettings;
  readonly projectId: ProjectId | null;
  /** This machine's settings, when the chat runs on another machine. */
  readonly primarySettings: ServerSettings | null;
}): RuntimeMode {
  const resolved = resolveProjectSettings(input.environmentSettings, input.projectId);
  return input.primarySettings !== null && resolved.sources.defaultRuntimeMode === "environment"
    ? resolveProjectSettings(input.primarySettings, null).settings.defaultRuntimeMode
    : resolved.settings.defaultRuntimeMode;
}
