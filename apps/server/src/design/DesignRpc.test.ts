import { expect, it } from "@effect/vitest";
import {
  AuthAdministrativeScopes,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthStandardClientScopes,
  DESIGN_SYSTEM_SCHEMA,
  ThreadId,
  WS_METHODS,
  WsDesignRpcGroup,
  type AuthEnvironmentScope,
  type DesignSystemProposal,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Authorization from "../auth/RpcAuthorization.ts";
import { rpcInstrumentationLayer } from "../observability/RpcInstrumentation.ts";
import * as DesignRpc from "./DesignRpc.ts";
import { DesignService } from "./DesignService.ts";
import {
  layerDesignService,
  makeDesignFixture,
  HERE,
  owner,
  PROJECT_A,
  PROJECT_B,
} from "./DesignService.testkit.ts";
import * as Store from "./DesignStore.ts";
import { DesignSystemProposals } from "./systems/DesignSystemService.ts";

const projectA = { kind: "project", projectId: PROJECT_A } as const;

/** A client of the real `design.*` group for a session with `subject` and `scopes`. */
const clientFor = (
  subject: string,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  proposals = new Map<string, DesignSystemProposal>(),
) =>
  RpcTest.makeClient(WsDesignRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        DesignRpc.layerRpcHandlers({ subject, scopes }),
        Authorization.layer(scopes),
      ).pipe(
        Layer.provide(rpcInstrumentationLayer),
        Layer.provide(Layer.succeed(DesignSystemProposals, proposals)),
      ),
    ),
  );

const withFixture = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(makeDesignFixture),
    (fixture) => run.pipe(Effect.provide(layerDesignService(fixture))),
    (fixture) => Effect.sync(fixture.cleanup),
  );

it("treats the desktop app, startup link and CLI as the owner and every paired session as a member", () => {
  const scopes = AuthStandardClientScopes;
  for (const subject of ["desktop-bootstrap", "administrative-bootstrap", "cli-issued-session"]) {
    expect(DesignRpc.designCallerForSession({ subject, scopes }).audience).toBe("owner");
  }
  for (const subject of ["one-time-token", "device-approval", "mcp-client", "cloud-connect", "x"]) {
    expect(DesignRpc.designCallerForSession({ subject, scopes }).audience).toBe("members");
  }
});

it("treats a session that manages access as the owner, as the app paired with a running service", () => {
  // The desktop app signs in to a service it did not start through the
  // service's CLI: subject `one-time-token`, administrative scopes.
  expect(
    DesignRpc.designCallerForSession({
      subject: "one-time-token",
      scopes: AuthAdministrativeScopes,
    }).audience,
  ).toBe("owner");
});

it.effect("lets the app paired with a running service bind a design to its new thread", () =>
  withFixture(
    Effect.gen(function* () {
      const app = yield* clientFor("one-time-token", AuthAdministrativeScopes);
      const phone = yield* clientFor("one-time-token", AuthStandardClientScopes);
      const created = yield* app[WS_METHODS.designCreate]({
        owner: projectA,
        kind: "design",
        title: "EasyChamp_SWC_Design",
      });
      const address = { owner: projectA, designId: created.document.id };
      const thread = { environmentId: HERE, threadId: ThreadId.make("design-thread") };
      expect(
        yield* phone[WS_METHODS.designApply]({
          ...address,
          expectedRevision: 0,
          operations: [{ op: "set_thread", thread }],
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "DesignError", code: "forbidden" });
      const bound = yield* app[WS_METHODS.designApply]({
        ...address,
        expectedRevision: 0,
        operations: [{ op: "set_thread", thread }],
      });
      expect(bound.document.thread).toMatchObject(thread);
    }),
  ),
);

it.effect("enforces design access for a paired device over RPC (AC-14)", () =>
  withFixture(
    Effect.gen(function* () {
      const scopes = [AuthFilesystemReadScope, AuthFilesystemWriteScope];
      const ownerClient = yield* clientFor("desktop-bootstrap", scopes);
      const phone = yield* clientFor("one-time-token", scopes);
      const created = yield* ownerClient[WS_METHODS.designCreate]({
        owner: projectA,
        kind: "design",
        title: "Shared",
      });
      const address = { owner: projectA, designId: created.document.id };
      // The phone edits by default, but cannot change access.
      yield* phone[WS_METHODS.designApply]({
        ...address,
        expectedRevision: 0,
        operations: [{ op: "set_title", title: "From the phone" }],
      });
      expect(
        yield* phone[WS_METHODS.designApply]({
          ...address,
          expectedRevision: 1,
          operations: [{ op: "set_access", members: "edit", agents: "edit" }],
        }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "DesignError", code: "forbidden" });
      yield* ownerClient[WS_METHODS.designApply]({
        ...address,
        expectedRevision: 1,
        operations: [{ op: "set_access", members: "view" }],
      });
      for (const attempt of [
        phone[WS_METHODS.designApply]({
          ...address,
          expectedRevision: 2,
          operations: [{ op: "set_title", title: "Blocked" }],
        }),
        phone[WS_METHODS.designRestore]({ ...address, revision: 0, expectedRevision: 2 }),
        phone[WS_METHODS.designDelete](address),
        phone[WS_METHODS.designCopy]({ ...address, to: { kind: "playground" } }),
      ] as ReadonlyArray<Effect.Effect<object, { readonly _tag: string }>>) {
        expect(yield* Effect.flip(attempt)).toMatchObject({
          _tag: "DesignError",
          code: "forbidden",
        });
      }
      // Viewing still works, and the owner still edits.
      expect((yield* phone[WS_METHODS.designGet](address)).document.title).toBe("From the phone");
      expect(
        (yield* ownerClient[WS_METHODS.designRestore]({
          ...address,
          revision: 0,
          expectedRevision: 2,
        })).document.title,
      ).toBe("Shared");
    }).pipe(Effect.scoped),
  ),
);

it.effect("refuses writes without the filesystem write scope before the handler runs", () =>
  withFixture(
    Effect.gen(function* () {
      const reader = yield* clientFor("desktop-bootstrap", [AuthFilesystemReadScope]);
      expect(
        yield* reader[WS_METHODS.designCreate]({
          owner: projectA,
          kind: "design",
          title: "No",
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthFilesystemWriteScope });
      expect((yield* reader[WS_METHODS.designList]({ filter: { kind: "all" } })).designs).toEqual(
        [],
      );
      // A project that is not registered here is not found, whatever path a client might imagine.
      expect(
        yield* reader[WS_METHODS.designGet]({
          owner: { kind: "project", projectId: "../../etc" as never },
          designId: "d_x",
        }).pipe(Effect.flip),
      ).toMatchObject({ code: "not_found" });
    }).pipe(Effect.scoped),
  ),
);

/** Only `owner` and `target` matter to discarding. */
const openProposal = (id: string, systemId: string, projectId = PROJECT_A) =>
  ({
    id,
    owner: { kind: "project", projectId },
    target: { systemId, revision: 0 },
  }) as unknown as DesignSystemProposal;

it.effect("renames and deletes a system over RPC, discarding its open proposals", () =>
  withFixture(
    Effect.gen(function* () {
      const designs = yield* DesignService;
      const { root } = yield* designs.ownerRoot(owner, projectA);
      yield* Effect.promise(() =>
        Store.writeDesignSystem(
          root,
          {
            schema: DESIGN_SYSTEM_SCHEMA,
            id: "s_brand",
            name: "Brand",
            revision: 0,
            createdAt: "2026-10-20T10:00:00.000Z",
            updatedAt: "2026-10-20T10:00:00.000Z",
            modes: [{ id: "light", name: "Light" }],
            tokens: [],
            components: [],
            sources: [],
            copiedFrom: null,
          },
          { expectedRevision: null, actor: { kind: "user" } },
        ),
      );
      yield* designs.create(owner, {
        owner: projectA,
        kind: "design",
        title: "Branded",
        designSystem: "s_brand",
      });
      const proposals = new Map(
        [
          openProposal("p-brand", "s_brand"),
          openProposal("p-other", "s_other"),
          openProposal("p-elsewhere", "s_brand", PROJECT_B),
        ].map((proposal) => [proposal.id, proposal]),
      );
      const address = { owner: projectA, systemId: "s_brand" };
      const reader = yield* clientFor("desktop-bootstrap", [AuthFilesystemReadScope], proposals);
      expect(yield* reader[WS_METHODS.designSystemUsage](address)).toEqual({ designs: 1 });
      for (const attempt of [
        reader[WS_METHODS.designSystemRename]({ ...address, name: "No", expectedRevision: 0 }),
        reader[WS_METHODS.designSystemDelete]({ ...address, expectedRevision: 0 }),
      ] as ReadonlyArray<Effect.Effect<object, object>>) {
        expect(yield* Effect.flip(attempt)).toMatchObject({
          requiredPermission: AuthFilesystemWriteScope,
        });
      }
      // A paired device may rename and delete, like copying a system.
      const phone = yield* clientFor(
        "one-time-token",
        [AuthFilesystemReadScope, AuthFilesystemWriteScope],
        proposals,
      );
      const renamed = yield* phone[WS_METHODS.designSystemRename]({
        ...address,
        name: "Brand 2",
        expectedRevision: 0,
      });
      expect(renamed.system).toMatchObject({ id: "s_brand", name: "Brand 2", revision: 1 });
      expect(
        yield* phone[WS_METHODS.designSystemDelete]({ ...address, expectedRevision: 0 }).pipe(
          Effect.flip,
        ),
      ).toMatchObject({ _tag: "DesignError", code: "conflict", currentRevision: 1 });
      expect([...proposals.keys()].sort()).toEqual(["p-brand", "p-elsewhere", "p-other"]);
      expect(
        yield* phone[WS_METHODS.designSystemDelete]({ ...address, expectedRevision: 1 }),
      ).toEqual({ deleted: true });
      expect([...proposals.keys()].sort()).toEqual(["p-elsewhere", "p-other"]);
      expect(yield* phone[WS_METHODS.designSystemGet](address).pipe(Effect.flip)).toMatchObject({
        code: "not_found",
      });
    }).pipe(Effect.scoped),
  ),
);
