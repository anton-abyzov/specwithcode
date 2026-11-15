import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRequestKind,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import { resolveSelfInvocation } from "@specweave-studio/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import * as AcpSessionRuntime from "../../provider/acp/AcpSessionRuntime.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  AcpProviderCapabilitiesV2,
  type AcpAdapterV2RuntimeInput,
  makeAcpAdapterV2,
} from "./AcpAdapterV2.ts";

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "studio-acp-execute-grant-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
type PermissionHandler = Parameters<RuntimeService["handleRequestPermission"]>[0];
type TerminalHandler = Parameters<RuntimeService["handleCreateTerminal"]>[0];

interface GrantCase {
  readonly label: string;
  /** The ACP tool kind on the permission request; undefined sends none. */
  readonly toolKind: string | undefined;
  readonly decision: ProviderApprovalDecision;
  /**
   * The request kind the approval card shows, unchanged by the grant rule, or
   * null when the thread policy answers the request without a card.
   */
  readonly cardKind: ProviderRequestKind | null;
  readonly terminalAllowed: boolean;
}

const cases: ReadonlyArray<GrantCase> = [
  {
    label: "an approved execute request",
    toolKind: "execute",
    decision: "accept",
    cardKind: "command",
    terminalAllowed: true,
  },
  {
    label: "an execute request approved for the session",
    toolKind: "execute",
    decision: "acceptForSession",
    cardKind: "command",
    terminalAllowed: true,
  },
  {
    label: "a declined execute request",
    toolKind: "execute",
    decision: "decline",
    cardKind: "command",
    terminalAllowed: false,
  },
  {
    label: "a cancelled execute request",
    toolKind: "execute",
    decision: "cancel",
    cardKind: "command",
    terminalAllowed: false,
  },
  ...(
    [
      // Reads are allowed by the thread policy without a card.
      ["read", null],
      ["search", null],
      ["think", null],
      ["fetch", "file-read"],
      ["edit", "file-change"],
      ["delete", "file-change"],
      ["move", "file-change"],
      ["switch_mode", "command"],
      ["other", "command"],
      ["browse", "command"],
      [undefined, "command"],
    ] as const
  ).flatMap(([toolKind, cardKind]): ReadonlyArray<GrantCase> =>
    (["accept", "acceptForSession"] as const).map((decision) => ({
      label: `a ${toolKind ?? "kindless"} request answered ${decision}`,
      toolKind,
      decision,
      cardKind,
      terminalAllowed: false,
    })),
  ),
];

/**
 * Opens an approval-required session, raises one permission request of the
 * case's kind, answers it, then asks for a client terminal in the same turn.
 */
const runCase = (testCase: GrantCase, index: number) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    let requestPermission: PermissionHandler | undefined;
    let createTerminal: TerminalHandler | undefined;
    let runtimeInput: AcpAdapterV2RuntimeInput | undefined;
    const instanceId = ProviderInstanceId.make(`acp-execute-grant-${index}`);
    const threadId = ThreadId.make(`thread-acp-execute-grant-${index}`);
    const adapter = makeAcpAdapterV2({
      crypto: yield* Crypto.Crypto,
      instanceId,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
      selfInvocation: yield* resolveSelfInvocation(),
      clientTerminals: { childProcessSpawner },
      flavor: {
        driver: ProviderDriverKind.make("acp-test"),
        capabilities: AcpProviderCapabilitiesV2,
        interruptPromptOnCancel: true,
        makeRuntime: (input) =>
          Effect.gen(function* () {
            runtimeInput = input;
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({
                ...input,
                spawn: {
                  command: process.execPath,
                  args: [mockAgentPath],
                  cwd: input.cwd,
                  env: { STUDIO_ACP_SESSION_LIFECYCLE: "1", STUDIO_ACP_HANG_PROMPT_FOREVER: "1" },
                },
                authMethodId: "test",
              }).pipe(
                Layer.provide(
                  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                ),
              ),
            );
            const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
              Effect.provide(context),
            );
            return {
              ...runtime,
              handleRequestPermission: (handler) =>
                Effect.sync(() => {
                  requestPermission = handler;
                }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
              handleCreateTerminal: (handler) =>
                Effect.sync(() => {
                  createTerminal = handler;
                }).pipe(Effect.andThen(runtime.handleCreateTerminal(handler))),
            } satisfies RuntimeService;
          }),
      },
    });
    const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "approval-required",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-acp-execute-grant-${index}`),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;
    const suffix = `${threadId}:1`;
    const turnFiber = yield* runtime
      .startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make(`project:${threadId}`),
          title: "ACP execute grant",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make(`run:${suffix}`),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make(`attempt:${suffix}`),
        rootNodeId: NodeId.make(`node:${suffix}`),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make(`message:${suffix}`),
          text: "Check the repository.",
          attachments: [],
        },
        modelSelection,
        runtimePolicy,
      })
      .pipe(Effect.forkScoped);
    if (requestPermission === undefined || createTerminal === undefined) {
      return yield* Effect.die("ACP runtime must register permission and terminal handlers");
    }

    const permissionFiber = yield* requestPermission(
      {
        sessionId: "mock-session-1",
        toolCall: {
          toolCallId: "grant-tool-call",
          title: "git status",
          ...(testCase.toolKind === undefined ? {} : { kind: testCase.toolKind }),
        },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
      { requestId: "grant-permission-request", method: "session/request_permission" },
    ).pipe(Effect.forkScoped);
    if (testCase.cardKind === null) {
      const answer = yield* Fiber.join(permissionFiber);
      if (runtimeInput?.onOutgoingResponse === undefined) {
        return yield* Effect.die("ACP runtime must expose native response acknowledgements");
      }
      yield* runtimeInput.onOutgoingResponse("grant-permission-request");
      const terminalExit = yield* createTerminal(
        {
          sessionId: "mock-session-1",
          command: process.execPath,
          args: ["-e", "process.stdout.write('terminal ran')"],
        },
        { requestId: "grant-terminal-create", method: "terminal/create" },
      ).pipe(Effect.exit);
      const providerTurn = Option.getOrThrow(
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "provider_turn.updated"),
          Stream.runHead,
        ),
      );
      if (providerTurn.type !== "provider_turn.updated") {
        return yield* Effect.die("Expected the running provider turn");
      }
      console.error('DBG turn', providerTurn.providerTurn.id, providerTurn.providerTurn.status);
      assert.equal(answer.outcome.outcome, "selected");
      yield* runtime.interruptTurn({ providerThread, providerTurnId: providerTurn.providerTurn.id });
      console.error('DBG interrupted');
      yield* Fiber.join(turnFiber);
      return { cardKind: null, terminalAllowed: Exit.isSuccess(terminalExit) };
    }
    const pending = Option.getOrThrow(
      yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        ),
        Stream.runHead,
      ),
    );
    if (
      pending.type !== "runtime_request.updated" ||
      pending.runtimeRequest.providerTurnId === null
    ) {
      return yield* Effect.die("Expected a pending ACP permission request");
    }
    const responseFiber = yield* runtime
      .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: testCase.decision })
      .pipe(Effect.forkScoped);
    yield* Fiber.join(permissionFiber);
    if (runtimeInput?.onOutgoingResponse === undefined) {
      return yield* Effect.die("ACP runtime must expose native response acknowledgements");
    }
    yield* runtimeInput.onOutgoingResponse("grant-permission-request");
    yield* Fiber.join(responseFiber);

    const terminalExit = yield* createTerminal(
      {
        sessionId: "mock-session-1",
        command: process.execPath,
        args: ["-e", "process.stdout.write('terminal ran')"],
      },
      { requestId: "grant-terminal-create", method: "terminal/create" },
    ).pipe(Effect.exit);

    yield* runtime.interruptTurn({
      providerThread,
      providerTurnId: pending.runtimeRequest.providerTurnId,
    });
    yield* Fiber.join(turnFiber);
    return { cardKind: pending.runtimeRequest.kind, terminalAllowed: Exit.isSuccess(terminalExit) };
  });

describe("AcpAdapterV2 client terminal grants", () => {
  it.effect.each(cases.map((testCase, index) => ({ ...testCase, index })))(
    "$label: terminal allowed is $terminalAllowed",
    ({ index, ...testCase }) =>
      Effect.gen(function* () {
        const result = yield* runCase(testCase, index);
        assert.deepEqual(result, {
          cardKind: testCase.cardKind,
          terminalAllowed: testCase.terminalAllowed,
        });
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
