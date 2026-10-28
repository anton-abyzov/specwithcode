// @effect-diagnostics nodeBuiltinImport:off - disposable real Git fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2Run,
  ProjectId,
  ThreadId,
  threadTurnKey,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { makeSubagentLaunchHooks } from "../orchestration-v2/Adapters/ClaudeSubagentLaunchHook.ts";
import * as SubagentLaunchCheckpoints from "../orchestration-v2/SubagentLaunchCheckpoints.ts";
import * as HandoffMode from "./HandoffMode.ts";
import { launchCheckpoint } from "./HandoffModeReactor.ts";
import * as HandoffModeStore from "./HandoffModeStore.ts";
import { fenceRecord, emptyThreadRecord } from "./handoffState.ts";

const temporary: Array<string> = [];
const projectId = ProjectId.make("project-handoff");
const threadId = ThreadId.make("thread-handoff");
const environmentId = EnvironmentId.make("env-m4");

afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

function repository(): string {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-handoff-service-")),
  );
  temporary.push(root);
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync(
      "git",
      ["-c", "user.name=Handoff Test", "-c", "user.email=handoff@example.invalid", ...args],
      {
        cwd: root,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: "ignore",
      },
    );
  git("init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(root, "app.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  NodeFS.writeFileSync(NodePath.join(root, "app.ts"), "export const a = 2;\n");
  return root;
}

interface Fixture {
  runStatus: OrchestrationV2Run["status"];
  activeRunId: string | null;
  latestRunId: string | null;
  kind?: "personal";
}

function layerFor(root: string, fixture: Fixture) {
  const stubs = Layer.mergeAll(
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.succeed({ label: "M4" }),
    } as unknown as ServerEnvironment.ServerEnvironment["Service"]),
    Layer.succeed(ProjectService.ProjectService, {
      getById: (id: ProjectId) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id: projectId,
                workspaceRoot: root,
                workspaceSettings: fixture.kind ? { kind: fixture.kind } : null,
              })
            : Option.none(),
        ),
    } as unknown as ProjectService.ProjectService["Service"]),
    Layer.succeed(ProjectionStore.ProjectionStoreV2, {
      getThreadShell: (id: ThreadId) =>
        Effect.succeed(
          id === threadId
            ? {
                id,
                projectId,
                worktreePath: null,
                activeRunId: fixture.activeRunId,
                latestRunId: fixture.latestRunId,
                lastErrorClass: null,
                modelSelection: { instanceId: "claude", model: "claude-opus" },
              }
            : null,
        ),
      getThreadRecords: () =>
        Effect.succeed({
          messages: [
            { role: "user", text: "Fix the login redirect.", streaming: false },
            { role: "assistant", text: "Patched the redirect. A test is next.", streaming: false },
          ],
          runs: [{ id: fixture.latestRunId, status: fixture.runStatus }],
          turnItems: [],
          subagents: [],
        }),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
    Layer.succeed(
      ServerSettings.ServerSettingsService,
      {} as unknown as ServerSettings.ServerSettingsService["Service"],
    ),
    Layer.succeed(
      TextGeneration.TextGeneration,
      {} as unknown as TextGeneration.TextGeneration["Service"],
    ),
  );
  return Layer.effect(HandoffMode.HandoffMode, HandoffMode.make).pipe(
    Layer.provideMerge(HandoffModeStore.layer),
    Layer.provideMerge(stubs),
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(root, { prefix: "swc-handoff-state-" }))),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
}

const run = (id: string, status: OrchestrationV2Run["status"]) =>
  ({ id, threadId, status }) as unknown as OrchestrationV2Run;

const sideEffect = (runId: string) =>
  ({ threadId, runId, kind: "pr-create", target: "anton/app#feature" }) as const;

describe("HandoffMode", () => {
  it.effect("does nothing for a thread whose project never turned handoff mode on", () => {
    const fixture: Fixture = { runStatus: "running", activeRunId: "run-1", latestRunId: "run-1" };
    return Effect.gen(function* () {
      const handoff = yield* HandoffMode.HandoffMode;
      yield* handoff.observeRun(run("run-1", "running"));
      expect(yield* handoff.fence(threadId, "run-1")).toEqual({ kind: "unleased" });
      expect(yield* handoff.guardSideEffect(sideEffect("run-1"))).toMatchObject({
        kind: "proceed",
        epoch: 0,
      });
      yield* handoff.recordSideEffect({ ...sideEffect("run-1"), result: "#12" });
      expect((yield* handoff.snapshot).threads).toEqual([]);
    }).pipe(Effect.provide(layerFor(repository(), fixture)));
  });

  it.effect("never turns on or checkpoints a personal assistant's thread", () => {
    const fixture: Fixture = {
      runStatus: "running",
      activeRunId: "run-1",
      latestRunId: "run-1",
      kind: "personal",
    };
    return Effect.gen(function* () {
      const handoff = yield* HandoffMode.HandoffMode;
      const projectMode = yield* handoff
        .setProjectMode({ projectId, mode: "on" })
        .pipe(Effect.flip);
      expect(projectMode).toMatchObject({ code: "invalid" });
      expect(projectMode.message).toContain("private to its machine");
      const threadMode = yield* handoff.setThreadMode({ threadId, mode: "on" }).pipe(Effect.flip);
      expect(threadMode).toMatchObject({ code: "invalid" });
      // Turning it off stays allowed.
      yield* handoff.setThreadMode({ threadId, mode: "off" });
      const manual = yield* handoff.checkpoint(threadId, "manual").pipe(Effect.flip);
      expect(manual).toMatchObject({ code: "invalid" });
      expect(yield* handoff.checkpoint(threadId, "turn-end")).toBeNull();
      expect((yield* handoff.snapshot).threads.every((thread) => thread.checkpoint === null)).toBe(
        true,
      );
    }).pipe(Effect.provide(layerFor(repository(), fixture)));
  });

  it.effect("sets a project override only for a project on this machine", () => {
    const fixture: Fixture = { runStatus: "running", activeRunId: "run-1", latestRunId: "run-1" };
    return Effect.gen(function* () {
      const handoff = yield* HandoffMode.HandoffMode;
      const elsewhere = ProjectId.make("project-on-another-machine");
      const refused = yield* handoff
        .setProjectMode({ projectId: elsewhere, mode: "on" })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({ code: "invalid" });
      expect(refused.message).toBe("That project is not on this machine.");
      // Clearing a stale entry always works.
      yield* handoff.setProjectMode({ projectId: elsewhere, mode: null });
      const snapshot = yield* handoff.setProjectMode({ projectId, mode: "off" });
      expect(snapshot.projectModes).toEqual({ [projectId]: "off" });
      // The origin backup is off until the person turns it on.
      expect(snapshot.config.pushToOrigin).toBe(false);
    }).pipe(Effect.provide(layerFor(repository(), fixture)));
  });

  it.effect("leases a running thread, journals its side effect and checkpoints at turn end", () => {
    const fixture: Fixture = { runStatus: "running", activeRunId: "run-1", latestRunId: "run-1" };
    const root = repository();
    return Effect.gen(function* () {
      const handoff = yield* HandoffMode.HandoffMode;
      yield* handoff.updateConfig({ pushToOrigin: false });
      yield* handoff.setProjectMode({ projectId, mode: "on" });
      yield* handoff.observeRun(run("run-1", "running"));
      expect(yield* handoff.fence(threadId, "run-1")).toEqual({ kind: "ok", epoch: 1 });

      expect(yield* handoff.guardSideEffect(sideEffect("run-1"))).toEqual({
        kind: "proceed",
        epoch: 1,
        turnKey: threadTurnKey(threadId, "run-1"),
      });
      yield* handoff.recordSideEffect({ ...sideEffect("run-1"), result: "#12" });
      const reused = yield* handoff.guardSideEffect(sideEffect("run-1"));
      expect(reused).toMatchObject({ kind: "reuse", effect: { result: "#12", epoch: 1 } });

      fixture.runStatus = "completed";
      fixture.activeRunId = null;
      yield* handoff.observeRun(run("run-1", "completed"));
      const [thread] = (yield* handoff.snapshot).threads;
      const checkpoint = thread?.checkpoint;
      expect(checkpoint).toMatchObject({
        sequence: 1,
        reason: "turn-end",
        branch: "main",
        epoch: 1,
        latestRunId: "run-1",
        turnKey: threadTurnKey(threadId, "run-1"),
        runEnding: "completed",
        transcriptMessageCount: 2,
        pushedToOrigin: false,
        sourceRoot: {
          environmentId,
          machineLabel: "M4",
          projectId,
          threadId,
          workspaceRoot: root,
          branch: "main",
        },
      });
      expect(checkpoint?.sideEffects).toHaveLength(1);
      expect(checkpoint?.note?.next).toContain("Fix the login redirect");
      const ref = NodeChildProcess.execFileSync("git", ["rev-parse", checkpoint!.ref], {
        cwd: root,
        encoding: "utf8",
      });
      expect(ref.trim()).toBe(checkpoint?.commit);

      expect(yield* handoff.checkpoint(threadId, "turn-end")).toBeNull();
    }).pipe(Effect.provide(layerFor(root, fixture)));
  });

  it.effect(
    "fences a copy another machine continued: no lease, no side effect, no checkpoint",
    () => {
      const fixture: Fixture = { runStatus: "running", activeRunId: "run-1", latestRunId: "run-1" };
      return Effect.gen(function* () {
        const handoff = yield* HandoffMode.HandoffMode;
        const store = yield* HandoffModeStore.HandoffModeStore;
        yield* handoff.updateConfig({ pushToOrigin: false });
        yield* handoff.setProjectMode({ projectId, mode: "on" });
        yield* handoff.observeRun(run("run-1", "running"));
        yield* handoff.recordSideEffect({ ...sideEffect("run-1"), result: "#12" });

        yield* store.update((document) => {
          const current = document.threads[threadId] ?? emptyThreadRecord(projectId);
          const fenced = fenceRecord(
            current,
            {
              environmentId: EnvironmentId.make("env-mini"),
              machineLabel: "Mini",
              threadId: ThreadId.make("thread-on-mini"),
              at: "2026-10-20T19:00:00.000Z",
            },
            "handoff",
          );
          const next = { ...document, threads: { ...document.threads, [threadId]: fenced } };
          return [null, next] as const;
        });

        const fence = yield* handoff.fence(threadId, "run-1");
        expect(fence.kind).toBe("fenced");
        expect(yield* handoff.guardSideEffect(sideEffect("run-1"))).toMatchObject({
          kind: "refuse",
        });
        expect(
          yield* handoff.guardSideEffect({ ...sideEffect("run-1"), target: "anton/app#other" }),
        ).toMatchObject({ kind: "refuse" });

        yield* handoff.observeRun(run("run-2", "running"));
        expect(yield* handoff.fence(threadId, "run-2")).toMatchObject({ kind: "fenced" });

        fixture.runStatus = "interrupted";
        fixture.activeRunId = null;
        expect(yield* handoff.checkpoint(threadId, "turn-end")).toBeNull();
        const failure = yield* handoff.checkpoint(threadId, "manual").pipe(Effect.flip);
        expect(failure.code).toBe("fenced");
      }).pipe(Effect.provide(layerFor(repository(), fixture)));
    },
  );

  it.effect("refuses side effects mid-transfer but lets the handoff checkpoint and journal", () => {
    const fixture: Fixture = { runStatus: "running", activeRunId: "run-1", latestRunId: "run-1" };
    return Effect.gen(function* () {
      const handoff = yield* HandoffMode.HandoffMode;
      const store = yield* HandoffModeStore.HandoffModeStore;
      yield* handoff.updateConfig({ pushToOrigin: false });
      yield* handoff.setProjectMode({ projectId, mode: "on" });
      yield* handoff.observeRun(run("run-1", "running"));
      const setLeaseState = (state: "active" | "handing-off") =>
        store.update((document) => {
          const current = document.threads[threadId]!;
          const next = {
            ...document,
            threads: {
              ...document.threads,
              [threadId]: { ...current, lease: { ...current.lease!, state } },
            },
          };
          return [null, next] as const;
        });
      yield* setLeaseState("handing-off");

      const fence = yield* handoff.fence(threadId, "run-1");
      expect(fence).toMatchObject({ kind: "fenced" });
      expect(fence.kind === "fenced" && fence.message).toContain("being handed off");
      expect(yield* handoff.guardSideEffect(sideEffect("run-1"))).toMatchObject({
        kind: "refuse",
      });
      // The handoff's own steps still run: what already happened is journaled and the
      // checkpoint the destination takes over is written.
      yield* handoff.recordSideEffect({ ...sideEffect("run-1"), result: "#12" });
      fixture.runStatus = "interrupted";
      fixture.activeRunId = null;
      const checkpoint = yield* handoff.checkpoint(threadId, "handoff");
      expect(checkpoint?.sideEffects).toHaveLength(1);

      // A move that definitely did not happen gives the thread back.
      yield* setLeaseState("active");
      expect(yield* handoff.fence(threadId, "run-1")).toEqual({ kind: "ok", epoch: 1 });
    }).pipe(Effect.provide(layerFor(repository(), fixture)));
  });

  it.effect("keeps a handoff-stopped run's ending but clears it for a later run", () => {
    const fixture: Fixture = { runStatus: "running", activeRunId: "run-1", latestRunId: "run-1" };
    return Effect.gen(function* () {
      const handoff = yield* HandoffMode.HandoffMode;
      const store = yield* HandoffModeStore.HandoffModeStore;
      yield* handoff.updateConfig({ pushToOrigin: false });
      yield* handoff.setProjectMode({ projectId, mode: "on" });
      yield* handoff.observeRun(run("run-1", "running"));
      // A handoff stopped run-1 and then failed, so the lease is active again.
      yield* store.update((document) => {
        const current = document.threads[threadId]!;
        const next = {
          ...document,
          threads: {
            ...document.threads,
            [threadId]: { ...current, fencedBy: "handoff" as const },
          },
        };
        return [null, next] as const;
      });
      const fencedBy = Effect.map(store.read, (document) => document.threads[threadId]?.fencedBy);

      // A later update of the same run keeps the marker, so a retry resumes that turn.
      yield* handoff.observeRun(run("run-1", "running"));
      expect(yield* fencedBy).toBe("handoff");

      // A new run is not the one the handoff stopped.
      fixture.activeRunId = "run-2";
      fixture.latestRunId = "run-2";
      yield* handoff.observeRun(run("run-2", "running"));
      expect(yield* fencedBy).toBeNull();
    }).pipe(Effect.provide(layerFor(repository(), fixture)));
  });

  it.effect("keeps lease and journal across a restart of the service", () => {
    const fixture: Fixture = { runStatus: "running", activeRunId: "run-1", latestRunId: "run-1" };
    const root = repository();
    return Effect.gen(function* () {
      const handoff = yield* HandoffMode.HandoffMode;
      yield* handoff.setProjectMode({ projectId, mode: "on" });
      yield* handoff.observeRun(run("run-1", "running"));
      yield* handoff.recordSideEffect({ ...sideEffect("run-1"), result: "#12" });

      const restarted = yield* HandoffMode.make.pipe(Effect.provide(HandoffModeStore.layer));
      expect(yield* restarted.fence(threadId, "run-1")).toEqual({ kind: "ok", epoch: 1 });
      expect(yield* restarted.guardSideEffect(sideEffect("run-1"))).toMatchObject({
        kind: "reuse",
        effect: { result: "#12" },
      });
    }).pipe(Effect.provide(layerFor(root, fixture)));
  });

  it.effect(
    "checkpoints before Claude launches a subagent, once per launch, only in handoff mode",
    () => {
      const fixture: Fixture = { runStatus: "running", activeRunId: "run-1", latestRunId: "run-1" };
      const root = repository();
      return Effect.gen(function* () {
        const handoff = yield* HandoffMode.HandoffMode;
        const launches = yield* SubagentLaunchCheckpoints.SubagentLaunchCheckpoints;
        yield* launches.serve(launchCheckpoint(handoff));
        const hooks = makeSubagentLaunchHooks(launches.checkpoint)(threadId, undefined);
        const agentLaunch = (toolUseId: string) =>
          Effect.promise(() =>
            hooks.PreToolUse![0]!.hooks[0]!(
              {
                hook_event_name: "PreToolUse",
                tool_name: "Agent",
                tool_use_id: toolUseId,
              } as never,
              toolUseId,
              { signal: new AbortController().signal },
            ),
          );
        const checkpoints = handoff.snapshot.pipe(
          Effect.map((snapshot) => snapshot.threads.flatMap((thread) => thread.checkpoint ?? [])),
        );
        yield* handoff.updateConfig({ pushToOrigin: false });

        // Handoff mode off: the launch goes ahead and nothing is written.
        expect(yield* agentLaunch("toolu_off")).toEqual({});
        expect(yield* checkpoints).toEqual([]);

        yield* handoff.setProjectMode({ projectId, mode: "on" });
        expect(yield* agentLaunch("toolu_on")).toEqual({});
        // Written by the time the hook lets the Agent tool run.
        expect(yield* checkpoints).toMatchObject([{ sequence: 1, reason: "interval" }]);
        NodeFS.writeFileSync(NodePath.join(root, "app.ts"), "export const a = 3;\n");
        yield* agentLaunch("toolu_on");
        expect((yield* checkpoints)[0]?.sequence).toBe(1);
        yield* agentLaunch("toolu_next");
        expect((yield* checkpoints)[0]?.sequence).toBe(2);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(layerFor(root, fixture), SubagentLaunchCheckpoints.layer)),
      );
    },
  );

  it.effect("shares one launch-checkpoint server between the adapters and handoff mode", () =>
    Effect.gen(function* () {
      const served: Array<string> = [];
      const reader = (label: string) =>
        Layer.effectDiscard(
          Effect.gen(function* () {
            const launches = yield* SubagentLaunchCheckpoints.SubagentLaunchCheckpoints;
            if (label === "reactor")
              yield* launches.serve((id) => Effect.sync(() => served.push(id)));
            else yield* launches.checkpoint(threadId);
          }),
        ).pipe(Layer.provide(SubagentLaunchCheckpoints.layer));
      yield* Layer.build(
        Layer.mergeAll(reader("reactor"), Layer.unwrap(Effect.succeed(reader("adapter")))),
      );
      expect(served).toEqual([threadId]);
    }).pipe(Effect.scoped),
  );
});
