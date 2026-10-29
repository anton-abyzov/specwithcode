import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import * as WorkGrants from "../../../fleet/WorkGrants.ts";
import { unscopedGrant } from "../../../fleet/workGrantPolicy.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as MachineHandlers from "./handlers.ts";
import { MachinesToolkit } from "./tools.ts";

const callerId = ThreadId.make("coordinator");
const providerInstanceId = ProviderInstanceId.make("codex");

const setup = (caller: {
  readonly client?: McpInvocationContext.McpClientCaller;
  /** The client is another machine's own credential: a worker grant here. */
  readonly machineCredential?: boolean;
  readonly grantsEnabled?: boolean;
}) => {
  const probes: boolean[] = [];
  const remote: RemoteWorkers.RemoteWorkersShape = {
    ...RemoteWorkers.RemoteWorkers.defaultValue(),
    enabled: true,
    listMachines: ({ probe }) =>
      Effect.sync(() => {
        probes.push(probe);
        return {
          local: { id: "local", label: "M4", environmentId: EnvironmentId.make("env-m4") },
          machines: [
            {
              id: "m1",
              label: "M1",
              environmentId: EnvironmentId.make("env-m1"),
              status: "ready",
              access: "full-access",
              grantExpiresAt: null,
              ...(probe
                ? {
                    reachable: true,
                    providers: [
                      {
                        providerInstanceId,
                        driverKind: "claudeAgent",
                        models: ["claude-haiku-4-5"],
                        available: true,
                      },
                    ],
                  }
                : {}),
            },
          ],
          projectWorkerMachine: null,
        } as never;
      }),
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(RemoteWorkers.RemoteWorkers, remote),
    Layer.succeed(WorkGrants.WorkGrants, {
      ...WorkGrants.WorkGrants.defaultValue(),
      enabled: caller.grantsEnabled ?? true,
      forClient: () =>
        Effect.succeed(
          caller.machineCredential === true
            ? unscopedGrant(EnvironmentId.make("env-a"))
            : undefined,
        ),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("env-m4"),
      requestNamespace: "session",
      thread:
        caller.client === undefined
          ? { threadId: callerId, providerSessionId: "session", providerInstanceId }
          : undefined,
      client: caller.client,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () =>
        Effect.succeed({
          id: callerId,
          projectId: ProjectId.make("project"),
          runtimeMode: "full-access",
          interactionMode: "default",
          deletedAt: null,
        } as OrchestrationV2ThreadShell),
    }),
  );
  const list = MachinesToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(MachineHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
    Effect.flatMap((toolkit) =>
      toolkit
        .handle("studio_machine_list", {} as never)
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
    ),
    Effect.map((results) => results.at(-1)?.result as unknown as Record<string, unknown>),
  );
  return { list, probes };
};

it.effect("probes the machines for an outside client, within its own access", () => {
  const auto = setup({ client: { sessionId: "s", label: "Grok", access: "auto" } });
  const readOnly = setup({ client: { sessionId: "s", label: "Bot", access: "read-only" } });
  return Effect.gen(function* () {
    expect(yield* auto.list).toMatchObject({
      machines: [
        {
          id: "m1",
          status: "ready",
          reachable: true,
          // The grant allows full access there; this client was approved for auto.
          access: "auto",
          providers: [{ models: ["claude-haiku-4-5"] }],
        },
      ],
    });
    expect(auto.probes).toEqual([true]);
    expect(yield* readOnly.list).toMatchObject({
      machines: [{ reachable: true, access: "approval-required" }],
    });
    expect(readOnly.probes).toEqual([true]);
  });
});

it.effect("probes for a thread here, but not for another machine's own credential", () => {
  const thread = setup({});
  const machine = setup({
    client: { sessionId: "s", label: "M3", access: "full-access" },
    machineCredential: true,
  });
  return Effect.gen(function* () {
    expect(yield* thread.list).toMatchObject({
      machines: [{ reachable: true, access: "full-access" }],
    });
    expect(thread.probes).toEqual([true]);
    const listed = yield* machine.list;
    expect(machine.probes).toEqual([false]);
    expect((listed.machines as ReadonlyArray<object>)[0]).not.toHaveProperty("reachable");
  });
});

it.effect("never probes third machines with a machine credential when grants are disabled", () =>
  Effect.gen(function* () {
    const clients: McpInvocationContext.McpClientCaller[] = [
      {
        sessionId: "coordinator",
        label: "M3",
        access: "full-access",
        principal: { kind: "coordinator", environmentId: EnvironmentId.make("env-m3") },
      },
      {
        sessionId: "worker-label",
        label: "SpecWithCode workers · env-m3",
        access: "full-access",
      },
    ];
    for (const client of clients) {
      const machine = setup({ client, grantsEnabled: false });
      const listed = yield* machine.list;
      expect(machine.probes).toEqual([false]);
      expect((listed.machines as ReadonlyArray<object>)[0]).not.toHaveProperty("reachable");
      expect((listed.machines as ReadonlyArray<object>)[0]).not.toHaveProperty("providers");
    }
  }),
);
