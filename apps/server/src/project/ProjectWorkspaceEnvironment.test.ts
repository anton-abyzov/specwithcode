import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ThreadId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  PROJECT_CONTEXT_CHARACTER_LIMIT,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";
const layer = Workspace.layer.pipe(
  Layer.provideMerge(Projects.layer),
  Layer.provideMerge(Persistence.layerMemory),
);
it.effect(
  "delivers Personal and combined project locations as bounded context without borrowing another project's memory",
  () =>
    Effect.gen(function* () {
      const service = yield* Workspace.ProjectWorkspaceService;
      const projects = yield* Projects.ProjectStoreV2;
      const sql = yield* SqlClient.SqlClient;
      for (const id of ["personal-context", "other-context"]) {
        const projectId = ProjectId.make(id);
        yield* projects.apply({
          sequence: 1,
          eventId: EventId.make(id),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: "2026-10-09T00:00:00Z",
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.created",
          payload: {
            projectId,
            title: id,
            workspaceRoot: `/tmp/${id}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-10-09T00:00:00Z",
            updatedAt: "2026-10-09T00:00:00Z",
          },
        });
      }
      const projectId = ProjectId.make("personal-context");
      const settings = {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        kind: "personal",
        environment: {
          additionalFolders: ["/tmp/approved"],
          repositories: [
            { id: "docs", url: "https://github.com/example/docs", localPath: "/tmp/approved/docs" },
            { id: "app", url: "https://github.com/example/app", localPath: null },
          ],
        },
      };
      yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify(settings)} WHERE project_id=${projectId}`;
      yield* service.writeMemory({
        projectId: ProjectId.make("other-context"),
        name: "MEMORY.md",
        content: "Foreign private fact",
        expectedRevision: null,
      });
      const sections = yield* service.contextSnapshot(projectId, ThreadId.make("personal-worker"));
      const environment = sections.find((s) => s.name === "environment")!;
      for (const text of [
        "personal",
        "/tmp/personal-context",
        "/tmp/approved",
        "https://github.com/example/docs",
        "https://github.com/example/app",
        "studio_project_connections_list",
      ])
        assert.include(environment.value, text);
      assert.notInclude(sections.map((s) => s.value).join("\n"), "Foreign private fact");
      assert.include(environment.value, "not permission");
      const empty = yield* service.contextSnapshot(
        ProjectId.make("other-context"),
        ThreadId.make("other"),
      );
      assert.notInclude(empty.map((s) => s.value).join("\n"), "https://github.com/example/docs");
      const largeSettings = {
        ...settings,
        goal: "g".repeat(8000),
        instructions: "i".repeat(15975) + "LAST IMPORTANT RULE",
        environment: {
          additionalFolders: Array.from({ length: 16 }, (_, i) => `/tmp/${i}/${"f".repeat(3000)}`),
          repositories: settings.environment.repositories,
        },
      };
      yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify(largeSettings)} WHERE project_id=${projectId}`;
      const bounded = yield* service.contextSnapshot(projectId, ThreadId.make("personal-worker"));
      const boundedText = bounded.map((s) => s.value).join("\n");
      assert.include(bounded.find((s) => s.name === "instructions")!.value, "LAST IMPORTANT RULE");
      assert.isAtMost(boundedText.length, PROJECT_CONTEXT_CHARACTER_LIMIT);
      assert.include(
        bounded.find((s) => s.name === "environment")!.value,
        "Location list truncated",
      );
      assert.notInclude(boundedText, "Foreign private fact");
    }).pipe(Effect.provide(layer)),
);
