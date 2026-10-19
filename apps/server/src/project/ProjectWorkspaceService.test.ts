import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ThreadId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  PROJECT_CONTEXT_CHARACTER_LIMIT,
  PROJECT_MEMORY_FILE_BYTES,
  PROJECT_MEMORY_MAX_FILES,
  PROJECT_MEMORY_TOTAL_BYTES,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Workspace from "./ProjectWorkspaceService.ts";
const projectId = ProjectId.make("workspace-one");
const secondId = ProjectId.make("workspace-two");
const storage = ProjectStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const layer = Workspace.layer.pipe(Layer.provideMerge(storage));
const seed = (id = projectId) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make(`event:${id}`),
      aggregateKind: "project",
      aggregateId: id,
      occurredAt: "2026-10-09T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: id,
        title: id,
        workspaceRoot: `/tmp/${id}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T00:00:00.000Z",
      },
    });
  });
it.layer(layer)("ProjectWorkspaceService", (it) => {
  it.effect(
    "gives personal coordinators native Google readiness guidance separately from external connections",
    () =>
      Effect.gen(function* () {
        const id = ProjectId.make("google-assistant");
        const coordinator = ThreadId.make("google-coordinator");
        yield* seed(id);
        const sql = yield* SqlClient.SqlClient;
        const settings = {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          kind: "personal",
          coordinatorThreadId: coordinator,
        };
        yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify(settings)} WHERE project_id=${id}`;
        const service = yield* Workspace.ProjectWorkspaceService;
        const context = yield* service.context(id, coordinator);
        // The setup and permission details live in the studio_google_status description.
        assert.include(context, "for Gmail, Calendar or Drive call studio_google_status first");
        assert.include(context, "web lookups and Gmail, Calendar or Drive reads");
        assert.include(context, "For requests that need a worker, route them at once");
        assert.include(context, "check the run before saying whether Google was reached");
        assert.isAtMost(context.length, PROJECT_CONTEXT_CHARACTER_LIMIT);
      }),
  );
  it.effect(
    "lists only sorted memory metadata and keeps UTF-8 totals current and project-scoped",
    () =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("populated-list");
        const other = ProjectId.make("populated-list-other");
        yield* seed(projectId);
        yield* seed(other);
        const service = yield* Workspace.ProjectWorkspaceService;
        const notes = yield* service.writeMemory({
          projectId,
          name: "notes.md",
          content: "café 😀",
          expectedRevision: null,
        });
        const index = yield* service.writeMemory({
          projectId,
          name: "MEMORY.md",
          content: "世界",
          expectedRevision: null,
        });
        const metadata = ({ content: _content, ...file }: typeof notes) => file;
        const first = (yield* service.readWorkspace({ projectId })).memory;
        assert.deepEqual(first.files, [metadata(index), metadata(notes)]);
        assert.equal(first.totalBytes, new TextEncoder().encode("世界café 😀").byteLength);
        assert.isFalse(first.files.some((file) => "content" in file));
        const replacement = yield* service.writeMemory({
          projectId,
          name: "notes.md",
          content: "é",
          expectedRevision: notes.revision,
        });
        yield* service.deleteMemory({
          projectId,
          name: "MEMORY.md",
          expectedRevision: index.revision,
        });
        const updated = (yield* service.readWorkspace({ projectId })).memory;
        assert.deepEqual(updated.files, [metadata(replacement)]);
        assert.equal(updated.files[0]?.revision, 2);
        assert.equal(updated.totalBytes, 2);
        assert.deepEqual((yield* service.readWorkspace({ projectId: other })).memory, {
          files: [],
          totalBytes: 0,
        });
      }),
  );
  it.effect(
    "defaults old projects and isolates memory with revision checks and durable recreation",
    () =>
      Effect.gen(function* () {
        yield* seed();
        yield* seed(secondId);
        const service = yield* Workspace.ProjectWorkspaceService;
        assert.deepEqual(
          (yield* service.readWorkspace({ projectId })).settings,
          DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        );
        const first = yield* service.writeMemory({
          projectId,
          name: "MEMORY.md",
          content: "one",
          expectedRevision: null,
        });
        assert.equal(first.revision, 1);
        assert.deepEqual((yield* service.readWorkspace({ projectId: secondId })).memory.files, []);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              service.writeMemory({
                projectId,
                name: "MEMORY.md",
                content: "stale",
                expectedRevision: null,
              }),
            ),
          ),
        );
        const next = yield* service.writeMemory({
          projectId,
          name: "MEMORY.md",
          content: "two",
          expectedRevision: 1,
        });
        assert.equal(next.revision, 2);
        yield* service.deleteMemory({ projectId, name: "MEMORY.md", expectedRevision: 2 });
        const recreated = yield* service.writeMemory({
          projectId,
          name: "MEMORY.md",
          content: "three",
          expectedRevision: null,
        });
        assert.equal(recreated.revision, 3);
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              service.writeMemory({
                projectId,
                name: "MEMORY.md",
                content: "stale",
                expectedRevision: 2,
              }),
            ),
          ),
        );
      }),
  );
  it.effect("allows only one concurrent writer for an expected revision", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("concurrency");
      yield* seed(projectId);
      const service = yield* Workspace.ProjectWorkspaceService;
      const results = yield* Effect.all(
        ["a", "b"].map((content) =>
          Effect.exit(
            service.writeMemory({ projectId, name: "MEMORY.md", content, expectedRevision: null }),
          ),
        ),
        { concurrency: 2 },
      );
      assert.equal(results.filter(Exit.isSuccess).length, 1);
    }),
  );
  it.effect(
    "rejects traversal, binary-size overflow, total overflow, missing projects and stale deletes",
    () =>
      Effect.gen(function* () {
        const projectId = ProjectId.make("bounds");
        yield* seed(projectId);
        const service = yield* Workspace.ProjectWorkspaceService;
        for (const name of [
          "../MEMORY.md",
          "/tmp/file.md",
          "a\\b.md",
          "a/other.md",
          "a..md",
          ".hidden.md",
        ]) {
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(
                service.writeMemory({ projectId, name, content: "x", expectedRevision: null }),
              ),
            ),
          );
        }
        // Four bytes each: 80,000 code points is 320,000 bytes, over the 256 KiB file limit.
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              service.writeMemory({
                projectId,
                name: "wide.md",
                content: "😀".repeat(80_000),
                expectedRevision: null,
              }),
            ),
          ),
        );
        const full = "x".repeat(PROJECT_MEMORY_FILE_BYTES);
        assert.equal(
          (yield* service.writeMemory({
            projectId,
            name: "full.md",
            content: full,
            expectedRevision: null,
          })).byteLength,
          PROJECT_MEMORY_FILE_BYTES,
        );
        assert.equal(
          (yield* service
            .writeMemory({
              projectId,
              name: "over.md",
              content: full + "x",
              expectedRevision: null,
            })
            .pipe(Effect.flip)).code,
          "invalid",
        );
        for (let i = 1; i < PROJECT_MEMORY_TOTAL_BYTES / PROJECT_MEMORY_FILE_BYTES; i++)
          yield* service.writeMemory({
            projectId,
            name: `part${i}.md`,
            content: full,
            expectedRevision: null,
          });
        assert.equal(
          (yield* service.readWorkspace({ projectId })).memory.totalBytes,
          PROJECT_MEMORY_TOTAL_BYTES,
        );
        assert.equal(
          (yield* service
            .writeMemory({ projectId, name: "extra.md", content: "x", expectedRevision: null })
            .pipe(Effect.flip)).code,
          "invalid",
        );
        // Replacing a file frees its old bytes before the total is checked.
        assert.equal(
          (yield* service.writeMemory({
            projectId,
            name: "full.md",
            content: "small",
            expectedRevision: 1,
          })).revision,
          2,
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              service.deleteMemory({ projectId, name: "part0.md", expectedRevision: 9 }),
            ),
          ),
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(service.readWorkspace({ projectId: ProjectId.make("missing") })),
          ),
        );
      }),
  );
  it.effect("holds an imported memory of hundreds of topic files and stops at the file limit", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("imported");
      yield* seed(projectId);
      const service = yield* Workspace.ProjectWorkspaceService;
      const sql = yield* SqlClient.SqlClient;
      const index = "- [Topic](project_topic_0001.md) — hook\n".repeat(1_600);
      assert.isAbove(new TextEncoder().encode(index).length, 65_536);
      yield* service.writeMemory({
        projectId,
        name: "MEMORY.md",
        content: index,
        expectedRevision: null,
      });
      for (let i = 0; i < 900; i++)
        yield* service.writeMemory({
          projectId,
          name: `project_topic_${String(i).padStart(4, "0")}.md`,
          content: `topic ${i}\n`.repeat(300),
          expectedRevision: null,
        });
      const memory = (yield* service.readWorkspace({ projectId })).memory;
      assert.equal(memory.files.length, 901);
      assert.isAbove(memory.totalBytes, 2_000_000);
      assert.equal(
        (yield* service.readMemory({ projectId, name: "project_topic_0899.md" })).content,
        "topic 899\n".repeat(300),
      );
      // The prompt still carries a bounded index and a counted inventory, not the stored megabytes.
      const context = yield* service.context(projectId, ThreadId.make("worker"));
      assert.isAtMost(context.length, PROJECT_CONTEXT_CHARACTER_LIMIT);
      assert.include(context, "more memory files; read them with studio_project_memory_read");
      assert.include(context, "<project_memory>");
      // Fill to the limit without 3,000 more round trips, then prove the next new name is refused.
      const now = "2026-10-09T00:00:00.000Z";
      for (let i = 901; i < PROJECT_MEMORY_MAX_FILES; i++)
        yield* sql`INSERT INTO project_memory (project_id,name,content,revision,updated_at,byte_length) VALUES (${projectId},${`fill${i}.md`},'x',1,${now},1)`;
      assert.equal(
        (yield* service.readWorkspace({ projectId })).memory.files.length,
        PROJECT_MEMORY_MAX_FILES,
      );
      assert.equal(
        (yield* service
          .writeMemory({ projectId, name: "one-too-many.md", content: "x", expectedRevision: null })
          .pipe(Effect.flip)).code,
        "invalid",
      );
      assert.equal(
        (yield* service.writeMemory({
          projectId,
          name: "MEMORY.md",
          content: "still editable",
          expectedRevision: 1,
        })).revision,
        2,
      );
    }),
  );
  it.effect("purges memory and scheduled prompt receipts on permanent project deletion", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("purge");
      yield* seed(projectId);
      const service = yield* Workspace.ProjectWorkspaceService;
      const sql = yield* SqlClient.SqlClient;
      yield* service.writeMemory({
        projectId,
        name: "MEMORY.md",
        content: "private project notes",
        expectedRevision: null,
      });
      yield* sql`INSERT INTO scheduled_task_run_receipts (command_id,project_id,task_id,task_created_at,started_at,result_json) VALUES ('purge-run',${projectId},'deleted-task','2026-10-09T00:00:00.000Z','2026-10-09T00:00:00.000Z','{"prompt":"private prompt"}')`;
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply({
        sequence: 2,
        eventId: EventId.make("purge-project"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-10-09T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.deleted",
        payload: { projectId, deletedAt: "2026-10-09T00:00:00.000Z" },
      });
      assert.deepEqual(yield* sql`SELECT * FROM project_memory WHERE project_id=${projectId}`, []);
      assert.deepEqual(
        yield* sql`SELECT * FROM project_memory_revisions WHERE project_id=${projectId}`,
        [],
      );
      assert.deepEqual(
        yield* sql`SELECT * FROM scheduled_task_run_receipts WHERE project_id=${projectId}`,
        [],
      );
      assert.equal(
        (yield* service.readWorkspace({ projectId }).pipe(Effect.flip)).code,
        "not_found",
      );
      assert.equal(
        (yield* service
          .writeMemory({ projectId, name: "MEMORY.md", content: "late", expectedRevision: null })
          .pipe(Effect.flip)).code,
        "not_found",
      );
    }),
  );
  it.effect("guards paused and archived admission; reloads bounded context", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("lifecycle");
      yield* seed(projectId);
      const service = yield* Workspace.ProjectWorkspaceService;
      const sql = yield* SqlClient.SqlClient;
      const settings = {
        ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
        revision: 1,
        paused: true,
        goal: "Goal",
        instructions: "Instructions",
        coordinatorThreadId: ThreadId.make("coord"),
      };
      yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify(settings)} WHERE project_id=${projectId}`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(service.assertAdmission(projectId))));
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(service.context(projectId, ThreadId.make("coord")))),
      );
      assert.include(yield* service.context(projectId, ThreadId.make("worker")), "Instructions");
      yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...settings, paused: false, archived: true })} WHERE project_id=${projectId}`;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(service.context(projectId, ThreadId.make("worker")))),
      );
    }),
  );
});
it("preserves maximum instructions and goal while bounding memory and link inventory", () => {
  const text = Workspace.projectContextText({
    projectId: "p",
    threadId: "c",
    settings: {
      ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
      goal: "g".repeat(8000),
      instructions: "i".repeat(15990) + "LAST RULE",
      coordinatorThreadId: ThreadId.make("c"),
    },
    files: Array(128).fill("x".repeat(120) + ".md"),
    index: "m".repeat(65536),
  });
  assert.isAtMost(text.length, PROJECT_CONTEXT_CHARACTER_LIMIT);
  assert.include(text, "LAST RULE");
  assert.include(text, "threadLink");
  assert.include(text, "Never build a studio://thread link by hand");
  assert.include(text, "truncated");
});
it("asks workers for short reports and the coordinator to relay only their outcome", () => {
  const settings = {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    goal: "g",
    instructions: "i",
    coordinatorThreadId: ThreadId.make("c"),
  };
  const worker = Workspace.projectContextText({
    projectId: "p",
    threadId: "w",
    settings,
    files: [],
    index: "",
  });
  // Report length and the **Blockers:** paragraph come from the runtime response style.
  assert.include(worker, "Your final message is your report");
  assert.include(worker, "Write every file or folder path in full from the root");
  // A worker that works an increment closes it once its last task is done.
  assert.include(worker, 'ends with "Verify and close NNNN"');
  assert.include(worker, "close it in this thread without asking");
  assert.notInclude(worker, "<response_style>");
  assert.notInclude(worker, "Studio");
  // Detailed may include steps, so the fixed worker text must not forbid them.
  assert.notInclude(worker, "not a replay of your steps");
  assert.notInclude(worker, "add detail only when asked");
  const coordinator = Workspace.projectContextText({
    projectId: "p",
    threadId: "c",
    settings,
    files: [],
    index: "",
  });
  assert.notInclude(coordinator, 'never "Studio"');
  assert.include(coordinator, "You coordinate this project's work and do none of it yourself");
  assert.include(coordinator, "do not relay, summarize or repeat its result here");
  assert.include(coordinator, "otherwise end the turn without a reply");
  assert.include(coordinator, "start a worker to verify, review and close it");
  assert.notInclude(coordinator, "relay its outcome");
  assert.include(worker, "the user reads it in this thread");
  assert.notInclude(coordinator, "not a replay of your steps");
});
it("tells a coordinator how to run workers on another machine and where this project's go", () => {
  const settings = {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    goal: "g",
    instructions: "i",
    coordinatorThreadId: ThreadId.make("c"),
  };
  const coordinator = Workspace.projectContextText({
    projectId: "p",
    threadId: "c",
    settings,
    files: [],
    index: "",
  });
  // Without a fleet the prompt stays as it was.
  assert.notInclude(coordinator, "studio_machine_list");
  assert.notInclude(coordinator, "Settings > Connections");
  const fleet = [{ id: "studio-b", label: "Studio B" }];
  const withFleet = Workspace.projectContextText({
    projectId: "p",
    threadId: "c",
    settings,
    files: [],
    index: "",
    fleet,
  });
  assert.include(withFleet, "pass it as machine to studio_thread_launch");
  assert.include(withFleet, "studio_machine_list");
  assert.include(withFleet, "Settings > Connections");
  assert.notInclude(withFleet, "This project's workers run on");
  const routed = Workspace.projectContextText({
    projectId: "p",
    threadId: "c",
    fleet,
    settings: {
      ...settings,
      workerMachine: {
        machineId: "studio-b",
        environmentId: EnvironmentId.make("env-m1"),
        projectId: null,
      },
    },
    files: [],
    index: "",
  });
  // Named by label, the way the user sees it.
  assert.include(routed, "This project's workers run on Studio B:");
  assert.notInclude(routed, "studio-b");
  const worker = Workspace.projectContextText({
    projectId: "p",
    threadId: "w",
    settings,
    files: [],
    index: "",
    fleet,
  });
  assert.notInclude(worker, "studio_machine_list");
});
