import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EventId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";
import {
  type ProjectPlanActor,
  type ProjectPlanDefinition,
  type ProjectPlanSnapshot,
} from "../../../../packages/contracts/src/projectPlan.ts";
import * as Plans from "./ProjectPlanService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { parseSpecWeavePlan } from "./plan/SpecWeavePlanReader.ts";
import { renderPlanMarkdown } from "./plan/renderPlanMarkdown.ts";

const user: ProjectPlanActor = { kind: "user" };
const worker = (id: string): ProjectPlanActor => ({ kind: "thread", threadId: ThreadId.make(id) });
const storage = Sqlite.layerMemory;
const shells = Layer.mock(ProjectionStore.ProjectionStoreV2)({
  getThreadShell: (id) =>
    Effect.succeed(
      id === "missing"
        ? null
        : {
            ...liveThreadShell(id),
            projectId: ProjectId.make(id.split(":")[0]!),
            archivedAt: id.endsWith(":archived")
              ? DateTime.makeUnsafe("2026-10-09T00:00:00.000Z")
              : null,
          },
    ),
});
const dependencies = Layer.mergeAll(Projects.layer, shells, ProcessRunner.layer).pipe(
  Layer.provideMerge(storage),
  Layer.provideMerge(NodeServices.layer),
);
const layer = Plans.layer.pipe(Layer.provideMerge(dependencies));
const fixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-plan-" });
    const projectId = ProjectId.make(name);
    const projects = yield* Projects.ProjectStoreV2;
    yield* projects.apply({
      sequence: 1,
      eventId: EventId.make(`event:${name}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-10-09T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: name,
        workspaceRoot: root,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-09T00:00:00.000Z",
        updatedAt: "2026-10-09T00:00:00.000Z",
      },
    });
    const service = yield* Plans.ProjectPlanService;
    return { projectId, root, service, fs };
  });
const definition = (script = 'console.log("verified actual process")'): ProjectPlanDefinition => ({
  spec: "A durable plan without any installed CLI.",
  criteria: [{ id: "AC-1", text: "The test passes." }],
  tasks: [
    {
      id: "T-1",
      title: "Build the project",
      criterionIds: ["AC-1"],
      verification: { executable: process.execPath, args: ["-e", script], timeoutMs: 5_000 },
    },
  ],
});
const firstTask = (plan: ProjectPlanSnapshot) => plan.native!.tasks[0]!;
const init = (
  service: Plans.ProjectPlanService["Service"],
  projectId: ProjectId,
  value = definition(),
) => service.replace({ projectId, actor: user, expectedRevision: 0, definition: value });
const externalSpec =
  "# Example\n## Tasks\n### T-01 Implement\n- AC: AC-01 | Files: src/a.ts | Test: npm test\n";
const ledgerLine = (e = "claim", by = "existing-owner", at = "2025-01-01T00:00:00.000Z") =>
  JSON.stringify({
    t: "T-01",
    e,
    by,
    at,
    ...(e === "done" ? { evidence: "commit; tests reported by external owner" } : {}),
  }) + "\n";
const externalFiles = (root: string, spec = externalSpec, ledger = ledgerLine()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${root}/.specweave/increments/0888-example`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/spec.md`, spec);
    yield* fs.writeFileString(`${dir}/ledger.jsonl`, ledger);
    return dir;
  });
const bind = (
  service: Plans.ProjectPlanService["Service"],
  projectId: ProjectId,
  root: string,
  expectedRevision = 0,
) =>
  service.configure({
    projectId,
    actor: user,
    expectedRevision,
    authority: { kind: "specweave", root, incrementId: "0888-example" },
    discardNative: false,
  });

it.layer(layer, { excludeTestServices: true })("ProjectPlanService", (it) => {
  it.effect("persists plain plans, isolates projects, and starts without any CLI integration", () =>
    Effect.gen(function* () {
      const { service, projectId } = yield* fixture("plain");
      const other = yield* fixture("plain-other");
      assert.deepEqual((yield* service.read({ projectId })).authority, { kind: "native" });
      const saved = yield* init(service, projectId);
      assert.equal(saved.revision, 1);
      assert.equal(saved.native!.contentRevision, 1);
      assert.equal((yield* service.read({ projectId })).native!.spec, definition().spec);
      assert.equal((yield* service.read({ projectId: other.projectId })).revision, 0);
      // Reconstruct the service over the same durable SQL store; no CLI process is started.
      const reopened = yield* Effect.gen(function* () {
        const next = yield* Plans.ProjectPlanService;
        return yield* next.read({ projectId });
      }).pipe(Effect.provide(Layer.fresh(Plans.layer)));
      assert.deepEqual(reopened, saved);
    }),
  );
  it.effect("one concurrent CAS writer succeeds and stale definitions cannot overwrite", () =>
    Effect.gen(function* () {
      const { service, projectId } = yield* fixture("cas");
      const results = yield* Effect.all(
        ["left", "right"].map((spec) =>
          Effect.exit(init(service, projectId, { ...definition(), spec })),
        ),
        { concurrency: 2 },
      );
      assert.equal(results.filter(Exit.isSuccess).length, 1);
      assert.equal((yield* init(service, projectId).pipe(Effect.flip)).code, "conflict");
      assert.equal((yield* service.read({ projectId })).revision, 1);
    }),
  );
  it.effect("validates duplicate IDs, missing criteria, UTF-8 byte limits and command bounds", () =>
    Effect.gen(function* () {
      const { service, projectId } = yield* fixture("invalid");
      const original = definition();
      const invalid: ProjectPlanDefinition[] = [
        { ...original, tasks: [original.tasks[0]!, original.tasks[0]!] },
        { ...original, criteria: [original.criteria[0]!, original.criteria[0]!] },
        { ...original, criteria: [] },
        { ...original, spec: "😀".repeat(17_000) },
        {
          ...original,
          tasks: [
            {
              ...original.tasks[0]!,
              verification: { executable: "node\0", args: [], timeoutMs: 1_000 },
            },
          ],
        },
        {
          ...original,
          tasks: [
            {
              ...original.tasks[0]!,
              verification: { executable: "node", args: [], timeoutMs: 120_001 },
            },
          ],
        },
      ];
      for (const value of invalid)
        assert.equal((yield* init(service, projectId, value).pipe(Effect.flip)).code, "invalid");
      assert.equal((yield* service.read({ projectId })).revision, 0);
    }),
  );
  it.effect(
    "preserves foreign claims and forbids foreign, archived and missing thread actors",
    () =>
      Effect.gen(function* () {
        const { service, projectId } = yield* fixture("owners");
        yield* init(service, projectId);
        for (const actor of [
          worker("other:worker"),
          worker("owners:archived"),
          worker("missing"),
        ]) {
          assert.equal(
            (yield* service
              .claim({ projectId, expectedRevision: 1, taskId: "T-1", actor })
              .pipe(Effect.flip)).code,
            "forbidden",
          );
        }
        const owner = worker("owners:a");
        yield* service.claim({ projectId, expectedRevision: 1, taskId: "T-1", actor: owner });
        assert.equal(
          (yield* service
            .claim({ projectId, expectedRevision: 2, taskId: "T-1", actor: worker("owners:b") })
            .pipe(Effect.flip)).code,
          "claimed",
        );
        assert.equal(
          (yield* service
            .release({
              projectId,
              expectedRevision: 2,
              taskId: "T-1",
              actor: worker("owners:b"),
              expectedOwner: owner,
            })
            .pipe(Effect.flip)).code,
          "claimed",
        );
        assert.equal(
          (yield* service
            .replace({
              projectId,
              expectedRevision: 2,
              actor: user,
              definition: { ...definition(), tasks: [] },
            })
            .pipe(Effect.flip)).code,
          "claimed",
        );
        assert.equal(
          (yield* service
            .release({
              projectId,
              expectedRevision: 2,
              taskId: "T-1",
              actor: user,
              expectedOwner: worker("owners:wrong"),
            })
            .pipe(Effect.flip)).code,
          "conflict",
        );
        const released = yield* service.release({
          projectId,
          expectedRevision: 2,
          taskId: "T-1",
          actor: user,
          expectedOwner: owner,
        });
        assert.isNull(firstTask(released).owner);
        assert.equal(
          firstTask(
            yield* service.claim({
              projectId,
              expectedRevision: 3,
              taskId: "T-1",
              actor: worker("owners:b"),
            }),
          ).owner?.kind,
          "thread",
        );
      }),
  );
  it.effect("assistant completion remains reported_done and cannot self-attest verification", () =>
    Effect.gen(function* () {
      const { service, projectId } = yield* fixture("reported");
      yield* init(service, projectId);
      const actor = worker("reported:a");
      const reported = yield* service.report({
        projectId,
        expectedRevision: 1,
        taskId: "T-1",
        actor,
        status: "reported_done",
        note: "I tested everything",
      });
      assert.equal(firstTask(reported).status, "reported_done");
      assert.deepEqual(firstTask(reported).evidence, []);
      assert.equal(
        (yield* service
          .verify({
            projectId,
            expectedRevision: 2,
            taskId: "T-1",
            actor,
            commandId: CommandId.make("agent-check"),
          })
          .pipe(Effect.flip)).code,
        "forbidden",
      );
    }),
  );
  it.effect("a receipt-only recheck never executes an unreserved request", () =>
    Effect.gen(function* () {
      const { service, projectId, root, fs } = yield* fixture("recheck-only");
      yield* init(service, projectId, definition('require("node:fs").writeFileSync("ran", "yes")'));
      const request = {
        projectId,
        expectedRevision: 1,
        taskId: "T-1",
        actor: user,
        commandId: CommandId.make("never-reserved"),
        recheckOnly: true,
      };
      assert.equal((yield* service.verify(request).pipe(Effect.flip)).code, "receipt_unavailable");
      assert.equal(yield* fs.exists(`${root}/ran`), false);
      assert.deepEqual(firstTask(yield* service.read({ projectId })).evidence, []);
      const executed = yield* service.verify({ ...request, recheckOnly: false });
      const changed = yield* service.replace({
        projectId,
        expectedRevision: executed.revision,
        actor: user,
        definition: { ...definition(), tasks: [{ ...definition().tasks[0]!, verification: null }] },
      });
      const rechecked = yield* service.verify({ ...request, expectedRevision: changed.revision });
      assert.equal(rechecked.revision, changed.revision);
      assert.equal(firstTask(rechecked).evidence.length, 1);
      assert.equal(firstTask(rechecked).evidence[0]!.commandId, request.commandId);
    }),
  );
  it.effect(
    "records actual process output and never runs a confirmed retry twice, even after restart",
    () =>
      Effect.gen(function* () {
        const { service, projectId, root, fs } = yield* fixture("verify");
        yield* init(
          service,
          projectId,
          definition(
            'require("node:fs").appendFileSync("count", "1");console.log("real test passed")',
          ),
        );
        yield* service.read({ projectId });
        assert.isFalse(yield* fs.exists(`${root}/count`));
        const request = {
          projectId,
          expectedRevision: 1,
          taskId: "T-1",
          actor: user,
          commandId: CommandId.make("verify-once"),
        };
        const verified = yield* service.verify(request);
        assert.equal(firstTask(verified).status, "verified");
        const receipt = firstTask(verified).evidence[0]!;
        assert.equal(receipt.exitCode, 0);
        assert.equal(receipt.outcome, "passed");
        assert.include(receipt.stdout, "real test passed");
        assert.match(receipt.outputSha256, /^[a-f0-9]{64}$/);
        assert.equal(receipt.contentRevision, 1);
        const markdown = renderPlanMarkdown(verified.native!);
        assert.include(markdown, "Status: verified");
        assert.include(markdown, "real test passed");
        assert.include(markdown, receipt.outputSha256);
        assert.deepEqual(yield* service.verify(request), verified);
        yield* Effect.gen(function* () {
          const next = yield* Plans.ProjectPlanService;
          yield* next.verify(request);
        }).pipe(Effect.provide(Layer.fresh(Plans.layer)));
        assert.equal(yield* fs.readFileString(`${root}/count`), "1");
        const changed = yield* service.replace({
          projectId,
          expectedRevision: verified.revision,
          actor: user,
          definition: { ...definition(), spec: "new acceptance" },
        });
        assert.equal(firstTask(changed).status, "reported_done");
        assert.equal(changed.native!.contentRevision, 2);
        assert.equal(firstTask(changed).evidence[0]!.contentRevision, 1);
      }),
  );
  it.effect(
    "retains verification evidence after release and refuses removing the unowned task",
    () =>
      Effect.gen(function* () {
        const { service, projectId } = yield* fixture("released-evidence");
        const created = yield* init(service, projectId);
        const claimed = yield* service.claim({
          projectId,
          expectedRevision: created.revision,
          taskId: "T-1",
          actor: user,
        });
        const verified = yield* service.verify({
          projectId,
          expectedRevision: claimed.revision,
          taskId: "T-1",
          actor: user,
          commandId: CommandId.make("verify-before-release"),
        });
        assert.equal(firstTask(verified).evidence[0]?.outcome, "passed");
        const released = yield* service.release({
          projectId,
          expectedRevision: verified.revision,
          taskId: "T-1",
          actor: user,
          expectedOwner: user,
        });
        assert.isNull(firstTask(released).owner);
        assert.equal(firstTask(released).status, "verified");
        assert.deepEqual(firstTask(released).evidence, firstTask(verified).evidence);
        const failure = yield* service
          .replace({
            projectId,
            expectedRevision: released.revision,
            actor: user,
            definition: { ...definition(), tasks: [] },
          })
          .pipe(Effect.flip);
        assert.equal(failure.code, "claimed");
        assert.deepEqual(yield* service.read({ projectId }), released);
      }),
  );
  it.effect("failed process and missing executable produce evidence without verified status", () =>
    Effect.gen(function* () {
      for (const [name, value, expected] of [
        ["fail", definition('console.error("actual failure");process.exit(7)'), "failed"],
        [
          "spawn",
          {
            ...definition(),
            tasks: [
              {
                ...definition().tasks[0]!,
                verification: {
                  executable: "/definitely/missing/command",
                  args: [],
                  timeoutMs: 1_000,
                },
              },
            ],
          },
          "error",
        ],
      ] as const) {
        const { service, projectId } = yield* fixture(name);
        yield* init(service, projectId, value);
        const plan = yield* service.verify({
          projectId,
          expectedRevision: 1,
          taskId: "T-1",
          actor: user,
          commandId: CommandId.make(name),
        });
        assert.notEqual(firstTask(plan).status, "verified");
        assert.equal(firstTask(plan).evidence[0]!.outcome, expected);
        if (expected === "failed") assert.equal(firstTask(plan).evidence[0]!.exitCode, 7);
      }
    }),
  );
  it.effect("stores bounded output and discloses truncation", () =>
    Effect.gen(function* () {
      const { service, projectId } = yield* fixture("output");
      yield* init(service, projectId, definition('process.stdout.write("x".repeat(100000))'));
      const plan = yield* service.verify({
        projectId,
        expectedRevision: 1,
        taskId: "T-1",
        actor: user,
        commandId: CommandId.make("output"),
      });
      assert.isTrue(firstTask(plan).evidence[0]!.truncated);
      assert.isAtMost(firstTask(plan).evidence[0]!.stdout.length, 8_192);
    }),
  );
  it.effect("terminates its own timed-out command and records a non-success result", () =>
    Effect.gen(function* () {
      const { service, projectId } = yield* fixture("timeout");
      const value = definition('console.log("started");setInterval(() => {}, 1000)');
      yield* init(service, projectId, {
        ...value,
        tasks: [
          {
            ...value.tasks[0]!,
            verification: { ...value.tasks[0]!.verification!, timeoutMs: 250 },
          },
        ],
      });
      const plan = yield* service.verify({
        projectId,
        expectedRevision: 1,
        taskId: "T-1",
        actor: user,
        commandId: CommandId.make("timeout"),
      });
      assert.equal(firstTask(plan).evidence[0]!.outcome, "timed_out");
      assert.notEqual(firstTask(plan).status, "verified");
    }),
  );
  it.effect(
    "rejects verification admission on paused/archived/deleted projects and purges private plan evidence",
    () =>
      Effect.gen(function* () {
        const { service, projectId } = yield* fixture("lifecycle");
        yield* init(service, projectId);
        const sql = yield* SqlClient.SqlClient;
        const request = {
          projectId,
          expectedRevision: 1,
          taskId: "T-1",
          actor: user,
          commandId: CommandId.make("lifecycle"),
        };
        for (const mode of ["paused", "archived"] as const) {
          yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, [mode]: true })} WHERE project_id=${projectId}`;
          assert.equal((yield* service.verify(request).pipe(Effect.flip)).code, mode);
        }
        yield* sql`UPDATE projection_projects SET deleted_at='2026-10-09T01:00:00.000Z' WHERE project_id=${projectId}`;
        assert.deepEqual(yield* sql`SELECT * FROM project_plans WHERE project_id=${projectId}`, []);
        assert.equal((yield* service.read({ projectId }).pipe(Effect.flip)).code, "not_found");
        assert.equal((yield* service.verify(request).pipe(Effect.flip)).code, "not_found");
      }),
  );
  it.effect(
    "binds exactly one external authority, preserves claims and never writes an alternate ledger",
    () =>
      Effect.gen(function* () {
        const { service, projectId, root, fs } = yield* fixture("external");
        const dir = yield* externalFiles(root);
        const before = yield* fs.readFileString(`${dir}/ledger.jsonl`);
        const snapshot = yield* bind(service, projectId, root);
        assert.isNull(snapshot.native);
        assert.isTrue(snapshot.external!.readOnly);
        assert.equal(snapshot.external!.tasks[0]!.owner, "existing-owner");
        assert.equal(snapshot.external!.tasks[0]!.status, "stale");
        assert.equal(
          (yield* service
            .claim({ projectId, expectedRevision: 1, taskId: "T-01", actor: user })
            .pipe(Effect.flip)).code,
          "read_only",
        );
        assert.equal(
          (yield* service
            .replace({ projectId, expectedRevision: 1, actor: user, definition: definition() })
            .pipe(Effect.flip)).code,
          "read_only",
        );
        assert.equal(yield* fs.readFileString(`${dir}/ledger.jsonl`), before);
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          document_json: string;
        }>`SELECT document_json FROM project_plans WHERE project_id=${projectId}`;
        assert.notInclude(rows[0]!.document_json, "existing-owner");
        assert.notInclude(rows[0]!.document_json, "Implement");
        yield* fs.writeFileString(`${dir}/ledger.jsonl`, before + ledgerLine("done"));
        const updated = yield* service.read({ projectId });
        assert.notEqual(updated.external!.sourceRevision, snapshot.external!.sourceRevision);
        assert.equal(updated.external!.tasks[0]!.status, "done");
        assert.equal(updated.external!.tasks[0]!.verification, "external_unverified");
      }),
  );
  it.effect(
    "does not fall back to a native plan when configured files disappear or become malformed",
    () =>
      Effect.gen(function* () {
        const { service, projectId, root, fs } = yield* fixture("source-change");
        const dir = yield* externalFiles(root);
        yield* bind(service, projectId, root);
        yield* fs.writeFileString(`${dir}/ledger.jsonl`, "{ broken }");
        assert.equal((yield* service.read({ projectId }).pipe(Effect.flip)).code, "source_invalid");
        yield* fs.remove(`${dir}/ledger.jsonl`);
        assert.equal(
          (yield* service.read({ projectId }).pipe(Effect.flip)).code,
          "source_unavailable",
        );
        const metadata = yield* service.readAuthority({ projectId });
        assert.deepEqual(metadata, {
          projectId,
          revision: 1,
          authority: {
            kind: "specweave",
            root: yield* fs.realPath(root),
            incrementId: "0888-example",
          },
        });
        assert.equal(
          (yield* service
            .configure({
              projectId,
              expectedRevision: 0,
              actor: user,
              authority: { kind: "native" },
              discardNative: false,
            })
            .pipe(Effect.flip)).code,
          "conflict",
        );
        assert.equal(
          (yield* service
            .configure({
              projectId,
              expectedRevision: metadata.revision,
              actor: worker("source-change:worker"),
              authority: { kind: "native" },
              discardNative: false,
            })
            .pipe(Effect.flip)).code,
          "forbidden",
        );
        const restored = yield* service.configure({
          projectId,
          expectedRevision: metadata.revision,
          actor: user,
          authority: { kind: "native" },
          discardNative: false,
        });
        assert.equal(restored.native!.tasks.length, 0);
        assert.isNull(restored.external);
      }),
  );
  it.effect("rejects missing, malformed, oversized and symlink-escaped external sources", () =>
    Effect.gen(function* () {
      const { service, projectId, root, fs } = yield* fixture("source-invalid");
      assert.equal(
        (yield* bind(service, projectId, root).pipe(Effect.flip)).code,
        "source_unavailable",
      );
      const dir = yield* externalFiles(root, externalSpec, "bad json");
      assert.equal(
        (yield* bind(service, projectId, root).pipe(Effect.flip)).code,
        "source_invalid",
      );
      yield* fs.writeFileString(`${dir}/ledger.jsonl`, ledgerLine());
      yield* fs.writeFileString(`${dir}/spec.md`, "x".repeat(262_145));
      assert.equal(
        (yield* bind(service, projectId, root).pipe(Effect.flip)).code,
        "source_invalid",
      );
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "studio-plan-outside-" });
      yield* externalFiles(outside);
      assert.equal(
        (yield* bind(service, projectId, outside).pipe(Effect.flip)).code,
        "source_invalid",
      );
      yield* fs.remove(`${dir}/spec.md`);
      yield* fs.symlink(`${outside}/.specweave/increments/0888-example/spec.md`, `${dir}/spec.md`);
      assert.equal(
        (yield* bind(service, projectId, root).pipe(Effect.flip)).code,
        "source_invalid",
      );
      yield* fs.symlink(outside, `${root}/escape`);
      assert.equal(
        (yield* bind(service, projectId, `${root}/escape`).pipe(Effect.flip)).code,
        "source_invalid",
      );
      assert.equal((yield* service.read({ projectId })).revision, 0);
    }),
  );
  it.effect(
    "binds a parent planning root only while its canonical folder grant remains active",
    () =>
      Effect.gen(function* () {
        const { service, projectId, root, fs } = yield* fixture("approved-parent");
        const canonical = yield* fs.realPath(root);
        const child = `${canonical}/child`;
        yield* fs.makeDirectory(child);
        yield* externalFiles(canonical);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE projection_projects SET workspace_root=${child} WHERE project_id=${projectId}`;
        assert.equal(
          (yield* bind(service, projectId, canonical).pipe(Effect.flip)).code,
          "source_invalid",
        );
        const settings = {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          revision: 1,
          environment: { additionalFolders: [canonical], repositories: [] },
        };
        yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify(settings)} WHERE project_id=${projectId}`;
        const connected = yield* bind(service, projectId, canonical);
        assert.equal(connected.external!.tasks[0]!.owner, "existing-owner");
        yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...settings, revision: 2, environment: { additionalFolders: [], repositories: [] } })} WHERE project_id=${projectId}`;
        assert.equal((yield* service.read({ projectId }).pipe(Effect.flip)).code, "source_invalid");
        assert.equal((yield* service.readAuthority({ projectId })).authority.kind, "specweave");
      }),
  );
  it.effect(
    "rejects a replaced primary planning folder even when the project root also moves",
    () =>
      Effect.gen(function* () {
        const { service, projectId, root, fs } = yield* fixture("primary-symlink");
        const canonical = yield* fs.realPath(root);
        yield* externalFiles(canonical);
        yield* bind(service, projectId, canonical);
        const replacement = `${canonical}-moved`;
        yield* fs.rename(canonical, replacement);
        yield* fs.symlink(replacement, canonical);
        assert.equal((yield* service.read({ projectId }).pipe(Effect.flip)).code, "source_invalid");
        yield* fs.remove(canonical);
        yield* fs.rename(replacement, canonical);
      }),
  );
  it.effect(
    "rejects a replaced external approval and keeps its binding for explicit recovery",
    () =>
      Effect.gen(function* () {
        const { service, projectId, fs } = yield* fixture("approved-symlink");
        const external = yield* fs
          .makeTempDirectoryScoped({ prefix: "studio-plan-external-" })
          .pipe(Effect.flatMap((p) => fs.realPath(p)));
        yield* externalFiles(external);
        const sql = yield* SqlClient.SqlClient;
        const settings = {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          environment: { additionalFolders: [external], repositories: [] },
        };
        yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify(settings)} WHERE project_id=${projectId}`;
        yield* bind(service, projectId, external);
        const replacement = `${external}-moved`;
        yield* fs.rename(external, replacement);
        yield* fs.symlink(replacement, external);
        assert.equal((yield* service.read({ projectId }).pipe(Effect.flip)).code, "source_invalid");
        assert.deepEqual((yield* service.readAuthority({ projectId })).authority, {
          kind: "specweave",
          root: external,
          incrementId: "0888-example",
        });
        yield* fs.remove(external);
        yield* fs.rename(replacement, external);
        assert.isNotNull((yield* service.read({ projectId })).external);
      }),
  );
  it.effect(
    "requires explicit native discard and never drops a live claim on authority change",
    () =>
      Effect.gen(function* () {
        const { service, projectId, root } = yield* fixture("authority");
        yield* externalFiles(root);
        yield* init(service, projectId);
        assert.equal((yield* bind(service, projectId, root, 1).pipe(Effect.flip)).code, "conflict");
        yield* service.claim({ projectId, expectedRevision: 1, taskId: "T-1", actor: user });
        const request = {
          projectId,
          expectedRevision: 2,
          actor: user,
          authority: { kind: "specweave" as const, root, incrementId: "0888-example" },
          discardNative: true,
        };
        assert.equal((yield* service.configure(request).pipe(Effect.flip)).code, "claimed");
        yield* service.release({
          projectId,
          expectedRevision: 2,
          taskId: "T-1",
          actor: user,
          expectedOwner: user,
        });
        assert.isNull((yield* service.configure({ ...request, expectedRevision: 3 })).native);
      }),
  );
  it.effect(
    "durable uncertain verification retries do not run again and stale results cannot verify changed acceptance",
    () =>
      Effect.gen(function* () {
        const { projectId, service } = yield* fixture("inflight");
        yield* init(service, projectId);
        const started = yield* Deferred.make<void>();
        const finish = yield* Deferred.make<void>();
        let calls = 0;
        const delayed = Layer.fresh(Plans.layer).pipe(
          Layer.provide(
            Layer.succeed(ProcessRunner.ProcessRunner, {
              run: () =>
                Effect.gen(function* () {
                  calls++;
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(finish);
                  return {
                    stdout: "passed",
                    stderr: "",
                    code: ChildProcessSpawner.ExitCode(0),
                    timedOut: false,
                    stdoutTruncated: false,
                    stderrTruncated: false,
                    stdoutInvalidUtf8: false,
                    stderrInvalidUtf8: false,
                  };
                }),
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const check = yield* Plans.ProjectPlanService;
          const request = {
            projectId,
            expectedRevision: 1,
            actor: user,
            taskId: "T-1",
            commandId: CommandId.make("inflight"),
          };
          const run = yield* check.verify(request).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const retry = yield* service.verify(request); // A different service instance sees the persisted receipt.
          assert.equal(firstTask(retry).evidence[0]!.outcome, "unknown");
          assert.equal(calls, 1);
          const changed = yield* service.replace({
            projectId,
            actor: user,
            expectedRevision: retry.revision,
            definition: { ...definition(), spec: "Changed while the command was running" },
          });
          assert.equal(changed.native!.contentRevision, 2);
          yield* Deferred.succeed(finish, undefined);
          const completed = yield* Fiber.join(run);
          assert.equal(firstTask(completed).evidence[0]!.outcome, "stale");
          assert.notEqual(firstTask(completed).status, "verified");
        }).pipe(Effect.provide(delayed));
      }),
  );
  it.effect(
    "retains an unknown receipt after interruption and rejects late completion after project deletion",
    () =>
      Effect.gen(function* () {
        for (const mode of ["interrupt", "delete"] as const) {
          const { projectId, service } = yield* fixture(`pending-${mode}`);
          yield* init(service, projectId);
          const started = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          let calls = 0;
          const controlled = Layer.fresh(Plans.layer).pipe(
            Layer.provide(
              Layer.succeed(ProcessRunner.ProcessRunner, {
                run: () =>
                  Effect.gen(function* () {
                    calls++;
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(finish);
                    return {
                      stdout: "passed",
                      stderr: "",
                      code: ChildProcessSpawner.ExitCode(0),
                      timedOut: false,
                      stdoutTruncated: false,
                      stderrTruncated: false,
                      stdoutInvalidUtf8: false,
                      stderrInvalidUtf8: false,
                    };
                  }),
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const check = yield* Plans.ProjectPlanService;
            const request = {
              projectId,
              expectedRevision: 1,
              actor: user,
              taskId: "T-1",
              commandId: CommandId.make(mode),
            };
            const run = yield* check.verify(request).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            if (mode === "interrupt") {
              yield* Fiber.interrupt(run);
              const retried = yield* service.verify(request);
              assert.equal(firstTask(retried).evidence[0]!.outcome, "unknown");
              assert.equal(calls, 1);
            } else {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`UPDATE projection_projects SET deleted_at='2026-10-09T01:00:00.000Z' WHERE project_id=${projectId}`;
              yield* Deferred.succeed(finish, undefined);
              assert.equal((yield* Fiber.join(run).pipe(Effect.flip)).code, "not_found");
              assert.deepEqual(
                yield* sql`SELECT * FROM project_plans WHERE project_id=${projectId}`,
                [],
              );
            }
          }).pipe(Effect.provide(controlled));
        }
      }),
  );
  it.effect("a later failed check removes verified status and evidence remains bounded", () =>
    Effect.gen(function* () {
      const { service, projectId, root, fs } = yield* fixture("recheck");
      yield* init(
        service,
        projectId,
        definition('process.exit(require("node:fs").existsSync("fail") ? 1 : 0)'),
      );
      let plan = yield* service.verify({
        projectId,
        expectedRevision: 1,
        taskId: "T-1",
        actor: user,
        commandId: CommandId.make("recheck-first"),
      });
      assert.equal(firstTask(plan).status, "verified");
      yield* fs.writeFileString(`${root}/fail`, "");
      plan = yield* service.verify({
        projectId,
        expectedRevision: plan.revision,
        taskId: "T-1",
        actor: user,
        commandId: CommandId.make("recheck-failed"),
      });
      assert.equal(firstTask(plan).status, "reported_done");
      assert.equal(firstTask(plan).evidence[1]!.outcome, "failed");
      // The bound also applies to failed attempts; no unbounded output/history growth.
      for (let index = 2; index < 20; index++)
        plan = yield* service.verify({
          projectId,
          expectedRevision: plan.revision,
          taskId: "T-1",
          actor: user,
          commandId: CommandId.make(`recheck-${index}`),
        });
      assert.equal(
        (yield* service
          .verify({
            projectId,
            expectedRevision: plan.revision,
            taskId: "T-1",
            actor: user,
            commandId: CommandId.make("over-limit"),
          })
          .pipe(Effect.flip)).code,
        "evidence_limit",
      );
      assert.equal(firstTask(yield* service.read({ projectId })).evidence.length, 20);
    }),
  );
});

it("folds external event order deterministically and keeps a foreign active owner", () => {
  const first = ledgerLine("claim", "owner", "2026-10-09T00:00:00Z");
  const second = ledgerLine("claim", "intruder", "2026-10-09T00:01:00Z");
  assert.equal(parseSpecWeavePlan(externalSpec, second + first)[0]!.owner, "owner");
  assert.throws(() => parseSpecWeavePlan(externalSpec + "### T-01 Duplicate\n", first));
  assert.throws(() =>
    parseSpecWeavePlan(
      externalSpec,
      JSON.stringify({ t: "T-01", e: "done", by: "owner", at: "2026-10-09T00:00:00Z" }),
    ),
  );
  assert.throws(() => parseSpecWeavePlan(externalSpec, first.replace("T-01", "T-missing")));
});
