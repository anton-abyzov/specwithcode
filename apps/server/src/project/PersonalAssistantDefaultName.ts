/**
 * Gives an existing personal assistant the current default name when it still
 * carries a default from an earlier release, so the owner sees one name.
 *
 * Only a personal project whose title is exactly an old default (for example
 * "Aide") is renamed; a name the person chose, and every code project, stays as
 * it is. The rename goes through the same project update a person's rename
 * uses, so it is an ordinary event: open windows follow it and a rebuild keeps
 * it. The command id is stable per project, so a repeated run replays its
 * receipt and never renames again, even if the person later picks the old name.
 *
 * @module PersonalAssistantDefaultName
 */
import {
  CommandId,
  DEFAULT_PERSONAL_ASSISTANT_NAME,
  LEGACY_PERSONAL_ASSISTANT_NAMES,
  logicalProjectTitle,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as ProjectService from "./ProjectService.ts";

/** Bumped only if a later default needs to rename the same projects again. */
const COMMAND_VERSION = "v1";

/** One rename per project, ever: a reused id replays its receipt and changes nothing. */
export const defaultNameCommandId = (projectId: ProjectId) =>
  CommandId.make(`personal-assistant-default-name:${COMMAND_VERSION}:${projectId}`);

/** Whether this project is a personal assistant still named by an old default. */
export function hasLegacyDefaultName(project: {
  readonly title: string;
  readonly workspaceSettings?:
    | {
        readonly kind?: string | undefined;
        readonly logicalProject?: { readonly title: string } | null | undefined;
      }
    | null
    | undefined;
}): boolean {
  return (
    project.workspaceSettings?.kind === "personal" &&
    LEGACY_PERSONAL_ASSISTANT_NAMES.includes(logicalProjectTitle(project))
  );
}

export interface DefaultNameSummary {
  readonly renamed: number;
  readonly failed: number;
  /** Left for a later start because another project has the new name. */
  readonly waiting: number;
}

/**
 * One pass over the projects, archived ones included. While another project has
 * the new name the assistant waits for a later start; any other failure is logged
 * and the project is left as it was.
 */
export const renameLegacyDefaultAssistants = Effect.fn(
  "PersonalAssistantDefaultName.renameLegacyDefaultAssistants",
)(function* () {
  const projects = yield* ProjectService.ProjectService;
  const shells = yield* projects.listShells();
  let renamed = 0;
  let failed = 0;
  let waiting = 0;
  for (const project of shells) {
    if (!hasLegacyDefaultName(project)) continue;
    const from = logicalProjectTitle(project);
    // No command while the name is taken: a refused one would be replayed on every start.
    const taken = shells.some(
      (other) =>
        other.id !== project.id &&
        logicalProjectTitle(other).trim().toLowerCase() ===
          DEFAULT_PERSONAL_ASSISTANT_NAME.toLowerCase(),
    );
    if (taken) {
      waiting += 1;
      continue;
    }
    const outcome = yield* projects
      .update({
        projectId: project.id,
        commandId: defaultNameCommandId(project.id),
        title: DEFAULT_PERSONAL_ASSISTANT_NAME,
      })
      .pipe(
        // A replayed receipt (the person chose the old name again since) changes nothing.
        Effect.map((saved) =>
          logicalProjectTitle(saved) === DEFAULT_PERSONAL_ASSISTANT_NAME ? "renamed" : "kept",
        ),
        Effect.catch((error) =>
          Effect.logWarning("Could not give the personal assistant its new default name", {
            projectId: project.id,
            error,
          }).pipe(Effect.as("failed" as const)),
        ),
      );
    if (outcome === "renamed") {
      renamed += 1;
      yield* Effect.logInfo("Renamed the personal assistant to its new default name", {
        projectId: project.id,
        from,
        to: DEFAULT_PERSONAL_ASSISTANT_NAME,
      });
    } else if (outcome === "failed") {
      failed += 1;
    }
  }
  return { renamed, failed, waiting } satisfies DefaultNameSummary;
});
