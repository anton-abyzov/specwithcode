import { expect, it } from "@effect/vitest";
import {
  type DesignGetResult,
  type DesignListResult,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { McpSchema, McpServer } from "effect/ai";

import * as DesignService from "../../../design/DesignService.ts";
import {
  layerDesignDependencies,
  LINKED,
  makeDesignFixture,
  PROJECT_A,
  REMOTE,
  REMOTE_PROJECT,
} from "../../../design/DesignService.testkit.ts";
import { DesignSystemProposals } from "../../../design/systems/DesignSystemService.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { workerClientName } from "../../../fleet/workerGrantMint.ts";
import type { EffectiveWorkGrant } from "../../../fleet/workGrantPolicy.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/**
 * 1050 M-05 through the production design tools and the real design
 * service: the remote machine's worker client reaches only designs in the
 * projects its grant covers (here: those linked to it), never another
 * project's or the Playground's.
 */
const linkedOnly = (revoked = false): EffectiveWorkGrant => ({
  coordinatorEnvironmentId: REMOTE,
  projects: { kind: "linked" },
  accounts: { kind: "all" },
  owner: "self",
  hopLimit: 2,
  revoked,
});

const grantStore = (revoked: boolean): WorkGrants.WorkGrantsShape => ({
  ...(WorkGrants.WorkGrants.defaultValue() as WorkGrants.WorkGrantsShape),
  enabled: true,
  forClient: (client) =>
    Effect.succeed(client?.principal?.kind === "coordinator" ? linkedOnly(revoked) : undefined),
  forCoordinator: () => Effect.succeed(linkedOnly(revoked)),
});

/** The projects as ProjectService describes them: LINKED is linked to the remote machine. */
const projectRow = (projectId: ProjectId) =>
  projectId === LINKED || projectId === PROJECT_A
    ? Option.some({
        id: projectId,
        title: projectId,
        workspaceSettings:
          projectId === LINKED
            ? {
                logicalProject: {
                  id: "logical-web",
                  title: "Web",
                  coordinatorId: "coordinator",
                  members: [{ environmentId: REMOTE, projectId: REMOTE_PROJECT }],
                },
              }
            : {},
      } as never)
    : Option.none();

const scope = (
  principal: { kind: "coordinator"; environmentId: EnvironmentId } | { kind: "device"; id: string },
): McpInvocationContext.McpInvocationScope => ({
  environmentId: "env-here" as EnvironmentId,
  requestNamespace: `design-client-${principal.kind}`,
  thread: undefined,
  client: {
    sessionId: "session",
    principal,
    label: principal.kind === "coordinator" ? workerClientName(REMOTE) : "Desktop",
    access: "full-access",
  },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});
const fromRemote = scope({ kind: "coordinator", environmentId: REMOTE });
const local = scope({ kind: "device", id: "desktop" });

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "design-grant-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "design-grant-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const call = (
  as: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, as),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};
const successOf = <A>(result: McpSchema.CallToolResult) => {
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return result.structuredContent as A;
};

const withServer = <A, E>(
  revoked: boolean,
  run: Effect.Effect<A, E, McpServer.McpServer | DesignService.DesignService>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(makeDesignFixture),
    (fixture) =>
      run.pipe(
        Effect.provide(
          Layer.mergeAll(McpHttpServer.layerDesignToolkit, DesignService.layerWithRender).pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(DesignSystemProposals.layer),
            Layer.provide(layerDesignDependencies(fixture)),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ThreadManagement.ThreadManagementService)({}),
                Layer.mock(Project.ProjectService)({
                  getById: (projectId) => Effect.succeed(projectRow(projectId)),
                }),
                Layer.succeed(WorkGrants.WorkGrants, grantStore(revoked)),
                Layer.succeed(RemoteWorkers.RemoteWorkers, {
                  ...(RemoteWorkers.RemoteWorkers.defaultValue() as RemoteWorkers.RemoteWorkersShape),
                  machineLabels: Effect.succeed(new Map([[REMOTE as string, "Remote"]])),
                }),
              ),
            ),
          ),
        ),
      ),
    (fixture) => Effect.sync(fixture.cleanup),
  );

const seed = Effect.gen(function* () {
  const designs = yield* DesignService.DesignService;
  const inA = yield* designs.create(DesignService.ownerCaller, {
    owner: { kind: "project", projectId: PROJECT_A },
    kind: "design",
    title: "Private pricing",
  });
  const inLinked = yield* designs.create(DesignService.ownerCaller, {
    owner: { kind: "project", projectId: LINKED },
    kind: "design",
    title: "Shared site",
  });
  const inPlayground = yield* designs.create(DesignService.ownerCaller, {
    owner: { kind: "playground" },
    kind: "design",
    title: "Sketch",
  });
  return { inA, inLinked, inPlayground };
});

const titles = (listed: DesignListResult) => listed.designs.map((design) => design.title).sort();

it.effect("keeps a grant's client to designs in the projects its grant covers", () =>
  withServer(
    false,
    Effect.gen(function* () {
      const { inA, inLinked, inPlayground } = yield* seed;
      const listed = successOf<DesignListResult>(yield* call(fromRemote, "design_list", {}));
      expect(titles(listed)).toEqual(["Shared site"]);
      // Its problems name no project outside the grant either.
      expect(JSON.stringify(listed.problems)).not.toContain(PROJECT_A);

      const projectA = { kind: "project", projectId: PROJECT_A };
      for (const [name, args] of [
        ["design_get", { designId: inA.document.id, owner: projectA }],
        ["design_history", { designId: inA.document.id, owner: projectA }],
        ["design_list", { owner: projectA }],
        ["design_system_list", { owner: projectA }],
        ["design_get", { designId: inPlayground.document.id, owner: { kind: "playground" } }],
      ] as const) {
        expect(failureOf(yield* call(fromRemote, name, args)), name).toMatchObject({
          code: "capability_denied",
        });
      }

      // A linked project's design opens by its own id here and by the remote member's.
      const here = successOf<DesignGetResult>(
        yield* call(fromRemote, "design_get", {
          designId: inLinked.document.id,
          owner: { kind: "project", projectId: LINKED },
        }),
      );
      expect(here.document.title).toBe("Shared site");
      const viaRemote = successOf<DesignGetResult>(
        yield* call(fromRemote, "design_get", {
          designId: inLinked.document.id,
          owner: { kind: "project", projectId: REMOTE_PROJECT },
          environmentId: REMOTE,
        }),
      );
      expect(viaRemote.document.title).toBe("Shared site");

      // A client on this machine without a grant still sees every owner.
      const all = successOf<DesignListResult>(yield* call(local, "design_list", {}));
      expect(titles(all)).toEqual(["Private pricing", "Shared site", "Sketch"]);
      successOf(yield* call(local, "design_get", { designId: inA.document.id, owner: projectA }));
    }),
  ),
);

it.effect("refuses every design read once the grant is revoked", () =>
  withServer(
    true,
    Effect.gen(function* () {
      const { inLinked } = yield* seed;
      expect(failureOf(yield* call(fromRemote, "design_list", {}))).toMatchObject({
        code: "machine_not_authorized",
      });
      expect(
        failureOf(
          yield* call(fromRemote, "design_get", {
            designId: inLinked.document.id,
            owner: { kind: "project", projectId: LINKED },
          }),
        ),
      ).toMatchObject({ code: "machine_not_authorized" });
    }),
  ),
);
