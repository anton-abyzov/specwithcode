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
import * as EffectAcpErrors from "@specweave-studio/effect-acp/errors";
import { resolveSelfInvocation } from "@specweave-studio/shared/nodeRuntime";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
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
type PermissionRequest = Parameters<PermissionHandler>[0];
type PermissionOption = PermissionRequest["options"][number];
type TerminalHandler = Parameters<RuntimeService["handleCreateTerminal"]>[0];
type SessionUpdateHandler = Parameters<RuntimeService["handleSessionUpdate"]>[0];
type AdapterTestHooks = NonNullable<Parameters<typeof makeAcpAdapterV2>[0]["testHooks"]>;

/** The handlers and input of one agent runtime the session started. */
interface StartedRuntime {
  readonly input: AcpAdapterV2RuntimeInput;
  requestPermission: PermissionHandler | undefined;
  createTerminal: TerminalHandler | undefined;
  sessionUpdate: SessionUpdateHandler | undefined;
}

const PERMISSION_REQUEST_ID = "grant-permission-request";
const SESSION_ID = "mock-session-1";

const allowOnce = { optionId: "allow-once", name: "Allow once", kind: "allow_once" } as const;
const allowAlways = {
  optionId: "allow-always",
  name: "Always allow",
  kind: "allow_always",
} as const;
const rejectOnce = { optionId: "reject-once", name: "Reject", kind: "reject_once" } as const;

/**
 * Opens an approval-required session against the mock agent. Every runtime
 * the session starts, including restarts, is recorded with its handlers.
 */
const openGrantSession = (
  name: string,
  options: {
    readonly testHooks?: AdapterTestHooks;
    readonly sessionScope?: Scope.Scope;
    /** Replaces the mock agent's environment. */
    readonly agentEnvironment?: Readonly<Record<string, string>>;
    readonly onUrlElicitation?: (input: {
      readonly elicitationId: string;
      readonly url: string;
      readonly message: string;
    }) => Effect.Effect<boolean>;
    /**
     * Replaces runtime 1's prompt: it reports `started`, then fails as an
     * ended agent process once `fail` completes.
     */
    readonly firstPrompt?: {
      readonly started: Deferred.Deferred<void>;
      readonly fail: Deferred.Deferred<void>;
    };
  } = {},
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const runtimes: Array<StartedRuntime> = [];
    // Completed once the runtime at that index has its terminal handler wired.
    const terminalsWired: Array<Deferred.Deferred<StartedRuntime>> = [];
    const terminalsWiredAt = (index: number) => {
      while (terminalsWired.length <= index)
        terminalsWired.push(Deferred.makeUnsafe<StartedRuntime>());
      return terminalsWired[index] as Deferred.Deferred<StartedRuntime>;
    };
    const instanceId = ProviderInstanceId.make(`acp-execute-grant-${name}`);
    const threadId = ThreadId.make(`thread-acp-execute-grant-${name}`);
    const adapter = makeAcpAdapterV2({
      crypto: yield* Crypto.Crypto,
      instanceId,
      fileSystem: yield* FileSystem.FileSystem,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      serverConfig: yield* ServerConfig.ServerConfig,
      selfInvocation: yield* resolveSelfInvocation(),
      clientTerminals: { childProcessSpawner },
      ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
      flavor: {
        driver: ProviderDriverKind.make("acp-test"),
        capabilities: AcpProviderCapabilitiesV2,
        interruptPromptOnCancel: true,
        ...(options.onUrlElicitation === undefined
          ? {}
          : { onUrlElicitation: options.onUrlElicitation }),
        makeRuntime: (input) =>
          Effect.gen(function* () {
            const started: StartedRuntime = {
              input,
              requestPermission: undefined,
              createTerminal: undefined,
              sessionUpdate: undefined,
            };
            const index = runtimes.push(started) - 1;
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({
                ...input,
                spawn: {
                  command: process.execPath,
                  args: [mockAgentPath],
                  cwd: input.cwd,
                  env: options.agentEnvironment ?? {
                    STUDIO_ACP_SESSION_LIFECYCLE: "1",
                    STUDIO_ACP_HANG_PROMPT_FOREVER: "1",
                  },
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
            const firstPrompt = index === 0 ? options.firstPrompt : undefined;
            return {
              ...runtime,
              ...(firstPrompt === undefined
                ? {}
                : {
                    prompt: () =>
                      Deferred.succeed(firstPrompt.started, undefined).pipe(
                        Effect.andThen(Deferred.await(firstPrompt.fail)),
                        Effect.andThen(
                          Effect.fail(
                            new EffectAcpErrors.AcpTransportError({
                              detail: "The agent process ended",
                              cause: "Agent process exited",
                            }),
                          ),
                        ),
                      ),
                  }),
              handleRequestPermission: (handler) =>
                Effect.sync(() => {
                  started.requestPermission = handler;
                }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
              handleCreateTerminal: (handler) =>
                Effect.sync(() => {
                  started.createTerminal = handler;
                }).pipe(
                  Effect.andThen(runtime.handleCreateTerminal(handler)),
                  Effect.andThen(Deferred.succeed(terminalsWiredAt(index), started)),
                  Effect.asVoid,
                ),
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  started.sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
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
    const openSession = adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-acp-execute-grant-${name}`),
      modelSelection,
      runtimePolicy,
    });
    const runtime = yield* options.sessionScope === undefined
      ? openSession
      : openSession.pipe(Effect.provideService(Scope.Scope, options.sessionScope));
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const now = yield* DateTime.now;

    const startTurn = (ordinal: number) => {
      const suffix = `${threadId}:${ordinal}`;
      return runtime.startTurn({
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
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
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
      });
    };

    const latestRuntime = Effect.suspend(() => {
      const latest = runtimes.at(-1);
      return latest === undefined
        ? Effect.die("No ACP runtime was started")
        : Effect.succeed(latest);
    });

    /** Raises one permission request on the latest runtime, forked. */
    const raisePermission = (
      toolCall: PermissionRequest["toolCall"],
      offered: ReadonlyArray<PermissionOption>,
    ) =>
      Effect.gen(function* () {
        const handler = (yield* latestRuntime).requestPermission;
        if (handler === undefined) {
          return yield* Effect.die("ACP runtime must register a permission handler");
        }
        return yield* handler(
          { sessionId: SESSION_ID, toolCall, options: [...offered] },
          { requestId: PERMISSION_REQUEST_ID, method: "session/request_permission" },
        ).pipe(Effect.forkScoped);
      });

    const awaitPendingRequest = Effect.gen(function* () {
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
      return { ...pending.runtimeRequest, providerTurnId: pending.runtimeRequest.providerTurnId };
    });

    /** Waits until a turn is running, so its tool calls are tracked. */
    const awaitTurnRunning = runtime.events.pipe(
      Stream.filter(
        (event) =>
          event.type === "provider_turn.updated" && event.providerTurn.status === "running",
      ),
      Stream.runHead,
    );

    /**
     * Asks a runtime's terminal handler for a client terminal: "denied" means
     * the policy refused it for want of an approval.
     */
    const terminalOutcome = (started: StartedRuntime, requestId: string) =>
      Effect.gen(function* () {
        const handler = started.createTerminal;
        if (handler === undefined) {
          return yield* Effect.die("ACP runtime must register a terminal handler");
        }
        const exit = yield* handler(
          {
            sessionId: SESSION_ID,
            command: process.execPath,
            args: ["-e", "process.stdout.write('terminal ran')"],
          },
          { requestId, method: "terminal/create" },
        ).pipe(Effect.exit);
        if (Exit.isSuccess(exit)) return "allowed" as const;
        return Cause.pretty(exit.cause).includes("requires approval for terminal/create")
          ? ("denied" as const)
          : ("failed" as const);
      });

    /** Waits, bounded, until the session has wired runtime `count`'s terminals. */
    const awaitRuntime = (count: number) =>
      Deferred.await(terminalsWiredAt(count - 1)).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.die(`The session never started runtime ${count}`),
        }),
      );

    return {
      runtime,
      providerThread,
      runtimes,
      awaitRuntime,
      startTurn,
      latestRuntime,
      raisePermission,
      awaitPendingRequest,
      awaitTurnRunning,
      terminalOutcome,
    };
  });

interface GrantCase {
  readonly label: string;
  /** The ACP tool kind on the permission request; undefined sends none. */
  readonly toolKind: string | undefined;
  readonly decision: ProviderApprovalDecision;
  /**
   * The options the agent offers. "allow-once-only" makes Always allow approve
   * once; "reject-only" leaves an approval nothing to select, so it is cancelled.
   */
  readonly offered?: "allow-once-only" | "reject-only" | ReadonlyArray<PermissionOption>;
  /** The person never answers the request. */
  readonly unanswered?: true;
  /** The request names its tool call by this ID instead of the default one. */
  readonly toolCallId?: string;
  /** A tool call the agent reported in this turn before it asked for permission. */
  readonly trackedToolCall?: { readonly toolCallId: string; readonly kind: string };
  /** The request kind the approval card shows, unchanged by the grant rule. */
  readonly cardKind: ProviderRequestKind;
  /** The answer sent to the agent, when the case pins it. */
  readonly sentOptionId?: string | null;
  /** A client terminal requested in the approving turn. */
  readonly terminalAllowed: boolean;
  /** A client terminal requested after that turn ended. */
  readonly terminalAllowedAfterTurn: boolean;
}

const offeredOptions = (offered: GrantCase["offered"]): ReadonlyArray<PermissionOption> => {
  if (offered === "reject-only") return [rejectOnce];
  if (offered === "allow-once-only") return [allowOnce, rejectOnce];
  return offered ?? [allowOnce, allowAlways, rejectOnce];
};

const cases: ReadonlyArray<GrantCase> = [
  {
    label: "an approved execute request",
    toolKind: "execute",
    decision: "accept",
    cardKind: "command",
    terminalAllowed: true,
    terminalAllowedAfterTurn: false,
  },
  {
    label: "an execute request approved for the session",
    toolKind: "execute",
    decision: "acceptForSession",
    cardKind: "command",
    terminalAllowed: true,
    terminalAllowedAfterTurn: true,
  },
  {
    label: "an execute request answered Always allow with only allow-once offered",
    toolKind: "execute",
    decision: "acceptForSession",
    offered: "allow-once-only",
    cardKind: "command",
    terminalAllowed: true,
    terminalAllowedAfterTurn: false,
  },
  {
    label: "a declined execute request",
    toolKind: "execute",
    decision: "decline",
    cardKind: "command",
    terminalAllowed: false,
    terminalAllowedAfterTurn: false,
  },
  {
    label: "an execute request approved while the agent offers no allow option",
    toolKind: "execute",
    decision: "accept",
    offered: "reject-only",
    cardKind: "command",
    terminalAllowed: false,
    terminalAllowedAfterTurn: false,
  },
  {
    label: "an execute request approved for the session while the agent offers no allow option",
    toolKind: "execute",
    decision: "acceptForSession",
    offered: "reject-only",
    cardKind: "command",
    terminalAllowed: false,
    terminalAllowedAfterTurn: false,
  },
  {
    label: "an unanswered execute request",
    toolKind: "execute",
    decision: "accept",
    unanswered: true,
    cardKind: "command",
    terminalAllowed: false,
    terminalAllowedAfterTurn: false,
  },
  {
    label: "a cancelled execute request",
    toolKind: "execute",
    decision: "cancel",
    cardKind: "command",
    terminalAllowed: false,
    terminalAllowedAfterTurn: false,
  },
  // One option ID shared by two kinds: the agent may read the answer as either,
  // so the grant takes the narrower one.
  {
    label: "shared ID, allow-once listed first: Always allow",
    toolKind: "execute",
    decision: "acceptForSession",
    offered: [
      { optionId: "shared", name: "Allow once", kind: "allow_once" },
      { optionId: "shared", name: "Always allow", kind: "allow_always" },
      rejectOnce,
    ],
    cardKind: "command",
    sentOptionId: "shared",
    terminalAllowed: true,
    terminalAllowedAfterTurn: false,
  },
  {
    label: "shared ID, allow-always listed first: Always allow",
    toolKind: "execute",
    decision: "acceptForSession",
    offered: [
      { optionId: "shared", name: "Always allow", kind: "allow_always" },
      { optionId: "shared", name: "Allow once", kind: "allow_once" },
      rejectOnce,
    ],
    cardKind: "command",
    sentOptionId: "shared",
    terminalAllowed: true,
    terminalAllowedAfterTurn: false,
  },
  {
    label: "shared ID, reject listed first: an approval",
    toolKind: "execute",
    decision: "accept",
    offered: [
      { optionId: "shared", name: "Reject", kind: "reject_once" },
      { optionId: "shared", name: "Allow once", kind: "allow_once" },
    ],
    cardKind: "command",
    sentOptionId: "shared",
    terminalAllowed: false,
    terminalAllowedAfterTurn: false,
  },
  {
    label: "blank first allow-always ID: Always allow",
    toolKind: "execute",
    decision: "acceptForSession",
    offered: [
      allowOnce,
      { optionId: "  ", name: "Always allow", kind: "allow_always" },
      { optionId: "always-ok", name: "Always allow", kind: "allow_always" },
      rejectOnce,
    ],
    cardKind: "command",
    sentOptionId: "always-ok",
    terminalAllowed: true,
    terminalAllowedAfterTurn: true,
  },
  // An ID-only request takes the kind of the tool call the turn tracks.
  {
    label: "tracked execute call, exact ID: an ID-only request",
    toolKind: undefined,
    toolCallId: "tracked-call",
    trackedToolCall: { toolCallId: "tracked-call", kind: "execute" },
    decision: "accept",
    cardKind: "command",
    terminalAllowed: true,
    terminalAllowedAfterTurn: false,
  },
  {
    label: "tracked execute call, spaced ID: an ID-only request",
    toolKind: undefined,
    toolCallId: " tracked-call ",
    trackedToolCall: { toolCallId: "tracked-call", kind: "execute" },
    decision: "accept",
    cardKind: "command",
    terminalAllowed: true,
    terminalAllowedAfterTurn: false,
  },
  {
    label: "tracked edit call, spaced ID: an ID-only request",
    toolKind: undefined,
    toolCallId: " tracked-call ",
    trackedToolCall: { toolCallId: "tracked-call", kind: "edit" },
    decision: "accept",
    // Only a tracked execute kind is copied, so the card stays a command card.
    cardKind: "command",
    terminalAllowed: false,
    terminalAllowedAfterTurn: false,
  },
  // Reads, searches and thinking are allowed by the thread policy without a
  // card and never record an approval; the client policy unit test covers them.
  ...(
    [
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
      terminalAllowedAfterTurn: false,
    })),
  ),
];

/**
 * Raises one permission request of the case's kind, answers it, then asks
 * for a client terminal in the same turn and after it.
 */
const runCase = (testCase: GrantCase, index: number) =>
  Effect.gen(function* () {
    const session = yield* openGrantSession(String(index));
    const turnFiber = yield* session.startTurn(1).pipe(Effect.forkScoped);
    const started = yield* session.latestRuntime;
    if (testCase.trackedToolCall !== undefined) {
      yield* session.awaitTurnRunning;
      const sessionUpdate = started.sessionUpdate;
      if (sessionUpdate === undefined) {
        return yield* Effect.die("ACP runtime must register a session update handler");
      }
      yield* sessionUpdate({
        sessionId: SESSION_ID,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: testCase.trackedToolCall.toolCallId,
          title: "git status",
          kind: testCase.trackedToolCall.kind,
          status: "pending",
        },
      } as Parameters<SessionUpdateHandler>[0]);
    }

    const permissionFiber = yield* session.raisePermission(
      {
        toolCallId: testCase.toolCallId ?? "grant-tool-call",
        title: "git status",
        ...(testCase.toolKind === undefined ? {} : { kind: testCase.toolKind }),
      },
      offeredOptions(testCase.offered),
    );
    const pending = yield* session.awaitPendingRequest;
    const onOutgoingResponse = started.input.onOutgoingResponse;
    if (onOutgoingResponse === undefined) {
      return yield* Effect.die("ACP runtime must expose native response acknowledgements");
    }
    const acknowledgeResponse = onOutgoingResponse(PERMISSION_REQUEST_ID);
    let sent: Effect.Success<ReturnType<PermissionHandler>> | undefined;
    if (testCase.unanswered !== true) {
      const responseFiber = yield* session.runtime
        .respondToRuntimeRequest({ requestId: pending.id, decision: testCase.decision })
        .pipe(Effect.forkScoped);
      sent = yield* Fiber.join(permissionFiber);
      yield* acknowledgeResponse;
      yield* Fiber.join(responseFiber);
    }

    const terminalAllowed =
      (yield* session.terminalOutcome(started, "grant-terminal-create")) === "allowed";
    const interruptFiber = yield* session.runtime
      .interruptTurn({
        providerThread: session.providerThread,
        providerTurnId: pending.providerTurnId,
      })
      .pipe(Effect.forkScoped);
    if (testCase.unanswered === true) {
      // Stopping the turn answers the open request "cancelled" for the person.
      yield* Fiber.join(permissionFiber);
      yield* acknowledgeResponse;
    }
    yield* Fiber.join(interruptFiber);
    yield* Fiber.join(turnFiber);
    // With no turn running, only a session-wide grant lets a terminal open.
    const terminalAllowedAfterTurn =
      (yield* session.terminalOutcome(started, "grant-terminal-create-after-turn")) === "allowed";
    const outcome = sent?.outcome;
    return {
      cardKind: pending.kind,
      ...(testCase.sentOptionId === undefined
        ? {}
        : { sentOptionId: outcome?.outcome === "selected" ? outcome.optionId : null }),
      terminalAllowed,
      terminalAllowedAfterTurn,
    };
  });

describe("AcpAdapterV2 client terminal grants", () => {
  it.effect.each(cases.map((testCase, index) => ({ ...testCase, index })))(
    "$label: terminal allowed $terminalAllowed, after the turn $terminalAllowedAfterTurn",
    ({ index, ...testCase }) =>
      Effect.gen(function* () {
        const result = yield* runCase(testCase, index);
        assert.deepEqual(result, {
          cardKind: testCase.cardKind,
          ...(testCase.sentOptionId === undefined ? {} : { sentOptionId: testCase.sentOptionId }),
          terminalAllowed: testCase.terminalAllowed,
          terminalAllowedAfterTurn: testCase.terminalAllowedAfterTurn,
        });
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});

describe("AcpAdapterV2 client terminal grants across runtimes", () => {
  it.live("records no grant for an Always allow answer rejected at admission", () =>
    Effect.gen(function* () {
      const admissionStarted = yield* Deferred.make<void>();
      const releaseAdmission = yield* Deferred.make<void>();
      const transportClosed = yield* Deferred.make<void>();
      const releaseTransportClose = yield* Deferred.make<void>();
      const lifecycle: Array<string> = [];
      const sessionScope = yield* Scope.make();
      const session = yield* openGrantSession("admission-rejected", {
        sessionScope,
        testHooks: {
          beforeNativeResponseAdmissionCheck: () =>
            Deferred.succeed(admissionStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseAdmission)),
            ),
          afterNativeResponseTransportClosed: () =>
            Deferred.succeed(transportClosed, undefined).pipe(
              Effect.andThen(Deferred.await(releaseTransportClose)),
            ),
          onNativeResponseLifecycle: (event) =>
            Effect.sync(() => {
              lifecycle.push(event.type);
            }),
        },
      });
      yield* session.startTurn(1).pipe(Effect.exit, Effect.forkScoped);
      const started = yield* session.latestRuntime;
      const permissionFiber = yield* session.raisePermission(
        { toolCallId: "grant-tool-call", title: "git status", kind: "execute" },
        [allowOnce, allowAlways, rejectOnce],
      );
      const pending = yield* session.awaitPendingRequest;
      const responseFiber = yield* session.runtime
        .respondToRuntimeRequest({ requestId: pending.id, decision: "acceptForSession" })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(admissionStarted);

      // The session closes while the answer waits for admission.
      const closeFiber = yield* Scope.close(sessionScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(transportClosed);
      yield* Deferred.succeed(releaseAdmission, undefined);
      yield* Fiber.join(permissionFiber).pipe(Effect.exit);
      while (!lifecycle.includes("admission_rejected")) {
        yield* Effect.yieldNow;
      }
      const responseExit = yield* Fiber.join(responseFiber);
      // Asked before any new runtime starts, so only the admission decides.
      const outcome = yield* session.terminalOutcome(started, "terminal-after-rejection");
      const runtimesStarted = session.runtimes.length;
      yield* Deferred.succeed(releaseTransportClose, undefined);
      yield* Fiber.join(closeFiber);

      assert.isTrue(Exit.isFailure(responseExit), "the rejected answer must not be delivered");
      assert.equal(runtimesStarted, 1);
      assert.equal(outcome, "denied");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live.each([
    { label: "never delivered because the agent process ended", answer: "lost" },
    { label: "delivered, then the agent process ended", answer: "delivered" },
    { label: "given after the agent process ended", answer: "after-exit" },
  ] as const)("asks again after a runtime restart when Always allow was $label", ({ answer }) =>
    Effect.gen(function* () {
      const session = yield* openGrantSession(`restart-${answer}`);
      const turnFiber = yield* session.startTurn(1).pipe(Effect.exit, Effect.forkScoped);
      const first = yield* session.latestRuntime;
      const permissionFiber = yield* session.raisePermission(
        { toolCallId: "grant-tool-call", title: "git status", kind: "execute" },
        [allowOnce, allowAlways, rejectOnce],
      );
      const pending = yield* session.awaitPendingRequest;
      const processEnded = new EffectAcpErrors.AcpTransportError({
        detail: "The agent process ended",
        cause: "Agent process exited",
      });
      // The runtime reports its agent process ended.
      const reportProcessEnded = first.input.onTermination(processEnded);
      if (answer === "after-exit") yield* reportProcessEnded;
      const responseFiber = yield* session.runtime
        .respondToRuntimeRequest({ requestId: pending.id, decision: "acceptForSession" })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Fiber.join(permissionFiber);
      if (answer === "after-exit") {
        // A runtime that reported its end keeps no grant, even for itself.
        const outcome = yield* session.terminalOutcome(first, "terminal-after-exit");
        assert.equal(outcome, "denied");
      }
      if (answer === "delivered") {
        const onOutgoingResponse = first.input.onOutgoingResponse;
        if (onOutgoingResponse === undefined) {
          return yield* Effect.die("ACP runtime must expose native response acknowledgements");
        }
        yield* onOutgoingResponse(PERMISSION_REQUEST_ID);
      } else {
        const onOutgoingResponseFailure = first.input.onOutgoingResponseFailure;
        if (onOutgoingResponseFailure === undefined) {
          return yield* Effect.die("ACP runtime must expose native response failures");
        }
        yield* onOutgoingResponseFailure(PERMISSION_REQUEST_ID, processEnded);
      }
      if (answer !== "after-exit") yield* reportProcessEnded;
      const responseExit = yield* Fiber.join(responseFiber);
      assert.equal(Exit.isSuccess(responseExit), answer === "delivered");

      yield* session.runtime
        .interruptTurn({
          providerThread: session.providerThread,
          providerTurnId: pending.providerTurnId,
        })
        .pipe(Effect.exit);
      yield* Fiber.join(turnFiber);

      // The next turn starts a new agent runtime with a new native session.
      yield* session.startTurn(2).pipe(Effect.exit, Effect.forkScoped);
      const second = yield* session.awaitRuntime(2);
      assert.notStrictEqual(second, first);
      const outcome = yield* session.terminalOutcome(second, "terminal-after-restart");
      assert.equal(outcome, "denied");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live.each([
    { label: "answered before the agent process ended", order: "answer-first" },
    { label: "answered after the agent process ended", order: "exit-first" },
  ] as const)(
    "grants the next runtime nothing for an Always allow $label and admitted after the restart",
    ({ order }) =>
      Effect.gen(function* () {
        const admissionHeld = yield* Deferred.make<void>();
        const releaseAdmission = yield* Deferred.make<void>();
        let holdAdmission = true;
        const session = yield* openGrantSession(`held-${order}`, {
          testHooks: {
            beforeNativeResponseAdmissionCheck: (_generation, requestId) => {
              if (!holdAdmission || requestId !== PERMISSION_REQUEST_ID) return Effect.void;
              holdAdmission = false;
              return Deferred.succeed(admissionHeld, undefined).pipe(
                Effect.andThen(Deferred.await(releaseAdmission)),
              );
            },
          },
        });
        const turnFiber = yield* session.startTurn(1).pipe(Effect.exit, Effect.forkScoped);
        const first = yield* session.latestRuntime;
        const permissionFiber = yield* session.raisePermission(
          { toolCallId: "grant-tool-call", title: "git status", kind: "execute" },
          [allowOnce, allowAlways, rejectOnce],
        );
        const pending = yield* session.awaitPendingRequest;
        const processEnded = new EffectAcpErrors.AcpTransportError({
          detail: "The agent process ended",
          cause: "Agent process exited",
        });
        const onOutgoingResponseFailure = first.input.onOutgoingResponseFailure;
        if (onOutgoingResponseFailure === undefined) {
          return yield* Effect.die("ACP runtime must expose native response failures");
        }
        if (order === "exit-first") yield* first.input.onTermination(processEnded);
        const responseFiber = yield* session.runtime
          .respondToRuntimeRequest({ requestId: pending.id, decision: "acceptForSession" })
          .pipe(Effect.exit, Effect.forkScoped);
        // Runtime 1's handler now waits just before its answer is admitted.
        yield* Deferred.await(admissionHeld);
        if (order === "answer-first") yield* first.input.onTermination(processEnded);
        // The answer never reaches the ended process, so the person's request fails.
        yield* onOutgoingResponseFailure(PERMISSION_REQUEST_ID, processEnded);
        const responseExit = yield* Fiber.join(responseFiber);
        assert.isTrue(Exit.isFailure(responseExit), "the lost answer must not be reported sent");

        yield* session.runtime
          .interruptTurn({
            providerThread: session.providerThread,
            providerTurnId: pending.providerTurnId,
          })
          .pipe(Effect.exit);
        yield* Fiber.join(turnFiber);

        // The next turn starts runtime 2 while runtime 1's handler is still held.
        yield* session.startTurn(2).pipe(Effect.exit, Effect.forkScoped);
        const second = yield* session.awaitRuntime(2);
        assert.notStrictEqual(second, first);
        yield* Deferred.succeed(releaseAdmission, undefined);
        const heldExit = yield* Fiber.join(permissionFiber).pipe(Effect.exit);

        const outcome = yield* session.terminalOutcome(second, "terminal-after-held-answer");
        assert.equal(outcome, "denied");
        // Runtime 1's generation ended when runtime 2 started, so its answer is refused.
        assert.isTrue(Exit.isFailure(heldExit), "the ended runtime's answer must not be admitted");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("ends the running turn when a snapshot read replaces the ended runtime first", () =>
    Effect.gen(function* () {
      const promptStarted = yield* Deferred.make<void>();
      const failPrompt = yield* Deferred.make<void>();
      const session = yield* openGrantSession("snapshot-restart", {
        firstPrompt: { started: promptStarted, fail: failPrompt },
      });
      yield* session.startTurn(1).pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(promptStarted);
      const first = yield* session.latestRuntime;
      yield* first.input.onTermination(
        new EffectAcpErrors.AcpTransportError({
          detail: "The agent process ended",
          cause: "Agent process exited",
        }),
      );
      // The snapshot read replaces runtime 1 before its prompt reports the failure.
      yield* session.runtime
        .readThreadSnapshot({ providerThread: session.providerThread })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* session.awaitRuntime(2);
      yield* Deferred.succeed(failPrompt, undefined);

      const ended = yield* session.runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status !== "running",
        ),
        Stream.runHead,
        Effect.timeoutOption("10 seconds"),
      );
      const endedTurn = Option.flatten(ended);
      assert.isTrue(Option.isSome(endedTurn), "the turn of the ended runtime must end");
      const endedEvent = Option.getOrThrow(endedTurn);
      assert.equal(
        endedEvent.type === "provider_turn.updated" ? endedEvent.providerTurn.status : null,
        "failed",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.live("finishes a Stop the agent ignores while a URL sign-in waits for consent", () =>
    Effect.gen(function* () {
      const elicitationHeld = yield* Deferred.make<void>();
      const consent = yield* Deferred.make<boolean>();
      const session = yield* openGrantSession("url-consent-stop", {
        agentEnvironment: {
          STUDIO_ACP_SESSION_LIFECYCLE: "1",
          STUDIO_ACP_EMIT_URL_ELICITATION: "1",
        },
        onUrlElicitation: () =>
          Deferred.succeed(elicitationHeld, undefined).pipe(
            Effect.andThen(Deferred.await(consent)),
          ),
      });
      yield* session.startTurn(1).pipe(Effect.exit, Effect.forkScoped);
      const running = Option.getOrThrow(yield* session.awaitTurnRunning);
      if (running.type !== "provider_turn.updated") {
        return yield* Effect.die("Expected a running ACP provider turn");
      }
      // The agent's URL sign-in now waits for the person's consent.
      yield* Deferred.await(elicitationHeld);

      const stopped = yield* session.runtime
        .interruptTurn({
          providerThread: session.providerThread,
          providerTurnId: running.providerTurn.id,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.exit, Effect.timeoutOption("25 seconds"));
      const runtimesStarted = session.runtimes.length;
      yield* Deferred.succeed(consent, false);

      assert.isTrue(Option.isSome(stopped), "the Stop must not wait for the sign-in consent");
      assert.isTrue(Exit.isSuccess(Option.getOrThrow(stopped)));
      assert.equal(runtimesStarted, 2);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
