import { ProjectId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";

export const routineProject = (projectId: ProjectId): ProjectStore.ProjectRow => ({
  projectId,
  title: "Synthetic routine project",
  workspaceRoot: "/synthetic-project",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-09-09T12:00:00.000Z",
  updatedAt: "2026-09-09T12:00:00.000Z",
  deletedAt: null,
});
export const activeProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
  get: (id) => Effect.succeed(Option.some(routineProject(id))),
});
