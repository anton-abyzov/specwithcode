import { DEFAULT_SERVER_SETTINGS, type Project } from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/**
 * Background synchronization only fetches refs. There is no reliable exclusive
 * ownership signal for external native agents or terminals, even on a clean
 * default branch. Updating the checkout remains an explicit fast-forward pull.
 * The persisted defaultAutoPull flag is retained for compatibility and controls
 * this startup refresh; it never authorizes a background checkout mutation.
 */
export const refreshProjectUpstreams = Effect.fn("refreshProjectUpstreams")(function* (
  projects: ReadonlyArray<Pick<Project, "id" | "workspaceRoot">>,
  settings = DEFAULT_SERVER_SETTINGS,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workspaceRoots = [
    ...new Set(
      projects
        .filter((project) => resolveProjectSettings(settings, project.id).settings.defaultAutoPull)
        .map((project) => project.workspaceRoot),
    ),
  ];
  yield* Effect.forEach(
    workspaceRoots,
    (cwd) =>
      git
        .statusDetailsRemote(cwd)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Automatic project upstream refresh failed", { cwd, cause }),
          ),
        ),
    { concurrency: 4, discard: true },
  );
});
