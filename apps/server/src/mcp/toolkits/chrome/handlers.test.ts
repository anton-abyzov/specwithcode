// @effect-diagnostics globalDate:off -- drives the chrome_* handlers with a fake extension and a fake fleet.
import {
  type ChromePeerInput,
  type ChromeToolName,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type OrchestratorMcpMachineRef,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";

import * as BrowserExtension from "../../../browserExtension/BrowserExtension.ts";
import { ChromeTools } from "../../../browserExtension/chromeTools.ts";
import { connectFake, setup } from "../../../browserExtension/fakeChrome.testkit.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as RemoteWorkers from "../../../fleet/RemoteWorkers.ts";
import { workerClientName } from "../../../fleet/workerGrantMint.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { runChromePeer, runChromeTool } from "./handlers.ts";

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");
const B: OrchestratorMcpMachineRef = { id: "b", label: "Studio B", environmentId: ENV_B };

const threadScope = (threadId: string): McpInvocationContext.McpInvocationScope => ({
  environmentId: ENV_A,
  capabilities: new Set(["preview", "orchestration"]),
  issuedAt: 0,
  requestNamespace: `thread:${threadId}`,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: "session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
});

const peerScope = (label: string, access: "auto" | "read-only" = "auto") =>
  ({
    environmentId: ENV_B,
    capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
    issuedAt: 0,
    requestNamespace: "client:grant",
    thread: undefined,
    client: { sessionId: "grant", label, access },
  }) as McpInvocationContext.McpInvocationScope;

const environment = (environmentId: EnvironmentId, label: string) =>
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.succeed({
      environmentId,
      label,
    } as unknown as ExecutionEnvironmentDescriptor),
  });

const threads = Layer.succeed(ThreadManagementService.ThreadManagementService, {
  getThreadShell: (threadId: ThreadId) =>
    Effect.succeed({ id: threadId, title: `Title of ${threadId}`, deletedAt: null }),
} as unknown as ThreadManagementService.ThreadManagementService["Service"]);

/**
 * Machine B: its own Chrome, reached only through chrome_peer as B's MCP
 * server runs it for A's worker grant.
 */
/** The owner of B allows A's grant (session "grant") in Settings › Chrome. */
const allowGrant = (extension: BrowserExtension.BrowserExtensionShape) => {
  extension.peerAccess({ id: "grant", machine: "Studio A", label: "x", environmentId: "env-a" });
  return extension.answerPeer("grant", true);
};

function machineB(allowed = true) {
  const { extension, token } = setup();
  const chrome = connectFake(extension, token, "Work");
  if (allowed) void allowGrant(extension);
  const layer = Layer.mergeAll(
    Layer.succeed(BrowserExtension.BrowserExtension, extension),
    Layer.succeed(McpInvocationContext.McpInvocationContext, peerScope(workerClientName(ENV_A))),
    environment(ENV_B, "Studio B"),
    threads,
  );
  const calls: Array<{ readonly tool: string; readonly arguments: Record<string, unknown> }> = [];
  const answer = (args: Record<string, unknown>) =>
    runChromePeer(args as ChromePeerInput).pipe(Effect.provide(layer));
  return { extension, chrome, calls, answer };
}

/** Machine A: no Chrome of its own, with B in its fleet. */
function machineA(b: ReturnType<typeof machineB> | null, ownChrome = false) {
  const { extension, token } = setup();
  if (ownChrome) connectFake(extension, token, "Home");
  const fleet = {
    enabled: true,
    resolveMachine: (target: string | undefined) =>
      target === undefined || target === "local"
        ? Effect.succeed({ kind: "local" as const })
        : target === "b"
          ? Effect.succeed({ kind: "remote" as const, machine: B })
          : Effect.fail(
              new OrchestratorMcpFailure({ code: "unknown_machine", message: `No ${target}` }),
            ),
    listMachines: () =>
      Effect.succeed({
        local: { id: "local", label: "Studio A", environmentId: ENV_A },
        machines: b === null ? [] : [{ ...B, status: "ready", access: "auto" }],
        projectWorkerMachine: null,
      }),
    proxy: (input: { tool: string; arguments: Record<string, unknown> }) =>
      Effect.suspend(() => {
        b!.calls.push(input);
        return b!.answer(input.arguments).pipe(
          Effect.map((answer) => ({ ...answer, machine: B })),
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: `Studio B: ${error.reason}`,
              }),
          ),
        );
      }),
  } as unknown as RemoteWorkers.RemoteWorkersShape;
  const as = (threadId: string) =>
    Layer.mergeAll(
      Layer.succeed(BrowserExtension.BrowserExtension, extension),
      Layer.succeed(RemoteWorkers.RemoteWorkers, fleet),
      Layer.succeed(McpInvocationContext.McpInvocationContext, threadScope(threadId)),
      environment(ENV_A, "Studio A"),
      threads,
    );
  const call = <N extends ChromeToolName>(
    threadId: string,
    tool: N,
    input: Record<string, unknown> = {},
  ) => runChromeTool(tool, input).pipe(Effect.provide(as(threadId)));
  const exit = <N extends ChromeToolName>(
    threadId: string,
    tool: N,
    input: Record<string, unknown> = {},
  ) => Effect.exit(call(threadId, tool, input));
  return { extension, call, exit };
}

describe("Chrome on another machine", () => {
  it.effect("uses the connected machine's Chrome when none is paired here", () =>
    Effect.gen(function* () {
      const b = machineB();
      const a = machineA(b);
      const listed = yield* a.call("t1", "chrome_profiles");
      expect(listed.profiles).toEqual([expect.objectContaining({ name: "Work", machine: "b" })]);
      expect(listed.hint).toContain("Studio B");

      const opened = yield* a.call("t1", "chrome_open", { url: "https://example.com/" });
      expect(opened.profile).toBe("Work");
      // The call carried the thread and its title, never the machine parameter.
      const sent = b.calls.at(-1)!.arguments as { input: object; caller: object };
      expect(sent.input).toEqual({ url: "https://example.com/" });
      expect(sent.caller).toEqual({
        environmentId: "env-a",
        machine: "Studio A",
        threadId: "t1",
        title: "Title of t1",
      });

      // B's Settings › Chrome shows the thread by title and machine.
      const [profile] = b.extension.status().profiles;
      expect(profile!.threads).toEqual([
        expect.objectContaining({ title: "Title of t1", machine: "Studio A", tabs: 1 }),
      ]);
      expect(b.extension.status().recentActions[0]).toMatchObject({
        tool: "chrome_open",
        title: "Title of t1",
        machine: "Studio A",
      });
    }),
  );

  it.effect("keeps threads from another machine in their own tabs, apart from B's threads", () =>
    Effect.gen(function* () {
      const b = machineB();
      const a = machineA(b);
      const first = yield* a.call("t1", "chrome_open", { url: "https://a.example/" });
      yield* a.call("t2", "chrome_open", { url: "https://b.example/" });
      const stolen = yield* a.exit("t2", "chrome_snapshot", { tabId: first.tabId });
      expect(Exit.isFailure(stolen)).toBe(true);
      expect(JSON.stringify(stolen)).toContain("belongs to another SpecWithCode thread");
      // A thread on B with the same id is still another thread.
      const tabs = yield* a.call("t1", "chrome_tabs");
      expect(tabs.tabs.find((tab) => tab.tabId === first.tabId)?.thisThread).toBe(true);
      expect(b.extension.status().profiles[0]!.threads).toHaveLength(2);
      const local = new ChromeTools(b.extension.hub);
      const onB = yield* Effect.tryPromise(() => local.snapshot("t1", { tabId: first.tabId })).pipe(
        Effect.flip,
      );
      expect(String(onB.cause)).toMatch(/another/);
    }),
  );

  it.effect("prefers this machine's own Chrome, and goes to another only when named", () =>
    Effect.gen(function* () {
      const b = machineB();
      const a = machineA(b, true);
      const here = yield* a.call("t1", "chrome_open", { url: "https://example.com/" });
      expect(here.profile).toBe("Home");
      expect(b.calls).toHaveLength(0);
      const there = yield* a.call("t1", "chrome_open", {
        url: "https://example.com/",
        machine: "b",
      });
      expect(there.profile).toBe("Work");
      const listed = yield* a.call("t1", "chrome_profiles");
      expect(listed.profiles.map((profile) => [profile.name, profile.machine])).toEqual([
        ["Home", undefined],
        ["Work", "b"],
      ]);
    }),
  );

  it.effect("says it is not connected when no machine has Chrome", () =>
    Effect.gen(function* () {
      const a = machineA(null);
      const result = yield* a.exit("t1", "chrome_open", { url: "https://example.com/" });
      expect(JSON.stringify(result)).toContain("not_connected");
      const unknown = yield* a.exit("t1", "chrome_tabs", { machine: "nope" });
      expect(JSON.stringify(unknown)).toContain("invalid_request");
    }),
  );
});

describe("chrome_peer", () => {
  const call = (scope: McpInvocationContext.McpInvocationScope, environmentId = "env-a") => {
    const { extension, token } = setup();
    connectFake(extension, token, "Work");
    void allowGrant(extension);
    return Effect.exit(
      runChromePeer({
        action: "chrome_profiles",
        input: {},
        caller: { environmentId, machine: "Studio A", threadId: "t1", title: "T" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(BrowserExtension.BrowserExtension, extension),
            Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
          ),
        ),
      ),
    );
  };

  it.effect("answers the worker grant of the machine the caller names", () =>
    Effect.gen(function* () {
      expect(Exit.isSuccess(yield* call(peerScope(workerClientName(ENV_A))))).toBe(true);
    }),
  );

  it.effect("refuses agents, read-only clients and a grant naming another machine", () =>
    Effect.gen(function* () {
      for (const exit of [
        yield* call(threadScope("t1")),
        yield* call(peerScope(workerClientName(ENV_A), "read-only")),
        yield* call(peerScope("Claude Code")),
        yield* call(peerScope(workerClientName(ENV_A)), "env-c"),
      ]) {
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("chrome_peer is for other SpecWithCode machines");
      }
    }),
  );

  it.effect("waits for the owner here to allow a machine, and a decline lets go of its tabs", () =>
    Effect.gen(function* () {
      const b = machineB(false);
      const a = machineA(b);
      // A thread id no other test used, so no machine is remembered for it.
      const first = yield* a.exit("t-approval", "chrome_open", { url: "https://example.com/" });
      expect(JSON.stringify(first)).toContain("waits for the owner to allow this machine");
      expect(b.extension.status().peers).toEqual([
        expect.objectContaining({ id: "grant", machine: "Studio A", state: "pending" }),
      ]);
      // Nothing ran in B's Chrome.
      expect(b.chrome.calls.some((call) => call.method === "chrome.tabs.create")).toBe(false);

      yield* Effect.promise(() => b.extension.answerPeer("grant", true));
      const opened = yield* a.call("t-approval", "chrome_open", { url: "https://example.com/" });
      expect(opened.profile).toBe("Work");
      expect(b.extension.status().profiles[0]!.threads).toHaveLength(1);

      yield* Effect.promise(() => b.extension.answerPeer("grant", false));
      expect(b.extension.status().profiles[0]!.threads ?? []).toHaveLength(0);
      // Idle tabs and the remembered last tab are let go too.
      const profile = b.extension.hub.profiles()[0]!;
      expect([...profile.tabOwners.values()].map((owner) => owner.threadId)).toEqual([]);
      expect([...profile.lastTabByThread.keys()]).toEqual([]);
      const declined = yield* a.exit("t-approval", "chrome_tabs");
      expect(JSON.stringify(declined)).toContain("declined");
    }),
  );

  it.effect("tells the agent to ask for Allow when the only machine with Chrome waits for it", () =>
    Effect.gen(function* () {
      const a = machineA(machineB(false));
      const listed = yield* a.call("t-ask-profiles", "chrome_profiles");
      expect(listed.profiles).toEqual([]);
      expect(listed.hint).toContain("waits for the owner to allow this machine");
    }),
  );

  it.effect("does not replay a tab action on another machine after it failed", () =>
    Effect.gen(function* () {
      const b = machineB();
      const a = machineA(b);
      const opened = yield* a.call("t-replay", "chrome_open", { url: "https://example.com/" });
      const before = b.calls.length;
      const failed = yield* a.exit("t-replay", "chrome_snapshot", { tabId: opened.tabId + 999 });
      expect(Exit.isFailure(failed)).toBe(true);
      // One call, no fresh look for another machine.
      expect(b.calls.slice(before).map((call) => call.arguments.action)).toEqual([
        "chrome_snapshot",
      ]);
    }),
  );

  it.effect("lets go of an allowed machine's tabs when it is forgotten to make room", () =>
    Effect.gen(function* () {
      const b = machineB();
      const a = machineA(b);
      yield* a.call("t-evict", "chrome_open", { url: "https://example.com/" });
      for (let index = 0; index < 50; index += 1) {
        b.extension.peerAccess({
          id: `other-${index}`,
          machine: "M",
          label: "x",
          environmentId: `env-${index}`,
        });
        yield* Effect.promise(() => b.extension.answerPeer(`other-${index}`, true));
      }
      expect(b.extension.peerState("grant")).toBeUndefined();
      const profile = b.extension.hub.profiles()[0]!;
      expect([...profile.tabOwners.values()].map((owner) => owner.threadId)).toEqual([]);
    }),
  );
});
