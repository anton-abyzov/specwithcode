import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { projectOrigin } from "@specweave-studio/shared/projectOrigin";
import { isScratchProject } from "./projects.js";

/** Minimal catalog fields shared by web and mobile project choices. */
export interface PickerProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly workspaceRoot?: string | undefined;
  readonly workspaceSettings?:
    | {
        readonly archived?: boolean | undefined;
        readonly origin?: string | undefined;
        readonly temporarySessionId?: string | undefined;
        readonly kind?: string | undefined;
      }
    | null
    | undefined;
}
export type ScratchRootLookup = (environmentId: EnvironmentId) => string | null | undefined;
export type ProjectPickerPurpose = "work" | "design" | "code";
export type IneligibleProjectReason = "scratch" | "archived" | "automated" | "not-code";

export function projectChoiceIneligibleReason(
  project: PickerProject,
  scratchRootFor: ScratchRootLookup,
  purpose: ProjectPickerPurpose = "work",
): IneligibleProjectReason | null {
  if (
    project.workspaceRoot !== undefined &&
    isScratchProject(
      { workspaceRoot: project.workspaceRoot },
      scratchRootFor(project.environmentId),
    )
  )
    return "scratch";
  if (project.workspaceSettings?.archived === true) return "archived";
  if (
    projectOrigin({
      workspaceRoot: project.workspaceRoot ?? "",
      workspaceSettings: project.workspaceSettings,
    }) === "automated"
  )
    return "automated";
  return purpose === "code" && (project.workspaceSettings?.kind ?? "code") !== "code"
    ? "not-code"
    : null;
}

/** Ordinary choices only. A caller displays an excluded current selection separately. */
export function projectPickerMembers<P extends PickerProject>(
  projects: readonly P[],
  scratchRootFor: ScratchRootLookup,
  purpose: ProjectPickerPurpose = "work",
): P[] {
  return projects.filter(
    (project) => projectChoiceIneligibleReason(project, scratchRootFor, purpose) === null,
  );
}
