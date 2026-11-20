import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTaskGrantedBy,
  type ScheduledTaskUpsertInput,
  ThreadId,
} from "@specweave-studio/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import * as RemoteWorkers from "../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";
import { workerClientName } from "../fleet/workerGrantMint.ts";
import type { EffectiveWorkGrant } from "../fleet/workGrantPolicy.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

/**
 * 1267: a routine M4's work makes here under a grant that allows routines
 * records that grant and its limits in the save, may only use a sign-in the
 * grant allows, and M4's work can change only routines its own grant made.
 */
const HERE = EnvironmentId.make("env-minis");
const M4 = EnvironmentId.make("env-m4");
const M1 = "env-m1";
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");
const linked = ProjectId.make("linked");

const project = projectFixture(linked, {
  title: "Linked",
  defaultModelSelection: { instanceId: codex, model: "gpt-5" } as never,
  workspaceSettings: {
    ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
    logicalProject: {
      id: "shared",
      title: "Shared",
      coordinatorId: "coordinator",
      members: [
        {
          environmentId: M4,
          projectId: ProjectId.make("m4-project"),
          coordinatorThreadId: ThreadId.make("c"),
        },
        { environmentId: HERE, projectId: linked, coordinatorThreadId: ThreadId.make("c") },
      ],
    },
  },
});

const routinesGrant: EffectiveWorkGrant = {
  coordinatorEnvironmentId: M4,
  projects: { kind: "linked" },
  accounts: { kind: "listed", instanceIds: [codex] },
  owner: "self",
  hopLimit: 2,
  revoked: false,
  routines: true,
};

const fromM4: McpInvocationContext.McpInvocationScope = {
  environmentId: HERE,
  requestNamespace: "client:m4",
  thread: undefined,
  client: {
    sessionId: "session",
    principal: { kind: "coordinator", environmentId: M4 },
    label: workerClientName(M4),
    access: "auto",
  },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const task = (id: string) => ({
  id: ScheduledTaskId.make(id),
  title: `Routine ${id}`,
  projectId: linked,
  prompt: "Check",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: codex, model: "gpt-5" },
  runtimeMode: "auto",
  interactionMode: "default",
  createdBy: "agent",
  creationSource: "mcp",
  nextRunAt: null,
  lastRunStatus: "never",
  ownThread: true,
});

const world = (
  grants: Record<string, ScheduledTaskGrantedBy | undefined>,
  /** Routines this machine only keeps a copy of, by the hash of what its list shows. */
  shown: Record<string, string> = {},
) => {
  const saved: Array<{
    readonly input: ScheduledTaskUpsertInput;
    readonly grantedBy: ScheduledTaskGrantedBy | null | undefined;
  }> = [];
  const deleted: Array<string> = [];
  const deletes: Array<Record<string, unknown>> = [];
  const tasks = ["owner-made", "m4-made", "m1-made"].map((id) => ({
    ...task(id),
    ...(shown[id] === undefined ? {} : { definitionHash: shown[id] }),
  }));
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: () => Effect.succeed([]),
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(id === linked ? Option.some(project) : Option.none()),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks } as never),
          readGrant: (id) => Effect.succeed(grants[id]),
          delete: (input) =>
            Effect.sync(() => {
              deleted.push(input.id);
              deletes.push({ ...input });
              return undefined as never;
            }),
          upsert: (input, options) =>
            Effect.sync(() => {
              saved.push({ input, grantedBy: options?.grantedBy });
              return {
                task: { ...task(input.id ?? "new"), ...input, threadId: null },
              } as never;
            }),
        } satisfies Partial<ScheduledTaskService.ScheduledTaskService["Service"]>),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        } satisfies Partial<ProviderAdapterRegistry.ProviderAdapterRegistryV2["Service"]>),
        NodeCrypto.layer,
      ),
    ),
  );
  const run = <A, E>(
    use: (service: OrchestratorMcpService.OrchestratorMcpService["Service"]) => Effect.Effect<A, E>,
  ) =>
    OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.flatMap(use),
      Effect.provide(layer),
      Effect.provideService(WorkGrants.WorkGrants, {
        ...(WorkGrants.WorkGrants.defaultValue() as WorkGrants.WorkGrantsShape),
        enabled: true,
        forClient: () => Effect.succeed(routinesGrant),
        forCoordinator: () => Effect.succeed(routinesGrant),
        originOf: () => Effect.succeed(undefined),
      }),
      Effect.provideService(RemoteWorkers.RemoteWorkers, {
        ...(RemoteWorkers.RemoteWorkers.defaultValue() as RemoteWorkers.RemoteWorkersShape),
        machineLabels: Effect.succeed(new Map([[M4 as string, "M4MAX"]])),
      }),
      Effect.runPromise,
    );
  return { run, saved, deleted, deletes };
};

const m4Grant: ScheduledTaskGrantedBy = {
  coordinatorEnvironmentId: M4,
  runtimeCap: "auto",
  accounts: { kind: "listed", instanceIds: [codex] },
};

describe("routines under a grant that allows them", () => {
  it("records the grant, its sign-ins and the caller's cap in the save itself", async () => {
    const { run, saved } = world({});
    await run((service) =>
      service.scheduleTask(fromM4, {
        projectId: linked,
        prompt: "Check the search console",
        schedule: { type: "interval", everyMs: 3_600_000 },
      }),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]?.input.runtimeMode).toBe("auto");
    expect(saved[0]?.grantedBy).toEqual(m4Grant);
  });

  it("refuses a model on a sign-in the grant does not allow", async () => {
    const { run, saved } = world({ "m4-made": m4Grant });
    const created = await run((service) =>
      service
        .scheduleTask(fromM4, {
          projectId: linked,
          prompt: "Check",
          schedule: { type: "interval", everyMs: 3_600_000 },
          modelSelection: { instanceId: claude, model: "opus" } as never,
        })
        .pipe(Effect.flip),
    );
    expect(created.code).toBe("account_not_allowed");
    const updated = await run((service) =>
      service
        .updateScheduledTask(fromM4, {
          scheduledTaskId: ScheduledTaskId.make("m4-made"),
          modelSelection: { instanceId: claude, model: "opus" } as never,
        })
        .pipe(Effect.flip),
    );
    expect(updated.code).toBe("account_not_allowed");
    expect(saved).toEqual([]);
  });

  it("changes a routine its own grant made, and records the grant again", async () => {
    const { run, saved } = world({ "m4-made": m4Grant });
    await run((service) =>
      service.updateScheduledTask(fromM4, {
        scheduledTaskId: ScheduledTaskId.make("m4-made"),
        prompt: "Check again",
      }),
    );
    expect(saved.map((entry) => [entry.input.id, entry.grantedBy])).toEqual([["m4-made", m4Grant]]);
  });

  it("refuses to change the owner's routine or another machine's", async () => {
    const { run, saved } = world({
      "m1-made": { coordinatorEnvironmentId: M1, runtimeCap: "auto", accounts: { kind: "all" } },
    });
    const owner = await run((service) =>
      service
        .updateScheduledTask(fromM4, {
          scheduledTaskId: ScheduledTaskId.make("owner-made"),
          prompt: "Mine now",
        })
        .pipe(Effect.flip),
    );
    expect(owner.code).toBe("outside_grant_scope");
    expect(owner.message).toContain("was set up on this machine");
    expect(owner.message).toContain("M4MAX");
    const other = await run((service) =>
      service
        .updateScheduledTask(fromM4, {
          scheduledTaskId: ScheduledTaskId.make("m1-made"),
          prompt: "Mine now",
        })
        .pipe(Effect.flip),
    );
    expect(other.code).toBe("outside_grant_scope");
    expect(other.message).toContain("another machine's work");
    expect(saved).toEqual([]);
  });
});

describe("delete_scheduled_task under a grant that allows routines", () => {
  it("deletes a routine its own grant made", async () => {
    const { run, deleted } = world({ "m4-made": m4Grant });
    await run((service) =>
      service.deleteScheduledTask(fromM4, { scheduledTaskId: ScheduledTaskId.make("m4-made") }),
    );
    expect(deleted).toEqual(["m4-made"]);
  });

  it("refuses to delete the owner's routine or another machine's", async () => {
    const { run, deleted } = world({
      "m1-made": { coordinatorEnvironmentId: M1, runtimeCap: "auto", accounts: { kind: "all" } },
    });
    const owner = await run((service) =>
      service
        .deleteScheduledTask(fromM4, { scheduledTaskId: ScheduledTaskId.make("owner-made") })
        .pipe(Effect.flip),
    );
    expect(owner.code).toBe("outside_grant_scope");
    expect(owner.message).toBe(
      `Routine "Routine owner-made" was set up on this machine, so M4MAX's work can't delete it. Ask the user here to delete it, or schedule a new routine.`,
    );
    const other = await run((service) =>
      service
        .deleteScheduledTask(fromM4, { scheduledTaskId: ScheduledTaskId.make("m1-made") })
        .pipe(Effect.flip),
    );
    expect(other.code).toBe("outside_grant_scope");
    expect(other.message).toContain("another machine's work");
    expect(deleted).toEqual([]);
  });
});

describe("a routine this machine only keeps a copy of", () => {
  const copy = { "m4-made": "shown-now" };
  const id = ScheduledTaskId.make("m4-made");

  it("is listed with the hash of the definition shown", async () => {
    const { run } = world({ "m4-made": m4Grant }, copy);
    const listed = await run((service) => service.listScheduledTasks(fromM4, {}));
    expect(
      listed.tasks.map((entry) => [
        entry.scheduledTaskId,
        (entry as { readonly definitionHash?: string }).definitionHash,
      ]),
    ).toContainEqual(["m4-made", "shown-now"]);
  });

  it("is deleted only with the hash the caller read, never one filled in for it", async () => {
    const { run, deletes } = world({ "m4-made": m4Grant }, copy);
    await run((service) => service.deleteScheduledTask(fromM4, { scheduledTaskId: id }));
    await run((service) =>
      service.deleteScheduledTask(fromM4, {
        scheduledTaskId: id,
        definitionHash: "read-earlier",
      } as never),
    );
    expect(deletes).toEqual([{ id }, { id, expectedDefinition: "read-earlier" }]);
  });

  it("is changed only with the hash the caller read, never one read for it", async () => {
    const { run, saved } = world({ "m4-made": m4Grant }, copy);
    await run((service) =>
      service.updateScheduledTask(fromM4, { scheduledTaskId: id, prompt: "Check again" }),
    );
    await run((service) =>
      service.updateScheduledTask(fromM4, {
        scheduledTaskId: id,
        prompt: "Check again",
        definitionHash: "read-earlier",
      } as never),
    );
    expect(saved.map((entry) => entry.input.expectedDefinition)).toEqual([
      undefined,
      "read-earlier",
    ]);
  });
});
