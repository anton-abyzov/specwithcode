import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { findProjectGroup } from "../components/studio/ProjectWorkspace";
import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";
import { useAideEnabled, useAideSettingSettled } from "../hooks/useSettings";
import { useProjects, useThreadShell } from "../state/entities";
import type { ScopedThreadRef } from "@specweave-studio/contracts";

/**
 * Whether a project page opens a personal assistant that is hidden (Settings →
 * General). Only once the setting is known: a link to the assistant must not be
 * sent away while settings are still loading.
 */
export function isHiddenAideRoute(input: {
  readonly group:
    | { readonly memberProjects: ReadonlyArray<Parameters<typeof isPersonalAssistantProject>[0]> }
    | undefined;
  readonly aideEnabled: boolean;
  readonly settled: boolean;
}): boolean {
  if (input.aideEnabled || !input.settled || input.group === undefined) return false;
  return input.group.memberProjects.some(isPersonalAssistantProject);
}

/** Whether `/projects/$projectKey` names a hidden personal assistant; the route then leaves for Overview. */
export function useHiddenAideRoute(projectKey: string): boolean {
  const groups = useSettingsProjectGroups();
  const aideEnabled = useAideEnabled();
  const settled = useAideSettingSettled();
  return isHiddenAideRoute({ group: findProjectGroup(groups, projectKey), aideEnabled, settled });
}

/**
 * Whether a chat belongs to a personal assistant that is hidden. Same rule as a
 * project page: only once the setting is known, and only for a chat whose
 * project is loaded and personal.
 */
export function isHiddenAideThread(input: {
  readonly project: Parameters<typeof isPersonalAssistantProject>[0];
  readonly aideEnabled: boolean;
  readonly settled: boolean;
}): boolean {
  if (input.aideEnabled || !input.settled) return false;
  return isPersonalAssistantProject(input.project);
}

/** Whether `/$environmentId/$threadId` opens a hidden personal assistant's chat; the route then leaves for Overview. */
export function useHiddenAideThread(threadRef: ScopedThreadRef | null): boolean {
  const thread = useThreadShell(threadRef);
  const projects = useProjects();
  const aideEnabled = useAideEnabled();
  const settled = useAideSettingSettled();
  const project =
    thread === null
      ? undefined
      : projects.find(
          (candidate) =>
            candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
        );
  return isHiddenAideThread({ project, aideEnabled, settled });
}
