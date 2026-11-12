import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { isAppScratchFolder, projectOrigin } from "@specweave-studio/shared/projectOrigin";
import { isScratchProject } from "./projects.ts";

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
/**
 * "work" (the default) offers the person's own projects but no personal assistant, which
 * has its own entry; "design" and "any" offer assistants too; "code" offers code projects.
 */
export type ProjectPickerPurpose = "work" | "design" | "code" | "any";
export type IneligibleProjectReason =
  | "scratch"
  | "archived"
  | "automated"
  | "not-code"
  | "assistant";

export function projectChoiceIneligibleReason(
  project: PickerProject,
  scratchRootFor: ScratchRootLookup,
  purpose: ProjectPickerPurpose = "work",
): IneligibleProjectReason | null {
  if (project.workspaceRoot !== undefined) {
    const scratchRoot = scratchRootFor(project.environmentId);
    // Without the machine's scratch path (not arrived, or not readable with this
    // session's scopes), the app's scratch folder is still "No project", never automated.
    if (
      scratchRoot == null
        ? isAppScratchFolder(project.workspaceRoot)
        : isScratchProject({ workspaceRoot: project.workspaceRoot }, scratchRoot)
    )
      return "scratch";
  }
  if (project.workspaceSettings?.archived === true) return "archived";
  if (
    projectOrigin({
      workspaceRoot: project.workspaceRoot ?? "",
      workspaceSettings: project.workspaceSettings,
    }) === "automated"
  )
    return "automated";
  const kind = project.workspaceSettings?.kind ?? "code";
  if (purpose === "code") return kind === "code" ? null : "not-code";
  return purpose === "work" && kind === "personal" ? "assistant" : null;
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
