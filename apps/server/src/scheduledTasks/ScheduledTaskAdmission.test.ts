import { expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { assertTaskAdmission } from "./ScheduledTaskAdmission.ts";

it.effect(
  "blocks source coordinator routines after transfer and permits acknowledged worker routines",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project");
      const coordinator = ThreadId.make("project-coordinator:project");
      const worker = ThreadId.make("worker");
      for (const state of ["transferring", "transferred"] as const) {
        const check = (threadId: ThreadId | null) =>
          assertTaskAdmission({ id: ScheduledTaskId.make("routine"), projectId, threadId }).pipe(
            Effect.provideService(ProjectStore.ProjectStoreV2, {
              get: () =>
                Effect.succeed(
                  Option.some({
                    projectId,
                    workspaceSettings: {
                      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                      coordinatorThreadId: coordinator,
                      coordinatorBinding: { epoch: 0, state },
                    },
                  }),
                ),
            } as unknown as ProjectStore.ProjectStoreV2["Service"]),
            Effect.provideService(SqlClient.SqlClient, (() =>
              Effect.succeed([
                { project_id: projectId, deleted_at: null },
              ])) as unknown as SqlClient.SqlClient),
          );
        expect((yield* Effect.flip(check(coordinator))).message).toContain("handed off");
        for (const destination of [worker, null]) {
          if (state === "transferring")
            expect((yield* Effect.flip(check(destination))).message).toContain("handed off");
          else yield* check(destination);
        }
      }
    }),
);
