import {
  ProjectEnvironmentError,
  type ProjectEnvironmentImportInput,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { ProjectEnvironmentService } from "./ProjectEnvironmentService.ts";
import type { ProjectService } from "./ProjectService.ts";

/** Repeat the inspection, then use the normal revision-checked project mutation.
 * Permission changes during inspection invalidate its revision; update rechecks all path grants.
 */
export const applyWorkspaceImport = (
  environment: ProjectEnvironmentService["Service"],
  projects: Pick<ProjectService["Service"], "update" | "getById">,
  input: ProjectEnvironmentImportInput,
) =>
  Effect.gen(function* () {
    const current = yield* projects.getById(input.projectId);
    if (Option.isNone(current))
      return yield* new ProjectEnvironmentError({ projectId: input.projectId, code: "not_found" });
    if (current.value.workspaceSettings?.paused || current.value.workspaceSettings?.archived)
      return yield* new ProjectEnvironmentError({ projectId: input.projectId, code: "inactive" });
    const preview = yield* environment.previewImport(input);
    if (preview.revision !== input.expectedRevision || preview.fingerprint !== input.fingerprint)
      return yield* new ProjectEnvironmentError({
        projectId: input.projectId,
        code: "import_changed",
      });
    if (!preview.canApply)
      return yield* new ProjectEnvironmentError({
        projectId: input.projectId,
        code: "import_blocked",
      });
    if (preview.repositories.some((repo) => repo.status === "add")) {
      yield* projects.update({
        projectId: input.projectId,
        commandId: input.commandId,
        requireUnchangedEnvironmentPaths: true,
        workspaceSettings: { expectedRevision: preview.revision, environment: preview.environment },
      });
    }
    return yield* environment.read({ projectId: input.projectId });
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof ProjectEnvironmentError
        ? cause
        : new ProjectEnvironmentError({ projectId: input.projectId, code: "import_changed" }),
    ),
  );
