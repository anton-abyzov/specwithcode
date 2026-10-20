import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  type LogicalProject,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";

import * as FleetWorkerGrants from "./FleetWorkerGrants.ts";
import * as RemoteWorkerFollower from "./RemoteWorkerFollower.ts";
import * as RemoteWorkers from "./RemoteWorkers.ts";
import * as RemoteWorkerStore from "./RemoteWorkerStore.ts";
import {
  allow,
  allowLater,
  capabilities,
  eventually,
  launchAnswer,
  launchInput,
  M1,
  project,
  remoteProject,
  rows,
  setup,
} from "./remoteWorkers.testkit.ts";

describe("RemoteWorkers", () => {
  it.live("sends the delegation path and says when that machine is too old to check it", () => {
    let answer: Record<string, unknown> = launchAnswer;
    const { remote, layer } = setup({ studio_thread_launch: () => ({ result: answer }) });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      const older = yield* workers.launch(launchInput());
      expect(
        remote.toolCalls.find((call) => call.name === "studio_thread_launch")?.args.delegation,
      ).toEqual({ path: ["env-m4"], hops: 1 });
      // A worker from before grants had scopes neither refuses loops nor limits projects.
      expect(older.machineNotice).toContain("older SpecWithCode");
      answer = { ...launchAnswer, threadId: "b-thread-2", delegationChecked: true };
      const current = yield* workers.launch(launchInput({ commandId: "command-2" }));
      expect(current.machineNotice).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "launches canonical workers only into fresh verified admitted bindings, including transferred source projects",
    () => {
      const logical: LogicalProject = {
        id: "canonical-project",
        title: "App",
        coordinatorId: "coordinator-lineage",
        members: [
          {
            environmentId: M1.environmentId,
            projectId: ProjectId.make("remote-project"),
            coordinatorThreadId: ThreadId.make("source-coordinator"),
          },
        ],
      };
      let linked = {
        ...remoteProject,
        workspaceSettings: {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          logicalProject: logical,
          coordinatorThreadId: ThreadId.make("source-coordinator"),
          coordinatorBinding: { state: "transferred" as const, epoch: 0 },
        },
      };
      const { world, remote, layer } = setup({ studio_project_read: () => ({ result: linked }) });
      world.local.current = project({
        workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, logicalProject: logical },
      });
      return Effect.gen(function* () {
        yield* allow();
        const workers = yield* RemoteWorkers.RemoteWorkers;
        const result = yield* workers.launch(launchInput({ localProject: world.local.current }));
        expect(result.projectId).toBe("remote-project");
        expect(remote.toolCalls.some((call) => call.name === "studio_project_list")).toBe(false);
        expect(
          remote.toolCalls.find((call) => call.name === "studio_thread_launch")?.args.projectId,
        ).toBe("remote-project");
        // A stale successful probe or previous launch must never authorize a later detached project.
        linked = {
          ...linked,
          workspaceSettings: {
            ...linked.workspaceSettings,
            logicalProject: { ...logical, id: "now-unrelated" },
          },
        };
        expect(
          (yield* workers
            .launch(launchInput({ commandId: "second", localProject: world.local.current }))
            .pipe(Effect.flip)).code,
        ).toBe("project_unavailable_on_machine");
        expect(
          remote.toolCalls.filter((call) => call.name === "studio_thread_launch"),
        ).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "never falls back to a repository match or an unadmitted explicit project for canonical launches",
    () => {
      const logical: LogicalProject = {
        id: "canonical-project",
        title: "App",
        coordinatorId: "coordinator-lineage",
        members: [],
      };
      const { world, remote, layer } = setup();
      world.local.current = project({
        workspaceSettings: {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          logicalProject: logical,
          workerMachine: {
            machineId: M1.id,
            environmentId: M1.environmentId,
            projectId: ProjectId.make("remote-project"),
          },
        },
      });
      return Effect.gen(function* () {
        yield* allow();
        const workers = yield* RemoteWorkers.RemoteWorkers;
        for (const explicit of [undefined, ProjectId.make("remote-project")]) {
          const error = yield* workers
            .launch(launchInput({ localProject: world.local.current, machineProjectId: explicit }))
            .pipe(Effect.flip);
          expect(error.code).toBe("project_unavailable_on_machine");
          expect(error.message).toContain("execution binding");
        }
        const machines = yield* workers.listMachines({
          projectId: world.local.current.id,
          probe: true,
        });
        expect(machines.machines[0]?.project?.match).toBe("none");
        expect(remote.toolCalls.some((call) => call.name === "studio_thread_launch")).toBe(false);
        expect(yield* rows).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("rejects ambiguous canonical launches before any destination project is selected", () => {
    const logical: LogicalProject = {
      id: "canonical-project",
      title: "App",
      coordinatorId: "coordinator-lineage",
      members: ["old", "new"].map((id) => ({
        environmentId: M1.environmentId,
        projectId: ProjectId.make(id),
        coordinatorThreadId: ThreadId.make(`coordinator-${id}`),
      })),
    };
    const { world, remote, layer } = setup();
    world.local.current = project({
      workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, logicalProject: logical },
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      expect(
        (yield* workers
          .launch(launchInput({ localProject: world.local.current }))
          .pipe(Effect.flip)).code,
      ).toBe("project_ambiguous_on_machine");
      expect(remote.toolCalls).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves a logical project's explicit binding without repository heuristics", () => {
    const logical: LogicalProject = {
      id: "canonical-project",
      title: "App",
      coordinatorId: "coordinator-lineage",
      members: [
        {
          environmentId: EnvironmentId.make("env-m1"),
          projectId: ProjectId.make("remote-project"),
          coordinatorThreadId: ThreadId.make("remote-coordinator"),
        },
      ],
    };
    const { world, remote, layer } = setup({
      studio_project_read: () => ({
        result: {
          ...remoteProject,
          workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, logicalProject: logical },
        },
      }),
    });
    world.local.current = project({
      workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, logicalProject: logical },
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      expect(
        yield* workers.remoteProjectFor({ machine: M1, localProjectId: world.local.current.id }),
      ).toBe("remote-project");
      expect(remote.toolCalls.map((call) => call.name)).toEqual(["studio_project_read"]);
      world.local.current = project({
        workspaceSettings: {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          logicalProject: { ...logical, members: [] },
        },
      });
      expect(
        (yield* workers
          .remoteProjectFor({ machine: M1, localProjectId: world.local.current.id })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_request");
      // The same repository is present remotely, but cannot repair an absent canonical binding.
      expect(remote.toolCalls.map((call) => call.name)).toEqual(["studio_project_read"]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "refuses ambiguous logical bindings instead of choosing a same-repository project",
    () => {
      const logical: LogicalProject = {
        id: "canonical-project",
        title: "App",
        coordinatorId: "coordinator-lineage",
        members: ["old", "new"].map((id) => ({
          environmentId: EnvironmentId.make("env-m1"),
          projectId: ProjectId.make(id),
          coordinatorThreadId: ThreadId.make(`coordinator-${id}`),
        })),
      };
      const { world, remote, layer } = setup();
      world.local.current = project({
        workspaceSettings: { ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, logicalProject: logical },
      });
      return Effect.gen(function* () {
        const workers = yield* RemoteWorkers.RemoteWorkers;
        expect(
          (yield* workers
            .remoteProjectFor({ machine: M1, localProjectId: world.local.current.id })
            .pipe(Effect.flip)).code,
        ).toBe("invalid_request");
        expect(remote.toolCalls).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("lists machines with their grant, providers and the matching project", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const workers = yield* RemoteWorkers.RemoteWorkers;
      const before = yield* workers.listMachines({
        projectId: ProjectId.make("local-project"),
        probe: true,
      });
      expect(before.local).toEqual({ id: "local", label: "M4", environmentId: "env-m4" });
      expect(before.machines).toMatchObject([{ id: "m1", status: "needs_grant", access: null }]);
      yield* allow();
      const after = yield* workers.listMachines({
        projectId: ProjectId.make("local-project"),
        probe: true,
      });
      expect(after.machines[0]).toMatchObject({
        id: "m1",
        label: "M1",
        status: "ready",
        access: "auto",
        project: { match: "identity", projectId: "remote-project", title: "App" },
        providers: [{ providerInstanceId: "codex", driverKind: "codex", models: ["gpt-5.5"] }],
      });
      expect(after.machines[0]?.project).not.toHaveProperty("reason");
    }).pipe(Effect.provide(layer));
  });

  it.live("carries each provider's shared usage and grant, and drops malformed usage", () => {
    const usage = {
      accountFingerprint: `sha256:${"a".repeat(64)}`,
      usedPercent: 40,
      resetsAt: "2026-10-20T18:00:00.000Z",
      signedIn: true,
      observedAt: "2026-10-20T13:00:00.000Z",
      token: "never-shared",
    };
    const { layer } = setup({
      orchestrator_capabilities: () => ({
        result: {
          ...capabilities,
          providers: [
            { ...capabilities.providers[0], usage, allowedByGrant: true },
            {
              ...capabilities.providers[0],
              providerInstanceId: "claude",
              driverKind: "claudeAgent",
              usage: { accountFingerprint: "acct@example.com", usedPercent: 140, signedIn: true },
              allowedByGrant: false,
            },
            {
              ...capabilities.providers[0],
              providerInstanceId: "grok",
              driverKind: "grok",
              usage: "full",
            },
          ],
        },
      }),
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      const listed = yield* workers.listMachines({
        projectId: ProjectId.make("local-project"),
        probe: true,
      });
      const [codex, claude, grok] = listed.machines[0]?.providers ?? [];
      const { token: _token, ...shared } = usage;
      expect(codex).toMatchObject({ usage: shared, allowedByGrant: true });
      expect(codex?.usage).not.toHaveProperty("token");
      expect(claude).toMatchObject({
        allowedByGrant: false,
        usage: { accountFingerprint: null, usedPercent: null, resetsAt: null, observedAt: null },
      });
      expect(grok).not.toHaveProperty("usage");
      expect(grok).not.toHaveProperty("allowedByGrant");
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves machines by id, label, environment and thread link", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const workers = yield* RemoteWorkers.RemoteWorkers;
      expect(yield* workers.resolveMachine(undefined)).toEqual({ kind: "local" });
      expect(yield* workers.resolveMachine("local")).toEqual({ kind: "local" });
      expect(yield* workers.resolveMachine("env-m4")).toEqual({ kind: "local" });
      expect(yield* workers.resolveMachine("m1")).toEqual({ kind: "remote", machine: M1 });
      expect(yield* workers.resolveMachine("M1")).toEqual({ kind: "remote", machine: M1 });
      expect(yield* workers.resolveMachine("env-m1")).toEqual({ kind: "remote", machine: M1 });
      expect((yield* workers.resolveMachine("m9").pipe(Effect.flip)).code).toBe("unknown_machine");
      expect(
        yield* workers.resolveThread({ machine: undefined, threadId: "studio://thread/env-m1/t1" }),
      ).toEqual({ target: { kind: "remote", machine: M1 }, threadId: "t1" });
      expect(
        yield* workers.resolveThread({ machine: undefined, threadId: "studio://thread/t2" }),
      ).toEqual({ target: { kind: "local" }, threadId: "t2" });
      expect(
        (yield* workers
          .resolveThread({ machine: "local", threadId: "studio://thread/env-m1/t1" })
          .pipe(Effect.flip)).code,
      ).toBe("invalid_request");
    }).pipe(Effect.provide(layer));
  });

  it.live("launches there within the grant, then wakes the caller once when it finishes", () => {
    const { world, remote, layer } = setup();
    return Effect.gen(function* () {
      yield* allow("auto");
      const workers = yield* RemoteWorkers.RemoteWorkers;
      const result = yield* workers.launch(launchInput());
      expect(result).toMatchObject({
        threadId: "b-thread-1",
        projectId: "remote-project",
        machine: M1,
        threadRef: "studio://thread/env-m1/b-thread-1",
        reportsBack: true,
        // The coordinator learns its worker runs below its own mode, and why.
        runtimeMode: "auto",
        runtimeModeLoweredFrom: "full-access",
      });
      const launch = remote.toolCalls.find((call) => call.name === "studio_thread_launch");
      // Full access here, but the user allowed only auto on M1; the model moved to M1's codex.
      expect(launch?.args).toMatchObject({
        projectId: "remote-project",
        runtimeMode: "auto",
        modelSelection: { instanceId: "codex", model: "gpt-5.5" },
        title: "Fix the flaky test",
        message: "Fix it",
      });
      const [row] = yield* eventually(rows, (current) => current[0]?.state === "idle");
      expect(row).toMatchObject({
        id: "rwt:command-1",
        remoteThreadId: "b-thread-1",
        lastStatus: "completed",
        deliveredRunIds: ["b-run-1"],
      });
      expect(world.wakes).toEqual([
        {
          commandId: "remote-worker-wake:rwt:command-1:b-run-1",
          mode: "queue",
          text: 'Remote worker [Fix the flaky test](studio://thread/env-m1/b-thread-1) on M1 finished: completed. Read it with studio_thread_read {threadId:"studio://thread/env-m1/b-thread-1"}.',
        },
      ]);
      // People see a notice naming the worker and machine, never the agent-facing text.
      expect(world.notices).toEqual([
        {
          createdBy: "agent",
          summary: "[Fix the flaky test](studio://thread/env-m1/b-thread-1) on M1 reported back.",
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("starts Codex and Claude workers on Full access for a Full access coordinator", () => {
    const { remote, layer } = setup({
      orchestrator_capabilities: () => ({
        result: {
          ...capabilities,
          runtimeMode: "full-access",
          providers: [
            ...capabilities.providers,
            {
              providerInstanceId: "claude",
              driverKind: "claudeAgent",
              displayName: null,
              models: [{ id: "opus", label: null }],
              canRunChildTask: true,
              canRunCrossProviderChildTask: true,
              constraints: [],
            },
          ],
        },
      }),
      studio_thread_launch: (args) => ({
        result: {
          ...launchAnswer,
          threadId: `b-thread-${String((args.modelSelection as ModelSelection).instanceId)}`,
          modelSelection: args.modelSelection,
        },
      }),
    });
    return Effect.gen(function* () {
      yield* allow("full-access");
      const workers = yield* RemoteWorkers.RemoteWorkers;
      for (const modelSelection of [
        { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
        { instanceId: ProviderInstanceId.make("claude"), model: "opus" },
      ] as ReadonlyArray<ModelSelection>) {
        const result = yield* workers.launch(
          launchInput({
            commandId: `command-${modelSelection.instanceId}`,
            explicitModelSelection: modelSelection,
            runtimeMode: "full-access",
          }),
        );
        expect(result.runtimeMode).toBe("full-access");
        expect(result.runtimeModeLoweredFrom).toBeUndefined();
        expect(result.modelSelection).toEqual(modelSelection);
      }
      const launches = remote.toolCalls.filter((call) => call.name === "studio_thread_launch");
      expect(
        launches.map((call) => [
          (call.args.modelSelection as ModelSelection).instanceId,
          call.args.runtimeMode,
        ]),
      ).toEqual([
        ["codex", "full-access"],
        ["claude", "full-access"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("refuses an explicit mode above the grant and a model the machine lacks", () => {
    const { remote, layer } = setup();
    return Effect.gen(function* () {
      yield* allow("auto");
      const workers = yield* RemoteWorkers.RemoteWorkers;
      const escalation = yield* workers
        .launch(launchInput({ requestedRuntimeMode: "full-access" }))
        .pipe(Effect.flip);
      expect(escalation.code).toBe("runtime_mode_escalation_denied");
      const model = yield* workers
        .launch(
          launchInput({
            explicitModelSelection: {
              instanceId: ProviderInstanceId.make("claude"),
              model: "opus",
            } as ModelSelection,
          }),
        )
        .pipe(Effect.flip);
      expect(model.code).toBe("model_unavailable_on_machine");
      expect(remote.toolCalls.some((call) => call.name === "studio_thread_launch")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("reports a missing grant and a project without a match there", () => {
    const { layer } = setup({
      studio_project_list: () => ({ result: { projects: [], nextCursor: null } }),
    });
    return Effect.gen(function* () {
      const workers = yield* RemoteWorkers.RemoteWorkers;
      expect((yield* workers.launch(launchInput()).pipe(Effect.flip)).code).toBe(
        "machine_not_authorized",
      );
      yield* allow();
      expect((yield* workers.launch(launchInput()).pipe(Effect.flip)).code).toBe(
        "project_unavailable_on_machine",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("asks again while the other machine is still reading its repositories", () => {
    let lists = 0;
    const { remote, layer } = setup({
      // A machine that just started has not read its projects' repositories yet.
      studio_project_list: () => ({
        result: {
          projects: [
            {
              ...remoteProject,
              repositoryIdentity: ++lists < 2 ? null : remoteProject.repositoryIdentity,
            },
          ],
          nextCursor: null,
        },
      }),
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      expect(yield* workers.launch(launchInput())).toMatchObject({ projectId: "remote-project" });
      expect(lists).toBe(2);
      expect(remote.toolCalls.filter((call) => call.name === "studio_thread_launch")).toHaveLength(
        1,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("falls back to this project's worker model when the remote project has none", () => {
    let launches = 0;
    const { remote, layer } = setup({
      studio_thread_launch: (args) => {
        launches += 1;
        return args.modelSelection === undefined
          ? {
              failure:
                "Pass modelSelection: the project has no default model. orchestrator_capabilities lists providers and models.",
            }
          : { result: launchAnswer };
      },
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(
        launchInput({
          inheritedModelSelection: {
            instanceId: ProviderInstanceId.make("other"),
            model: "unknown-model",
          } as ModelSelection,
        }),
      );
      expect(launches).toBe(2);
      expect(
        remote.toolCalls.filter((call) => call.name === "studio_thread_launch")[1]?.args,
      ).toMatchObject({ modelSelection: { instanceId: "codex", model: "gpt-5.5" } });
    }).pipe(Effect.provide(layer));
  });

  it.live("never launches twice when the answer is lost, and finds the thread it made", () => {
    let launches = 0;
    const { world, layer } = setup({
      studio_thread_launch: () => {
        launches += 1;
        return { raw: new Response("not json", { status: 200 }) };
      },
    });
    world.tools.studio_thread_list = () => ({
      result: {
        projectId: "remote-project",
        currentThreadId: null,
        threads: [
          {
            threadId: "b-thread-9",
            title: "Fix the flaky test",
            createdBy: "agent",
            creationSource: "mcp",
            status: "running",
            latestRunId: "b-run-9",
            providerInstanceId: "codex",
            model: "gpt-5.5",
            createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
          },
        ],
        nextCursor: null,
        total: 1,
      },
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      const result = yield* workers.launch(launchInput());
      expect(launches).toBe(1);
      expect(result).toMatchObject({ threadId: "b-thread-9", runId: "b-run-9" });
    }).pipe(Effect.provide(layer));
  });

  it.live("follows a launch whose answer comes from a machine on another version", () => {
    const { layer } = setup({
      studio_thread_launch: () => ({
        result: {
          ...launchAnswer,
          // A status and model shape this version does not know.
          status: "warming_up",
          modelSelection: { provider: "codex", modelId: "gpt-9" },
        },
      }),
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      const result = yield* workers.launch(launchInput());
      expect(result).toMatchObject({ threadId: "b-thread-1", runId: "b-run-1", status: null });
      expect((yield* rows)[0]).toMatchObject({
        remoteThreadId: "b-thread-1",
        followedRunId: "b-run-1",
      });
    }).pipe(Effect.provide(layer));
  });

  it.live("says a lost launch is unconfirmed when nothing matches, without retrying", () => {
    let launches = 0;
    const { world, layer } = setup({
      studio_thread_launch: () => {
        launches += 1;
        return { raw: new Response("not json", { status: 200 }) };
      },
    });
    world.tools.studio_thread_list = () => ({
      result: {
        projectId: "remote-project",
        currentThreadId: null,
        threads: [],
        nextCursor: null,
        total: 0,
      },
    });
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      const error = yield* workers.launch(launchInput()).pipe(Effect.flip);
      expect(error.code).toBe("remote_launch_unconfirmed");
      expect(launches).toBe(1);
      expect((yield* rows)[0]?.state).toBe("launch_unknown");
    }).pipe(Effect.provide(layer));
  });

  it.live("parks on a revoked grant and resumes once workers are allowed again", () => {
    const { world, remote, layer } = setup();
    let finished = false;
    world.tools.studio_thread_wait = () =>
      finished
        ? {
            result: { threadId: "b-thread-1", runId: "b-run-1", status: "failed", timedOut: false },
          }
        : {
            result: { threadId: "b-thread-1", runId: "b-run-1", status: "running", timedOut: true },
          };
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(launchInput());
      // The other machine revokes this grant: every later call answers 401.
      remote.revoke("mcp-token-auto-1");
      yield* eventually(rows, (current) => current[0]?.state === "paused_auth");
      const grants = yield* FleetWorkerGrants.FleetWorkerGrants;
      expect((yield* grants.status("m1")).status).toBe("revoked");
      expect(world.wakes).toEqual([]);
      finished = true;
      // The user allows workers again (past the one-a-minute limit).
      yield* allowLater;
      yield* eventually(rows, (current) => current[0]?.state === "idle");
      expect(world.wakes.map((wake) => wake.text)).toEqual([
        expect.stringContaining("finished: failed"),
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("drops the wake for an archived caller and holds it while the project is paused", () => {
    const { world, layer } = setup();
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      world.local.current = project({
        workspaceSettings: {
          ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
          coordinatorThreadId: ThreadId.make("coordinator"),
          paused: true,
        },
      });
      yield* workers.launch(launchInput());
      yield* eventually(rows, (current) => current[0]?.state === "wake_pending");
      expect(world.wakes).toEqual([]);
      world.local.current = project();
      yield* eventually(rows, (current) => current[0]?.state === "idle");
      expect(world.wakes).toHaveLength(1);

      world.caller.archived = true;
      yield* workers.launch(launchInput({ commandId: "command-2" }));
      yield* eventually(rows, (current) =>
        current.some((row) => row.id === "rwt:command-2" && row.state === "disposed"),
      );
      expect(world.wakes).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("does not wake a caller that already saw the run finish", () => {
    let release = false;
    const { world, layer } = setup();
    world.tools.studio_thread_wait = () =>
      release
        ? {
            result: {
              threadId: "b-thread-1",
              runId: "b-run-1",
              status: "completed",
              timedOut: false,
            },
          }
        : {
            result: { threadId: "b-thread-1", runId: "b-run-1", status: "running", timedOut: true },
          };
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(launchInput());
      yield* workers.noteFinished({
        callerThreadId: ThreadId.make("coordinator"),
        machineId: "m1",
        remoteThreadId: "b-thread-1",
        runId: "b-run-1",
        status: "completed",
      });
      release = true;
      yield* eventually(rows, (current) => current[0]?.state === "idle");
      yield* Effect.sleep("100 millis");
      expect(world.wakes).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("settles a launch left in flight by a restart, and follows the thread it finds", () => {
    const { world, layer } = setup();
    world.tools.studio_thread_list = () => ({
      result: {
        projectId: "remote-project",
        currentThreadId: null,
        threads: [
          {
            threadId: "b-thread-1",
            title: "Fix the flaky test",
            createdBy: "agent",
            creationSource: "mcp",
            status: "running",
            latestRunId: "b-run-1",
            createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
          },
        ],
        nextCursor: null,
        total: 1,
      },
    });
    return Effect.gen(function* () {
      yield* allow();
      const store = yield* RemoteWorkerStore.RemoteWorkerStore;
      const startedAt = DateTime.formatIso(
        DateTime.makeUnsafe(DateTime.toEpochMillis(DateTime.nowUnsafe()) - 5 * 60_000),
      );
      yield* store.modify("rwt:stale", () => ({
        id: "rwt:stale",
        callerThreadId: "coordinator",
        projectId: "local-project",
        machineId: "m1",
        environmentId: "env-m1",
        remoteProjectId: "remote-project",
        remoteThreadId: null,
        title: "Fix the flaky test",
        launchStartedAt: startedAt,
        followedRunId: null,
        reportBack: true,
        state: "launching",
        lastStatus: null,
        deliveredRunIds: [],
        lostContactNotified: false,
        lastError: null,
        updatedAt: startedAt,
      }));
      const follower = yield* RemoteWorkerFollower.RemoteWorkerFollower;
      yield* follower.resume;
      const [row] = yield* eventually(rows, (current) => current[0]?.state === "idle");
      expect(row?.remoteThreadId).toBe("b-thread-1");
      expect(world.wakes).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("lists this project's remote workers for the UI without tokens", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* allow();
      const workers = yield* RemoteWorkers.RemoteWorkers;
      yield* workers.launch(launchInput());
      const listed = yield* eventually(
        workers.workersForProject(ProjectId.make("local-project")),
        (current) => current[0]?.state === "idle",
      );
      expect(listed).toMatchObject([
        {
          id: "rwt:command-1",
          machineId: "m1",
          machineLabel: "M1",
          remoteThreadId: "b-thread-1",
          threadRef: "studio://thread/env-m1/b-thread-1",
          title: "Fix the flaky test",
          lastStatus: "completed",
          reachable: true,
        },
      ]);
      expect(JSON.stringify(listed)).not.toContain("mcp-token");
    }).pipe(Effect.provide(layer));
  });
});
