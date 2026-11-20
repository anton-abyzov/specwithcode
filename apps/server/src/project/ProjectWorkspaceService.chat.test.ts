// @effect-diagnostics nodeBuiltinImport:off -- the fixture names paths only; nothing reads or writes them.
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EventId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";
import {
  CHAT_CONTEXT_ROLE,
  CHAT_MEMORY_REFUSAL,
  isScratchWorkspaceRoot,
} from "./scratchProject.ts";

// A data folder that does not exist: nothing here reads or writes it.
const baseDir = NodePath.join(NodeOS.tmpdir(), "chat-without-project-test-base");
const scratchRoot = NodePath.join(baseDir, "scratch");
const chats = ProjectId.make("no-project");
const project = ProjectId.make("real-project");
const storage = ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const layer = Workspace.layer.pipe(
  Layer.provideMerge(storage),
  Layer.provideMerge(
    Layer.succeed(ServerConfig.ServerConfig, {
      baseDir,
      stateDir: NodePath.join(baseDir, "userdata"),
    } as unknown as ServerConfig.ServerConfig["Service"]),
  ),
);

const seed = (id: ProjectId, workspaceRoot: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make(`event:${id}`),
      aggregateKind: "project",
      aggregateId: id,
      occurredAt: "2026-11-19T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: id,
        title: id === chats ? "No project" : "Real project",
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-11-19T00:00:00.000Z",
        updatedAt: "2026-11-19T00:00:00.000Z",
      },
    });
    // Both carry a goal and instructions, as an older build could have saved for chats.
    const sql = yield* SqlClient.SqlClient;
    const settings = {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      goal: `Goal of ${id}`,
      instructions: `Instructions of ${id}`,
    };
    yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify(settings)} WHERE project_id=${id}`;
  });

it("recognizes the data folder's Scratch folder and nothing else", () => {
  assert.isTrue(isScratchWorkspaceRoot(baseDir, scratchRoot));
  assert.isTrue(isScratchWorkspaceRoot(baseDir, `${scratchRoot}/`));
  assert.isFalse(isScratchWorkspaceRoot(baseDir, NodePath.join(scratchRoot, "2026-11-19-a-chat")));
  assert.isFalse(isScratchWorkspaceRoot(baseDir, NodePath.join(NodeOS.tmpdir(), "scratch")));
});

it.layer(layer)("ProjectWorkspaceService for chats without a project", (it) => {
  it.effect("sends a chat no shared goal, instructions or memory, and a project all of them", () =>
    Effect.gen(function* () {
      yield* seed(chats, scratchRoot);
      yield* seed(project, NodePath.join(NodeOS.tmpdir(), "chat-test-real-project"));
      const sql = yield* SqlClient.SqlClient;
      // A row an older build let a chat write stays stored, unread.
      yield* sql`INSERT INTO project_memory (project_id,name,content,revision,updated_at,byte_length) VALUES (${chats},'MEMORY.md','Another chat wrote this',1,'2026-11-18T00:00:00.000Z',23)`;
      const service = yield* Workspace.ProjectWorkspaceService;

      const chat = yield* service.contextSnapshot(chats, ThreadId.make("chat-one"));
      assert.deepEqual(
        chat.map((section) => section.name),
        ["role"],
      );
      assert.equal(chat[0]?.value, CHAT_CONTEXT_ROLE);
      const text = yield* service.context(chats, ThreadId.make("chat-two"));
      assert.notInclude(text, "Goal of no-project");
      assert.notInclude(text, "Instructions of no-project");
      assert.notInclude(text, "Another chat wrote this");

      const real = yield* service.context(project, ThreadId.make("worker"));
      assert.include(real, "Goal of real-project");
      assert.include(real, "Instructions of real-project");

      // The stored row is neither listed nor readable from a chat, and it is not deleted.
      const workspace = yield* service.readWorkspace({ projectId: chats });
      assert.deepEqual(workspace.memory.files, []);
      const read = yield* Effect.exit(service.readMemory({ projectId: chats, name: "MEMORY.md" }));
      assert.isTrue(Exit.isFailure(read));
      const left = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM project_memory WHERE project_id = ${chats}`;
      assert.equal(left[0]?.n, 1);
    }),
  );

  it.effect("refuses memory writes and deletes for chats and says what to do instead", () =>
    Effect.gen(function* () {
      const service = yield* Workspace.ProjectWorkspaceService;
      const write = yield* Effect.flip(
        service.writeMemory({
          projectId: chats,
          name: "notes.md",
          content: "private to this chat?",
          expectedRevision: null,
        }),
      );
      assert.equal(write.code, "invalid");
      assert.equal(write.message, CHAT_MEMORY_REFUSAL);
      assert.include(write.message, "Move to project");
      const deleted = yield* Effect.flip(
        service.deleteMemory({ projectId: chats, name: "MEMORY.md", expectedRevision: 1 }),
      );
      assert.equal(deleted.message, CHAT_MEMORY_REFUSAL);

      // A real project still takes memory.
      const saved = yield* service.writeMemory({
        projectId: project,
        name: "notes.md",
        content: "kept",
        expectedRevision: null,
      });
      assert.equal(saved.revision, 1);
    }),
  );

  it.effect("offers a chat no knowledge to search", () =>
    Effect.gen(function* () {
      const service = yield* Workspace.ProjectWorkspaceService;
      const search = yield* Effect.flip(service.searchKnowledge({ projectId: chats, query: "x" }));
      assert.equal(search.code, "unavailable");
    }),
  );
});
