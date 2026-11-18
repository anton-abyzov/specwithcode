import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type FilesystemProjectOutcome,
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
import * as Option from "effect/Option";
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
import {
  olderMachineSpecweaveNote,
  SPECWEAVE_SET_UP_NOTE,
  specweaveCreateNote,
} from "./createOnMachine.ts";
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
    /** M1 knows studio_project_create's specweave (1396). */
    readonly m1Specweave?: boolean;
    /** M1 used an existing folder as it is. */
    readonly m1Existing?: boolean;
    /** What the local create decides for a parentPath. */
    readonly preview?: FilesystemProjectOutcome;
    /** What the local create reports. */
    readonly localResult?: {
      readonly existing?: true;
      readonly specweaveError?: string;
      readonly specweavePresent?: true;
    };
  } = {},
) => {
  const calls: RemoteCall[] = [];
  const localCreates: string[] = [];
  const localInputs: Array<{
    readonly specweave?: boolean | undefined;
    readonly specweaveOnlyIfNew?: boolean | undefined;
  }> = [];
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
              : {
                  scheduledTasks: true,
                  projectCreateOptions: true,
                  ...(options.m1Specweave ? { projectCreateSpecweave: true } : {}),
                },
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
            ...(options.m1Existing ? { existing: true } : {}),
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
      getById: (id) =>
        Effect.succeed(
          id === "local"
            ? Option.some(projectFixture(id, { title: "Local", workspaceRoot: "/projects/local" }))
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      createNamedProject: (input) =>
        Effect.sync(() => {
          localCreates.push(input.name);
          localInputs.push(input);
          return {
            projectId: ProjectId.make("local"),
            workspaceRoot: "/projects/local",
            ...options.localResult,
          };
        }),
      suggestedProjectsRoot: "/home/example/Projects",
      // The create's own decision for the parent: a new folder unless a test says otherwise.
      previewNamedProject: (input) =>
        Effect.succeed(
          Option.some(
            options.preview ?? { kind: "creates" as const, path: `${input.parentPath}/new` },
          ),
        ),
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
  return { create, calls, localCreates, localInputs };
};

describe("studio_project_create on another machine", () => {
  it.effect("creates it there in the chosen folder, and says how to launch there", () => {
    const { create, calls, localCreates } = setup();
    return Effect.gen(function* () {
      const result = yield* create({
        title: "Pinball Stats",
        machine: "M1",
        parentPath: "~/Projects",
      });
      expect(calls.map((call) => call.tool)).toEqual([
        "orchestrator_capabilities",
        "studio_project_create",
      ]);
      // Forwarded as asked, without the machine: that machine creates it on itself.
      expect(calls[1]!.arguments).toEqual({
        title: "Pinball Stats",
        parentPath: "~/Projects",
      });
      expect(result).toMatchObject({
        id: remoteProjectId,
        workspaceRoot: "/home/example/Projects/pinball-stats",
        machine: M1,
      });
      // The launch call needs no add or link step.
      expect(result.next).toContain(
        `studio_thread_launch {machine:"M1", machineProjectId:"${remoteProjectId}"}`,
      );
      expect(localCreates).toEqual([]);
    });
  });

  it.effect("leaves GitHub publishing to the user on that machine, before asking it", () => {
    const { create, calls } = setup();
    return Effect.gen(function* () {
      const result = yield* create({ title: "Pinball Stats", machine: "M1", github: true });
      expect(result).toMatchObject({ code: "outside_grant_scope" });
      expect(String(result.message)).toContain("M1: Publishing to GitHub uses this machine's own");
      expect(calls).toEqual([]);
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

describe("studio_project_create's specweave (1396 AC-17)", () => {
  it("says SpecWeave set up, or why not and what the user presses", () => {
    expect(specweaveCreateNote({ asked: undefined })).toBe(SPECWEAVE_SET_UP_NOTE);
    expect(specweaveCreateNote({ kind: "personal", asked: undefined })).toBeUndefined();
    expect(specweaveCreateNote({ kind: "personal", asked: true })).toContain("personal assistant");
    expect(specweaveCreateNote({ asked: false })).toContain("specweave was false");
    expect(specweaveCreateNote({ asked: true, skipped: "registered" })).toContain(
      "an existing folder is registered as it is",
    );
    expect(
      specweaveCreateNote({
        asked: undefined,
        skipped: "existing_folder",
        workspaceRoot: "/w/site",
      }),
    ).toContain("/w/site already existed");
    expect(
      specweaveCreateNote({
        asked: undefined,
        skipped: "existing_folder",
        workspaceRoot: "/w/site",
        present: true,
      }),
    ).toBe("SpecWeave is already set up in /w/site, which is used as it is.");
    expect(specweaveCreateNote({ asked: undefined, needsNode: true, error: "no node" })).toContain(
      "no Node.js",
    );
    expect(specweaveCreateNote({ asked: undefined, error: "specweave init exited with 1." })).toBe(
      "SpecWeave not set up: specweave init exited with 1. The project was made anyway. The user can set it up any time with Set up SpecWeave on the project's Board tab.",
    );
  });

  it.effect(
    "a new project starts with SpecWeave by default, and specweave:false leaves it out",
    () => {
      const { create, localInputs } = setup();
      return Effect.gen(function* () {
        const made = yield* create({ title: "Fresh" });
        // The create itself decides, under its lock, that the folder is new.
        expect(localInputs[0]).toMatchObject({ specweave: true, specweaveOnlyIfNew: true });
        expect(made.specweave).toBe(SPECWEAVE_SET_UP_NOTE);
        const without = yield* create({ title: "Bare", specweave: false });
        expect(localInputs[1]!.specweave).toBeUndefined();
        expect(String(without.specweave)).toContain("specweave was false");
      });
    },
  );

  it.effect("a folder the create used as it is says it already existed", () => {
    const { create, localInputs } = setup({ localResult: { existing: true } });
    return Effect.gen(function* () {
      const result = yield* create({ title: "site", parentPath: "/w/site", specweave: true });
      expect(localInputs[0]).toMatchObject({ specweave: true, specweaveOnlyIfNew: true });
      expect(result.existing).toBe(true);
      expect(String(result.specweave)).toContain("/projects/local already existed");
    });
  });

  it.effect("a folder used as it is that has SpecWeave says it is set up", () => {
    const { create } = setup({ localResult: { existing: true, specweavePresent: true } });
    return Effect.gen(function* () {
      const result = yield* create({ title: "site", parentPath: "/w/site" });
      expect(result.specweave).toBe(
        "SpecWeave is already set up in /projects/local, which is used as it is.",
      );
    });
  });

  it.effect("a failed setup keeps the project and says why", () => {
    const { create } = setup({ localResult: { specweaveError: "specweave init exited with 1" } });
    return Effect.gen(function* () {
      const result = yield* create({ title: "site", parentPath: "/w/site" });
      expect(result.id).toBeDefined();
      expect(String(result.specweave)).toContain("The project was made anyway");
    });
  });

  it.effect("a personal assistant is never given SpecWeave", () => {
    const { create, localInputs } = setup();
    return Effect.gen(function* () {
      const result = yield* create({ title: "Percy", kind: "personal" });
      expect(localInputs[0]!.specweave).toBeUndefined();
      expect(result.specweave).toBeUndefined();
    });
  });

  it.effect("forwards specweave to a machine that knows it", () => {
    const { create, calls } = setup({ m1Specweave: true });
    return Effect.gen(function* () {
      const result = yield* create({ title: "Pinball Stats", machine: "M1", specweave: false });
      expect(calls[1]!.arguments).toEqual({ title: "Pinball Stats", specweave: false });
      expect(result.specweave).toBeUndefined();
    });
  });

  it.effect("tells the caller an older machine made it without SpecWeave", () => {
    const { create, calls } = setup();
    return Effect.gen(function* () {
      const result = yield* create({ title: "Pinball Stats", machine: "M1", specweave: true });
      // Not sent to a machine that does not know it.
      expect(calls[1]!.arguments).toEqual({ title: "Pinball Stats" });
      expect(result.id).toBe(remoteProjectId);
      expect(result.specweave).toBe(olderMachineSpecweaveNote("M1"));
      // Declined, it blames no version.
      const declined = yield* create({ title: "Pinball Stats", machine: "M1", specweave: false });
      expect(declined.specweave).toBeUndefined();
    });
  });

  it.effect("blames no version for a folder an older machine used as it is", () => {
    const { create } = setup({ m1Existing: true });
    return Effect.gen(function* () {
      const result = yield* create({ title: "Pinball Stats", machine: "M1" });
      expect(result.existing).toBe(true);
      expect(result.specweave).toBeUndefined();
    });
  });
});
