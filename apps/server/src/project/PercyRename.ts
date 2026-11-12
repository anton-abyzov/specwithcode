/**
 * The assistant's default name changed from "Aide" to "Percy". Migration 075
 * lists, once, the personal assistants still titled exactly "Aide"; this
 * renames each through `project.meta.update`, so the change is an ordinary
 * event every client sees, and removes its row. A name the person chose is
 * never touched, and an assistant renamed back to "Aide" later stays "Aide"
 * because nothing lists it again.
 */
import {
  CommandId,
  DEFAULT_PERSONAL_ASSISTANT_NAME,
  PREVIOUS_PERSONAL_ASSISTANT_NAME,
  ProjectId,
  logicalProjectTitle,
  projectNameKey,
} from "@specweave-studio/contracts";
import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { forkParked } from "../serverActivation.ts";
import { ProjectService } from "./ProjectService.ts";

export type PercyRenameOutcome = "renamed" | "skipped" | "kept";

/**
 * Rename every listed assistant. "skipped" rows (no longer personal, renamed
 * meanwhile, deleted, or another project already called "Percy") are removed
 * and logged; a failed rename keeps its row for the next start.
 */
export const runPending = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const service = yield* ProjectService;

  const pending = yield* sql<{ readonly project_id: string }>`
    SELECT project_id FROM percy_rename_pending ORDER BY project_id
  `;
  if (pending.length === 0) return new Map<string, PercyRenameOutcome>();

  const outcomes = new Map<string, PercyRenameOutcome>();
  for (const { project_id } of pending) {
    const projectId = ProjectId.make(project_id);
    const rows = yield* projects.list();
    const row = rows.find((candidate) => candidate.projectId === projectId);
    const stillDefault =
      row !== undefined &&
      isPersonalAssistantProject(row) &&
      logicalProjectTitle(row).trim() === PREVIOUS_PERSONAL_ASSISTANT_NAME;
    const nameTaken = rows.some(
      (other) =>
        other.projectId !== projectId &&
        projectNameKey(logicalProjectTitle(other)) ===
          projectNameKey(DEFAULT_PERSONAL_ASSISTANT_NAME),
    );

    let outcome: PercyRenameOutcome;
    if (!stillDefault) {
      outcome = "skipped";
    } else if (nameTaken) {
      yield* Effect.logWarning(
        `Kept the assistant's name "${PREVIOUS_PERSONAL_ASSISTANT_NAME}": another project is already called "${DEFAULT_PERSONAL_ASSISTANT_NAME}"`,
      ).pipe(Effect.annotateLogs({ projectId }));
      outcome = "skipped";
    } else {
      outcome = yield* service
        .update({
          commandId: CommandId.make(`percy-rename:${projectId}`),
          projectId,
          title: DEFAULT_PERSONAL_ASSISTANT_NAME,
        })
        .pipe(
          Effect.as<PercyRenameOutcome>("renamed"),
          Effect.catch((cause) =>
            Effect.logWarning(
              `Could not rename the assistant to "${DEFAULT_PERSONAL_ASSISTANT_NAME}"; will retry on the next start`,
            ).pipe(
              Effect.annotateLogs({ projectId, cause }),
              Effect.as<PercyRenameOutcome>("kept"),
            ),
          ),
        );
    }
    if (outcome !== "kept") {
      yield* sql`DELETE FROM percy_rename_pending WHERE project_id = ${project_id}`;
    }
    outcomes.set(project_id, outcome);
  }
  return outcomes;
});

/** Runs once after the server is up; failures are logged and never block startup. */
export const start = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const service = yield* ProjectService;
  yield* forkParked(
    runPending.pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.provideService(ProjectStore.ProjectStoreV2, projects),
      Effect.provideService(ProjectService, service),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not rename the assistant to its new default name", { cause }),
      ),
    ),
  );
});
