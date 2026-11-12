import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { unscopedGrant, type WorkOrigin } from "../../../fleet/workGrantPolicy.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import { projectFixture } from "../../../project/ProjectWorkspace.testkit.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

const callerId = ThreadId.make("coordinator");
const providerInstanceId = ProviderInstanceId.make("codex");
const M1 = { id: "m1", label: "M1", environmentId: EnvironmentId.make("env-m1") };
const remoteProjectId = ProjectId.make("remote-pinball");

interface RemoteCall {
  readonly tool: string;
  readonly arguments: Record<string, unknown>;
}

const setup = (
  options: {
    /** M1 runs a SpecWithCode without the projectCreateOptions feature. */
    readonly olderM1?: boolean;
    /** M1 refuses the create with this failure. */
    readonly createFails?: OrchestratorMcpFailure;
    /** Another machine's work started the calling thread here. */
    readonly origin?: WorkOrigin;
  } = {},
) => {
  const calls: RemoteCall[] = [];
  const localCreates: string[] = [];
  const caller = {
    id: callerId,
    projectId: ProjectId.make("project"),
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: "active-run",
    archivedAt: null,
    deletedAt: null,
  } as OrchestrationV2ThreadShell;
  const remote: RemoteWorkers.RemoteWorkersShape = {
    ...RemoteWorkers.RemoteWorkers.defaultValue(),
    enabled: true,
    resolveMachine: (target) =>
      target === undefined || target === "local"
        ? Effect.succeed({ kind: "local" })
        : target === "m1" || target === "M1"
          ? Effect.succeed({ kind: "remote", machine: M1 })
          : Effect.fail(
              new OrchestratorMcpFailure({
                code: "unknown_machine",
                message: `No machine "${target}". studio_machine_list lists them.`,
              }),
            ),
    proxy: (input) =>
      Effect.suspend((): Effect.Effect<Record<string, unknown>, OrchestratorMcpFailure> => {
        calls.push({ tool: input.tool, arguments: input.arguments });
        if (input.tool === "orchestrator_capabilities")
          return Effect.succeed({
            features: options.olderM1
              ? { scheduledTasks: true }
              : { scheduledTasks: true, projectCreateOptions: true },
          });
        if (input.tool === "studio_project_create") {
          if (options.createFails !== undefined) return Effect.fail(options.createFails);
          return Effect.succeed({
            ...projectFixture(remoteProjectId, {
              title: String(input.arguments.title),
              workspaceRoot: "/home/example/Projects/pinball-stats",
            }),
            published: "published",
            repository: "example/pinball-stats",
          });
        }
        return Effect.die(`unexpected tool ${input.tool}`);
      }),
  };
  const layerDependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(RemoteWorkers.RemoteWorkers, remote),
    Layer.succeed(WorkGrants.WorkGrants, {
      ...WorkGrants.WorkGrants.defaultValue(),
      enabled: true,
      originOf: () => Effect.succeed(options.origin),
      forCoordinator: (id) => Effect.succeed(unscopedGrant(id)),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("env-m4"),
      requestNamespace: "session",
      thread: { threadId: callerId, providerSessionId: "session", providerInstanceId },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(caller),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
    Layer.mock(Project.ProjectService)({
      getById: () => Effect.succeedNone,
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      createNamedProject: (input) =>
        Effect.sync(() => {
          localCreates.push(input.name);
          return { projectId: ProjectId.make("local"), workspaceRoot: "/projects/local" };
        }),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    NodeServices.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "studio-create-on-machine-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  );
  const create = (params: Record<string, unknown>) =>
    ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
      Effect.flatMap((toolkit) =>
        toolkit
          .handle("studio_project_create", params as never)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies)),
      ),
      Effect.map((results) => results.at(-1)?.result as unknown as Record<string, unknown>),
    );
  return { create, calls, localCreates };
};

describe("studio_project_create on another machine", () => {
  it.effect("creates it there with the folder and GitHub, and says how to launch there", () => {
    const { create, calls, localCreates } = setup();
    return Effect.gen(function* () {
      const result = yield* create({
        title: "Pinball Stats",
        machine: "M1",
        parentPath: "~/Projects",
        github: true,
      });
      expect(calls.map((call) => call.tool)).toEqual([
        "orchestrator_capabilities",
        "studio_project_create",
      ]);
      // Forwarded as asked, without the machine: that machine creates it on itself.
      expect(calls[1]!.arguments).toEqual({
        title: "Pinball Stats",
        parentPath: "~/Projects",
        github: true,
      });
      expect(result).toMatchObject({
        id: remoteProjectId,
        workspaceRoot: "/home/example/Projects/pinball-stats",
        published: "published",
        machine: M1,
      });
      // The launch call needs no add or link step.
      expect(result.next).toContain(
        `studio_thread_launch {machine:"M1", machineProjectId:"${remoteProjectId}"}`,
      );
      expect(localCreates).toEqual([]);
    });
  });

  it.effect("'local' creates it here", () => {
    const { create, calls, localCreates } = setup();
    return Effect.gen(function* () {
      const result = yield* create({ title: "Here", machine: "local" });
      expect(calls).toEqual([]);
      expect(localCreates).toEqual(["Here"]);
      expect(result.machine).toBeUndefined();
    });
  });

  it.effect("asks an older machine to update instead of losing the folder and GitHub", () => {
    const { create, calls } = setup({ olderM1: true });
    return Effect.gen(function* () {
      const result = yield* create({ title: "Pinball Stats", machine: "M1" });
      expect(result).toMatchObject({ code: "machine_unsupported" });
      expect(String(result.message)).toContain("Update SpecWithCode on M1");
      expect(calls.map((call) => call.tool)).toEqual(["orchestrator_capabilities"]);
    });
  });

  it.effect("names the fix for an unknown machine and for a refusal there", () => {
    return Effect.gen(function* () {
      const unknown = yield* setup().create({ title: "X", machine: "Mini" });
      expect(unknown).toMatchObject({ code: "unknown_machine" });
      expect(String(unknown.message)).toContain("studio_machine_list");

      const limited = new OrchestratorMcpFailure({
        code: "outside_grant_scope",
        message:
          "M1: This machine lets M4's work use only some of its projects, so it cannot add projects here. Ask the user here, or widen what M4 may use in Settings > Machines > Who can run work here.",
      });
      const refused = yield* setup({ createFails: limited }).create({ title: "X", machine: "M1" });
      expect(refused).toMatchObject({ code: "outside_grant_scope", message: limited.message });

      const missing = new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "M1: The folder '/nope' does not exist on this machine. Pass an existing folder.",
      });
      const gone = yield* setup({ createFails: missing }).create({
        title: "X",
        machine: "M1",
        parentPath: "/nope",
      });
      expect(gone).toMatchObject({ code: "invalid_request", message: missing.message });
    });
  });

  it.effect("refuses work another machine started here", () => {
    const { create, calls } = setup({
      origin: { coordinatorEnvironmentId: EnvironmentId.make("env-m3"), path: [], hops: 1 },
    });
    return Effect.gen(function* () {
      const result = yield* create({ title: "X", machine: "M1" });
      expect(result).toMatchObject({ code: "capability_denied" });
      expect(calls).toEqual([]);
    });
  });
});
