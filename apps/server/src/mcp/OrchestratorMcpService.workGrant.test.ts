import { projectFixture } from "../project/ProjectWorkspace.testkit.ts";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
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
import {
  unscopedGrant,
  type EffectiveWorkGrant,
  type WorkOrigin,
} from "../fleet/workGrantPolicy.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

/**
 * 1050 M-02 against the real orchestrator service: another machine's work
 * (M4MAX, through a grant that covers only linked projects) cannot create,
 * change or delete routines here, and a bulk stop or continue reaches only a
 * project its grant covers and, there, only threads M4MAX's own work started.
 */
const HERE = EnvironmentId.make("env-m3");
const M4 = EnvironmentId.make("env-m4");
const codex = ProviderInstanceId.make("codex");
const linkedProject = ProjectId.make("linked");
const otherProject = ProjectId.make("unlinked");
const linkedLocal = ThreadId.make("linked-local");
const linkedOwned = ThreadId.make("linked-owned");
const unlinkedThread = ThreadId.make("unlinked-thread");

const projects = new Map([
  [
    linkedProject as string,
    projectFixture(linkedProject, {
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
            {
              environmentId: HERE,
              projectId: linkedProject,
              coordinatorThreadId: ThreadId.make("c"),
            },
          ],
        },
      },
    }),
  ],
  [
    otherProject as string,
    projectFixture(otherProject, {
      title: "Private",
      defaultModelSelection: { instanceId: codex, model: "gpt-5" } as never,
    }),
  ],
]);

const shell = (
  id: ThreadId,
  projectId: ProjectId,
  status: "running" | "interrupted",
): OrchestrationV2ThreadShell =>
  ({
    id,
    projectId,
    title: id,
    status,
    activityRunStatus: null,
    activeRunId: status === "running" ? RunId.make(`run-${id}`) : null,
    latestRunId: RunId.make(`run-${id}`),
    providerInstanceId: codex,
    runtimeMode: "full-access",
    interactionMode: "default",
    archivedAt: null,
    deletedAt: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  }) as unknown as OrchestrationV2ThreadShell;

const linkedOnly: EffectiveWorkGrant = {
  coordinatorEnvironmentId: M4,
  projects: { kind: "linked" },
  accounts: { kind: "all" },
  owner: "self",
  hopLimit: 2,
  revoked: false,
};

/** A grant store that knows M4MAX's grant and which thread its work started. */
const grantStore = (grant: EffectiveWorkGrant = linkedOnly): WorkGrants.WorkGrantsShape => ({
  ...(WorkGrants.WorkGrants.defaultValue() as WorkGrants.WorkGrantsShape),
  enabled: true,
  forClient: (client) =>
    Effect.succeed(
      client?.principal?.kind === "coordinator" && client.principal.environmentId === M4
        ? grant
        : undefined,
    ),
  forCoordinator: () => Effect.succeed(grant),
  originOf: (thread) =>
    Effect.succeed(
      thread.id === linkedOwned
        ? ({ coordinatorEnvironmentId: M4, path: [M4], hops: 1 } satisfies WorkOrigin)
        : undefined,
    ),
});

const clientScope = (
  principal: { kind: "coordinator"; environmentId: EnvironmentId } | { kind: "device"; id: string },
): McpInvocationContext.McpInvocationScope => ({
  environmentId: HERE,
  requestNamespace: `client:${JSON.stringify(principal)}`,
  thread: undefined,
  client: {
    sessionId: "session",
    principal,
    label: principal.kind === "coordinator" ? workerClientName(M4) : "Desktop",
    access: "full-access",
  },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});
const fromM4 = clientScope({ kind: "coordinator", environmentId: M4 });
const local = clientScope({ kind: "device", id: "desktop" });

const world = (status: "running" | "interrupted", grant: EffectiveWorkGrant = linkedOnly) => {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const saved: Array<ScheduledTaskUpsertInput> = [];
  const deleted: Array<string> = [];
  const shells = [
    shell(linkedLocal, linkedProject, status),
    shell(linkedOwned, linkedProject, status),
    shell(unlinkedThread, otherProject, status),
  ];
  const existing = {
    id: ScheduledTaskId.make("task-1"),
    projectId: otherProject,
    prompt: "Check",
    schedule: { type: "interval", everyMs: 3_600_000 },
    threadId: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    nextRunAt: null,
    lastRunStatus: "never",
    webhook: { url: "https://relay.example/hooks/task-1/token-1", hasSecret: false },
  };
  // A webhook routine in the linked project, which the grant covers.
  const linkedTask = {
    ...existing,
    id: ScheduledTaskId.make("task-linked"),
    projectId: linkedProject,
    webhook: { url: "https://relay.example/hooks/task-linked/token-2", hasSecret: false },
  };
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: ({ projectId }) =>
            Effect.succeed(shells.filter((entry) => entry.projectId === projectId)),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length } as never;
            }),
          stopDelegatedTasks: () => Effect.void as never,
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(Option.fromNullishOr(projects.get(id))),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [existing, linkedTask] } as never),
          upsert: (input) =>
            Effect.sync(() => {
              saved.push(input);
              return {
                task: {
                  ...existing,
                  ...input,
                  id: ScheduledTaskId.make(`task-${saved.length + 1}`),
                  threadId: input.threadId ?? null,
                },
              } as never;
            }),
          delete: (input) =>
            Effect.sync(() => {
              deleted.push(input.id);
              return {} as never;
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
      // The grant store and machine labels are read where the tool runs.
      Effect.provideService(WorkGrants.WorkGrants, grantStore(grant)),
      Effect.provideService(RemoteWorkers.RemoteWorkers, {
        ...(RemoteWorkers.RemoteWorkers.defaultValue() as RemoteWorkers.RemoteWorkersShape),
        machineLabels: Effect.succeed(new Map([[M4 as string, "M4MAX"]])),
      }),
      Effect.runPromise,
    );
  return { run, dispatched, saved, deleted };
};

describe("M-02: routines and bulk calls under another machine's grant", () => {
  it("refuses creating, changing and deleting routines, in any project", async () => {
    const { run, saved, deleted } = world("running");
    for (const projectId of [linkedProject, otherProject]) {
      const refused = await run((service) =>
        service
          .scheduleTask(fromM4, {
            projectId,
            prompt: "Check the search console",
            schedule: { type: "interval", everyMs: 3_600_000 },
          })
          .pipe(Effect.flip),
      );
      expect(refused.code, projectId).toBe("outside_grant_scope");
    }
    const update = await run((service) =>
      service
        .updateScheduledTask(fromM4, {
          scheduledTaskId: ScheduledTaskId.make("task-1"),
          prompt: "Something else",
        })
        .pipe(Effect.flip),
    );
    expect(update.code).toBe("outside_grant_scope");
    const removed = await run((service) =>
      service
        .deleteScheduledTask(fromM4, { scheduledTaskId: ScheduledTaskId.make("task-1") })
        .pipe(Effect.flip),
    );
    expect(removed.code).toBe("outside_grant_scope");
    expect(saved).toEqual([]);
    expect(deleted).toEqual([]);

    // A paired client without a grant still schedules and deletes as before.
    await run((service) =>
      service.scheduleTask(local, {
        projectId: otherProject,
        prompt: "Check the search console",
        schedule: { type: "interval", everyMs: 3_600_000 },
      }),
    );
    await run((service) =>
      service.deleteScheduledTask(local, { scheduledTaskId: ScheduledTaskId.make("task-1") }),
    );
    expect(saved).toHaveLength(1);
    expect(deleted).toEqual(["task-1"]);
  });

  it("lists only routines the grant covers, and never their webhook run URLs", async () => {
    const { run } = world("running");
    const fromGrant = await run((service) => service.listScheduledTasks(fromM4, {}));
    expect(fromGrant.tasks.map((task) => task.scheduledTaskId)).toEqual(["task-linked"]);
    // The URL starts the routine as this machine's own work, outside the grant.
    expect(fromGrant.tasks[0]).not.toHaveProperty("webhookUrl");
    expect(fromGrant.tasks[0]?.webhookSignature).toBe("none");
    const named = await run((service) =>
      service.listScheduledTasks(fromM4, { projectId: otherProject }),
    );
    expect(named.tasks).toEqual([]);

    // A paired client without a grant still lists every routine with its URL.
    const own = await run((service) => service.listScheduledTasks(local, {}));
    expect(own.tasks.map((task) => task.scheduledTaskId)).toEqual(["task-1", "task-linked"]);
    expect(own.tasks.every((task) => task.webhookUrl?.startsWith("https://relay.example/"))).toBe(
      true,
    );
  });

  // Review round 5: the owner's own machines, kept as legacy grants on update,
  // keep managing routines here as they did before grants existed.
  it("lets a legacy grant schedule, change, delete and list routines as before", async () => {
    const { run, saved, deleted } = world("running", { ...unscopedGrant(M4), legacy: true });
    await run((service) =>
      service.scheduleTask(fromM4, {
        projectId: otherProject,
        prompt: "Check the search console",
        schedule: { type: "interval", everyMs: 3_600_000 },
      }),
    );
    await run((service) =>
      service.updateScheduledTask(fromM4, {
        scheduledTaskId: ScheduledTaskId.make("task-1"),
        prompt: "Something else",
      }),
    );
    await run((service) =>
      service.deleteScheduledTask(fromM4, { scheduledTaskId: ScheduledTaskId.make("task-1") }),
    );
    expect(saved).toHaveLength(2);
    expect(deleted).toEqual(["task-1"]);
    const listed = await run((service) => service.listScheduledTasks(fromM4, {}));
    expect(listed.tasks.map((task) => task.scheduledTaskId)).toEqual(["task-1", "task-linked"]);
    expect(
      listed.tasks.every((task) => task.webhookUrl?.startsWith("https://relay.example/")),
    ).toBe(true);
  });

  it("stops only threads the grant covers and its own coordinator owns", async () => {
    const { run, dispatched } = world("running");
    const outside = await run((service) =>
      service.stopAllThreads(fromM4, { projectId: otherProject }).pipe(Effect.flip),
    );
    expect(outside.code).toBe("outside_grant_scope");
    expect(dispatched).toEqual([]);

    const linked = await run((service) =>
      service.stopAllThreads(fromM4, { projectId: linkedProject }),
    );
    expect(linked.count).toBe(1);
    expect(dispatched.map((command) => (command as { threadId: string }).threadId)).toEqual([
      linkedOwned,
    ]);
    expect(linked.threads.find((row) => row.threadId === linkedLocal)?.status).not.toBe(
      "stop_requested",
    );

    // Without a grant, every running thread stops as before.
    dispatched.length = 0;
    const all = await run((service) => service.stopAllThreads(local, { projectId: otherProject }));
    expect(all.count).toBe(1);
    expect(dispatched.map((command) => (command as { threadId: string }).threadId)).toEqual([
      unlinkedThread,
    ]);
  });

  it("continues only threads the grant covers and its own coordinator owns", async () => {
    const { run, dispatched } = world("interrupted");
    const outside = await run((service) =>
      service.continueAllThreads(fromM4, { projectId: otherProject }).pipe(Effect.flip),
    );
    expect(outside.code).toBe("outside_grant_scope");
    expect(dispatched).toEqual([]);
    const linked = await run((service) =>
      service.continueAllThreads(fromM4, { projectId: linkedProject }),
    );
    expect(linked.count).toBe(1);
    expect(dispatched.map((command) => (command as { threadId: string }).threadId)).toEqual([
      linkedOwned,
    ]);
  });

  // Review round 3: a grant widened past linked projects still continues only
  // its own work. This machine's own threads record no origin, so continuing
  // them would run work outside the grant's routines, sign-ins and revocation.
  it("continues only its own work in a project that is not linked", async () => {
    const { run, dispatched } = world("interrupted", { ...linkedOnly, projects: { kind: "all" } });
    const result = await run((service) =>
      service.continueAllThreads(fromM4, { projectId: otherProject }),
    );
    expect(result.count).toBe(0);
    expect(result.threads.find((row) => row.threadId === unlinkedThread)?.status).not.toBe(
      "continued",
    );
    expect(dispatched).toEqual([]);
  });

  it("continues none of its own threads on a sign-in the grant does not allow", async () => {
    const { run, dispatched } = world("interrupted", {
      ...linkedOnly,
      accounts: { kind: "listed", instanceIds: [ProviderInstanceId.make("claude")] },
    });
    const result = await run((service) =>
      service.continueAllThreads(fromM4, { projectId: linkedProject }),
    );
    expect(result.count).toBe(0);
    expect(dispatched).toEqual([]);
  });
});
