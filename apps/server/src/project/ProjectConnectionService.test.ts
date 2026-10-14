import * as NativeDiscovery from "./connections/NativeConnectionDiscovery.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  type ProjectConnection,
  type ProjectConnectionConfig,
  type ProjectConnectionTool,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Connections from "./ProjectConnectionService.ts";
import * as Transport from "./connections/ProjectConnectionTransport.ts";

const config: ProjectConnectionConfig = {
  name: "Synthetic",
  command: "synthetic-mcp",
  args: [],
  envKeys: [],
};
const tool: ProjectConnectionTool = {
  name: "echo",
  description: "Synthetic echo",
  inputSchema: { type: "object", properties: { value: { type: "string" } } },
};
const id = ProjectId.make("connection-project"),
  other = ProjectId.make("other-project");
const storage = Projects.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const harness = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* Projects.ProjectStoreV2;
  const event = (projectId: ProjectId) => ({
    sequence: 1,
    eventId: EventId.make(`event:${projectId}`),
    aggregateKind: "project" as const,
    aggregateId: projectId,
    occurredAt: "2026-10-09T00:00:00Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  });
  for (const projectId of [id, other])
    yield* projects.apply({
      ...event(projectId),
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-09T00:00:00Z",
        updatedAt: "2026-10-09T00:00:00Z",
      },
    });
  const state = {
    tools: [tool] as readonly ProjectConnectionTool[],
    calls: [] as Parameters<Transport.ProjectConnectionTransport["Service"]["call"]>[0][],
    unavailable: false,
    callGate: Effect.void,
    discoverGate: Effect.void,
  };
  const transport = Layer.mock(Transport.ProjectConnectionTransport)({
    discover: () =>
      Effect.suspend(() => state.discoverGate).pipe(Effect.andThen(Effect.sync(() => state.tools))),
    call: (input) =>
      Effect.gen(function* () {
        state.calls.push(input);
        yield* state.callGate;
        if (state.unavailable)
          return yield* new Transport.ConnectionTransportError({ reason: "unavailable" });
        return { isError: false, content: "Synthetic accepted result" };
      }),
  });
  const run = <A, E, R>(
    body: (service: Connections.ProjectConnectionService["Service"]) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      return yield* body(yield* Connections.ProjectConnectionService);
    }).pipe(Effect.provide(Layer.fresh(Connections.layer).pipe(Layer.provide(transport))));
  const grant = (service: Connections.ProjectConnectionService["Service"], projectId = id) =>
    Effect.gen(function* () {
      const saved = yield* service.save({
        projectId,
        id: "synthetic",
        expectedRevision: null,
        config,
        allowedTools: [],
      });
      const checked = yield* service.check({
        projectId,
        id: saved.id,
        expectedRevision: saved.revision,
      });
      return yield* service.save({
        projectId,
        id: saved.id,
        expectedRevision: checked.revision,
        config,
        allowedTools: ["echo"],
      });
    });
  const request = (connection: ProjectConnection, projectId = id, command = "call-one") => ({
    projectId,
    id: connection.id,
    expectedRevision: connection.revision,
    tool: "echo",
    arguments: { value: "Synthetic" },
    commandId: CommandId.make(command),
    actor: "thread:owned",
  });
  const remove = (projectId: ProjectId) =>
    projects.apply({
      ...event(projectId),
      sequence: 2,
      eventId: EventId.make(`delete:${projectId}`),
      type: "project.deleted",
      payload: { projectId, deletedAt: "2026-10-09T00:01:00Z" },
    });
  return { sql, state, run, grant, request, remove };
});

it.effect(
  "requires an explicit discovered-tool grant, isolates projects and enforces revision CAS",
  () =>
    Effect.gen(function* () {
      const f = yield* harness;
      yield* f.run((service) =>
        Effect.gen(function* () {
          assert.equal(
            (yield* service
              .save({
                projectId: id,
                id: "synthetic",
                expectedRevision: null,
                config,
                allowedTools: ["echo"],
              })
              .pipe(Effect.flip)).code,
            "denied",
          );
          const saved = yield* service.save({
            projectId: id,
            id: "synthetic",
            expectedRevision: null,
            config,
            allowedTools: [],
          });
          assert.equal((yield* service.call(f.request(saved)).pipe(Effect.flip)).code, "denied");
          const checked = yield* service.check({
            projectId: id,
            id: saved.id,
            expectedRevision: saved.revision,
          });
          assert.equal(checked.status, "ready");
          assert.deepEqual(checked.allowedTools, []);
          assert.equal((yield* service.call(f.request(checked)).pipe(Effect.flip)).code, "denied");
          assert.equal(
            (yield* service
              .save({
                projectId: id,
                id: saved.id,
                expectedRevision: saved.revision,
                config,
                allowedTools: ["echo"],
              })
              .pipe(Effect.flip)).code,
            "conflict",
          );
          const granted = yield* service.save({
            projectId: id,
            id: saved.id,
            expectedRevision: checked.revision,
            config,
            allowedTools: ["echo"],
          });
          assert.equal(
            (yield* service.call(f.request(granted, other)).pipe(Effect.flip)).code,
            "not_found",
          );
          assert.deepEqual((yield* service.read({ projectId: other })).connections, []);
          assert.equal(
            (yield* service.call(f.request(granted))).content,
            "Synthetic accepted result",
          );
          assert.equal(f.state.calls.length, 1);
          assert.equal(f.state.calls[0]?.cwd, `/tmp/${id}`);
        }),
      );
    }).pipe(Effect.provide(storage)),
);

it.effect(
  "replays an accepted call across service restart without dispatching again and binds the full request",
  () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const granted = yield* f.run((service) => f.grant(service));
      const request = f.request(granted);
      const accepted = yield* f.run((service) => service.call(request));
      yield* f.run((service) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* service.call(request), accepted);
          for (const change of [{ arguments: { value: "Changed" } }, { actor: "thread:another" }])
            assert.equal(
              (yield* service.call({ ...request, ...change }).pipe(Effect.flip)).code,
              "conflict",
            );
        }),
      );
      assert.equal(f.state.calls.length, 1);
    }).pipe(Effect.provide(storage)),
);

it.effect(
  "keeps an unknown call pending across restart and never automatically dispatches it again",
  () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const granted = yield* f.run((service) => f.grant(service));
      const request = f.request(granted);
      f.state.unavailable = true;
      assert.equal(
        (yield* f.run((service) => service.call(request).pipe(Effect.flip))).code,
        "outcome_unknown",
      );
      f.state.unavailable = false;
      assert.equal(
        (yield* f.run((service) => service.call(request).pipe(Effect.flip))).code,
        "outcome_unknown",
      );
      assert.equal(f.state.calls.length, 1);
      assert.isNull(
        (yield* f.sql`SELECT result_json FROM project_connection_calls WHERE project_id=${id}`)[0]!
          .result_json,
      );
    }).pipe(Effect.provide(storage)),
);

it.effect(
  "reports unknown outcome when only final receipt persistence fails after successful dispatch",
  () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const granted = yield* f.run((service) => f.grant(service));
      const request = f.request(granted);
      yield* f.sql`CREATE TEMP TRIGGER reject_connection_result BEFORE UPDATE OF result_json ON project_connection_calls WHEN NEW.result_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic receipt write failure'); END`;
      assert.equal(
        (yield* f.run((service) => service.call(request).pipe(Effect.flip))).code,
        "outcome_unknown",
      );
      assert.equal(f.state.calls.length, 1);
      const pending = yield* f.sql`SELECT * FROM project_connection_calls WHERE project_id=${id}`;
      assert.equal(pending.length, 1);
      assert.isNull(pending[0]!.result_json);
      yield* f.sql`DROP TRIGGER reject_connection_result`;
      assert.equal(
        (yield* f.run((service) => service.call(request).pipe(Effect.flip))).code,
        "outcome_unknown",
      );
      assert.deepEqual(
        yield* f.sql`SELECT * FROM project_connection_calls WHERE project_id=${id}`,
        pending,
      );
      assert.equal(f.state.calls.length, 1);
    }).pipe(Effect.provide(storage)),
);

it.effect("clears grants after tool definition changes and requires fresh review", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    yield* f.run((service) =>
      Effect.gen(function* () {
        const granted = yield* f.grant(service);
        f.state.tools = [{ ...tool, description: "Changed behavior" }];
        const checked = yield* service.check({
          projectId: id,
          id: granted.id,
          expectedRevision: granted.revision,
        });
        assert.deepEqual(checked.allowedTools, []);
        assert.equal(checked.status, "ready");
        assert.equal((yield* service.call(f.request(checked)).pipe(Effect.flip)).code, "denied");
        assert.equal(f.state.calls.length, 0);
      }),
    );
  }).pipe(Effect.provide(storage)),
);

it.effect("does not restore grants when revocation races an in-flight discovery", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>();
    yield* f.run((service) =>
      Effect.gen(function* () {
        const granted = yield* f.grant(service);
        f.state.discoverGate = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const checking = yield* service
          .check({ projectId: id, id: granted.id, expectedRevision: granted.revision })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Deferred.await(entered);
        const revoked = yield* service.revoke({
          projectId: id,
          id: granted.id,
          expectedRevision: granted.revision,
        });
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.join(checking)).code, "conflict");
        assert.deepEqual((yield* service.read({ projectId: id })).connections, [revoked]);
        assert.deepEqual(revoked.allowedTools, []);
        assert.equal(revoked.status, "revoked");
        assert.equal((yield* service.call(f.request(revoked)).pipe(Effect.flip)).code, "denied");
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(storage)),
);

it.effect("serializes revocation after an already admitted call and denies subsequent calls", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    const entered = yield* Deferred.make<void>(),
      release = yield* Deferred.make<void>(),
      revoking = yield* Deferred.make<void>();
    yield* f.run((service) =>
      Effect.gen(function* () {
        const granted = yield* f.grant(service);
        let revoked = false;
        f.state.callGate = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const calling = yield* service.call(f.request(granted)).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const revocation = yield* Deferred.succeed(revoking, undefined).pipe(
          Effect.andThen(
            service.revoke({ projectId: id, id: granted.id, expectedRevision: granted.revision }),
          ),
          Effect.tap(() =>
            Effect.sync(() => {
              revoked = true;
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(revoking);
        assert.isFalse(revoked);
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.join(calling)).content, "Synthetic accepted result");
        const next = yield* Fiber.join(revocation);
        assert.isTrue(revoked);
        assert.equal(
          (yield* service.call(f.request(next, id, "after-revoke")).pipe(Effect.flip)).code,
          "denied",
        );
        assert.equal(f.state.calls.length, 1);
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(storage)),
);

it.effect.each(["paused", "archived"] as const)(
  "denies connection actions for a %s project",
  (policy) =>
    Effect.gen(function* () {
      const f = yield* harness;
      yield* f.run((service) =>
        Effect.gen(function* () {
          const granted = yield* f.grant(service);
          yield* f.sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, [policy]: true })} WHERE project_id=${id}`;
          assert.equal((yield* service.call(f.request(granted)).pipe(Effect.flip)).code, "denied");
          assert.equal(
            (yield* service
              .check({ projectId: id, id: granted.id, expectedRevision: granted.revision })
              .pipe(Effect.flip)).code,
            "denied",
          );
          assert.equal(f.state.calls.length, 0);
        }),
      );
    }).pipe(Effect.provide(storage)),
);

it.effect("deletion purges only that project's connection configuration and call receipts", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    yield* f.run((service) =>
      Effect.gen(function* () {
        const granted = yield* f.grant(service);
        const otherGranted = yield* f.grant(service, other);
        yield* service.call(f.request(granted));
        yield* service.call(f.request(otherGranted, other));
        const otherRows =
          yield* f.sql`SELECT * FROM project_connection_calls WHERE project_id=${other}`;
        yield* f.remove(id);
        assert.deepEqual(
          yield* f.sql`SELECT * FROM project_connections WHERE project_id=${id}`,
          [],
        );
        assert.deepEqual(
          yield* f.sql`SELECT * FROM project_connection_calls WHERE project_id=${id}`,
          [],
        );
        assert.deepEqual(
          yield* f.sql`SELECT * FROM project_connection_calls WHERE project_id=${other}`,
          otherRows,
        );
        assert.deepEqual((yield* service.read({ projectId: other })).connections, [otherGranted]);
        assert.equal((yield* service.call(f.request(granted)).pipe(Effect.flip)).code, "not_found");
        assert.equal((yield* service.read({ projectId: id }).pipe(Effect.flip)).code, "not_found");
        assert.equal(f.state.calls.length, 2);
      }),
    );
  }).pipe(Effect.provide(storage)),
);

it.effect("discovers only the registered project root and rejects a missing project", () =>
  Effect.gen(function* () {
    yield* harness;
    const roots: Array<string | undefined> = [];
    const program = Effect.gen(function* () {
      const service = yield* Connections.ProjectConnectionService;
      yield* service.discoverNative({ projectId: id });
      yield* service.discoverNative({});
      const failed = yield* service
        .discoverNative({ projectId: ProjectId.make("missing") })
        .pipe(Effect.flip);
      assert.equal(failed.code, "project_not_found");
      assert.deepEqual(roots, [`/tmp/${id}`, undefined]);
    });
    yield* program.pipe(
      Effect.provide(
        Connections.layerWithDiscovery.pipe(
          Layer.provide(
            Layer.mock(NativeDiscovery.NativeConnectionDiscovery)({
              read: (root) =>
                Effect.sync(() => {
                  roots.push(root);
                  return {
                    observedAt: "2026-10-14T00:00:00Z",
                    connections: [],
                    sources: [],
                    truncated: false,
                    runtime: "unverified" as const,
                  };
                }),
            }),
          ),
          Layer.provide(Layer.mock(Transport.ProjectConnectionTransport)({})),
        ),
      ),
    );
  }).pipe(Effect.provide(storage)),
);
