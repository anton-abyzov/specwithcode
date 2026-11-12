import type { GoogleService, ProjectId } from "@specweave-studio/contracts";

import {
  isArchivedMember,
  isAutomatedMember,
  isScratchMember,
  type ProjectListMember,
  type ScratchRootLookup,
} from "../../studio/projectListVisibility";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { visibleWithAideKeeping } from "../../studio/personalAssistant";

interface GoogleProjectAccess {
  readonly projectId: ProjectId;
  readonly services: ReadonlyArray<GoogleService>;
}

/**
 * The spaces Google access is offered to. Aide, the personal assistant, has its own group and
 * is never a project; a hidden one shows only while it holds access, so it can be turned off.
 * Projects are the person's own active ones, those a check or agent made for itself
 * (acceptance runs, fixtures, tests) and archived ones apart. Scratch is not a project.
 */
export function partitionGoogleProjects<
  P extends ProjectListMember & {
    readonly title: string;
    readonly workspaceSettings?: { readonly kind?: string | undefined } | null | undefined;
  },
>(
  projects: ReadonlyArray<P>,
  scratchRootFor: ScratchRootLookup,
  aide: { readonly enabled: boolean; readonly keepIds: ReadonlyArray<string> } = {
    enabled: true,
    keepIds: [],
  },
) {
  const sorted = visibleWithAideKeeping(projects, aide.enabled, aide.keepIds)
    .filter((project) => !isScratchMember(project, scratchRootFor))
    .toSorted((left, right) => left.title.localeCompare(right.title));
  const regular = sorted.filter((project) => !isPersonalAssistantProject(project));
  const current = regular.filter((project) => !isArchivedMember(project));
  return {
    assistants: sorted.filter(isPersonalAssistantProject),
    active: current.filter((project) => !isAutomatedMember(project)),
    automated: current.filter(isAutomatedMember),
    archived: regular.filter(isArchivedMember),
  };
}

/** The services that set up Aide's own briefing routine once the assistant may read one. */
const BRIEFING_SERVICES: ReadonlyArray<GoogleService> = ["gmail", "calendar"];

/**
 * The briefing a row offers. The machine's assistant gets the Proactive briefing routine on
 * its own once it may read Gmail or Calendar, so its row opens Routines instead of proposing a
 * second briefing. A hidden assistant runs no routines; any other row may add a Morning briefing.
 */
export function googleBriefingAction(
  services: ReadonlyArray<GoogleService>,
  row: {
    readonly machineAssistant: boolean;
    readonly assistant: boolean;
    readonly aideEnabled: boolean;
  },
): "proactive" | "morning" | null {
  if (services.length === 0) return null;
  if (row.assistant && !row.aideEnabled) return null;
  if (row.machineAssistant && services.some((service) => BRIEFING_SERVICES.includes(service)))
    return "proactive";
  return "morning";
}

/** The access changes that turn one service on or off for the given projects; unchanged ones are left out. */
export function bulkServiceChanges(
  access: ReadonlyArray<GoogleProjectAccess>,
  projectIds: ReadonlyArray<ProjectId>,
  service: GoogleService,
  on: boolean,
): GoogleProjectAccess[] {
  const changes: GoogleProjectAccess[] = [];
  for (const projectId of projectIds) {
    const current = access.find((entry) => entry.projectId === projectId)?.services ?? [];
    if (current.includes(service) === on) continue;
    changes.push({
      projectId,
      services: on ? [...current, service] : current.filter((entry) => entry !== service),
    });
  }
  return changes;
}

/** The access changes that give every project all the granted services it lacks. */
export function enableAllChanges(
  access: ReadonlyArray<GoogleProjectAccess>,
  projectIds: ReadonlyArray<ProjectId>,
  granted: ReadonlyArray<GoogleService>,
): GoogleProjectAccess[] {
  const changes: GoogleProjectAccess[] = [];
  for (const projectId of projectIds) {
    const current = access.find((entry) => entry.projectId === projectId)?.services ?? [];
    const missing = granted.filter((service) => !current.includes(service));
    if (missing.length > 0) changes.push({ projectId, services: [...current, ...missing] });
  }
  return changes;
}
