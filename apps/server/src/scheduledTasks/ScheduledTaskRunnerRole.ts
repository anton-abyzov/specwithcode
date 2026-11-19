/**
 * What a routine's runner reads from this machine's coordinator role
 * (1390 AC-45). Kept out of the scheduler, which only passes it on.
 */
import type { ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { coordinatorStartedBeside } from "@specweave-studio/contracts";
import { type CoordinatorRoleShape, coordinatorRoleOf } from "../project/CoordinatorRole.ts";

/**
 * Whether this machine's copy of a project coordinates it now: the role
 * service's answer where there is one, else the project's own binding. A
 * project that is gone, or cannot be read, does not coordinate.
 */
export const makeRunnerRoleActive =
  (role: CoordinatorRoleShape | undefined, projects: ProjectStore.ProjectStoreV2["Service"]) =>
  (projectId: ProjectId): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      if (role !== undefined)
        return Option.match(yield* role.roleOf(projectId), {
          onNone: () => false,
          onSome: (status) => status.active,
        });
      const row = yield* projects
        .get(projectId)
        .pipe(Effect.orElseSucceed(() => Option.none<ProjectStore.ProjectRow>()));
      return Option.isSome(row)
        ? coordinatorRoleOf({
            id: row.value.projectId,
            workspaceSettings: row.value.workspaceSettings ?? undefined,
          }).active
        : false;
    });

/**
 * Whether this copy's binding is one the release before let fire the
 * project's routines alone: the project's own coordinator, or one that was
 * handed the role or took it over. A coordinator started beside it is active
 * too, but nothing ever fenced the other one for it, so it is not the owner:
 * its copy of a shared routine waits until the machines settle a runner.
 * Unreadable is not the owner.
 */
export const makeRunnerLegacyOwner =
  (projects: ProjectStore.ProjectStoreV2["Service"]) =>
  (projectId: ProjectId): Effect.Effect<boolean> =>
    projects.get(projectId).pipe(
      Effect.map(
        Option.match({
          onNone: () => false,
          onSome: (row) => {
            const binding = row.workspaceSettings?.coordinatorBinding;
            return (
              binding == null || (binding.state === "active" && !coordinatorStartedBeside(binding))
            );
          },
        }),
      ),
      Effect.orElseSucceed(() => false),
    );
