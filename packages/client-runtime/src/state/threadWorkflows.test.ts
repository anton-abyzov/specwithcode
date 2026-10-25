import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2ThreadProjection } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";

import {
  canDetachThreadProviderSession,
  canForkProjectedAssistantItem,
  deriveThreadQueueWorkflowState,
  resolveLatestMergeBackRun,
  threadSupportsProviderHandoff,
} from "./threadWorkflows.ts";

const DateTimeUtc = (iso: string) => DateTime.makeUnsafe(iso);

const capabilities = (input?: {
  readonly queued?: boolean;
  readonly steer?: boolean;
  readonly restartSteer?: boolean;
  readonly nativeFork?: boolean;
  readonly portableFork?: boolean;
}) =>
  ({
    turns: {
      supportsQueuedMessages: input?.queued ?? false,
      supportsActiveSteering: input?.steer ?? false,
      supportsSteeringByInterruptRestart: input?.restartSteer ?? false,
    },
    threads: {
      canForkThread: input?.nativeFork ?? false,
      canForkFromTurn: input?.nativeFork ?? false,
    },
    identity: { nativeThreadIds: input?.nativeFork ? "strong" : "none" },
    context: { supportsFullThreadHandoff: input?.portableFork ?? false },
  }) as never;

describe("thread workflows", () => {
  it("allows a completed thread to switch providers after its session detaches", () => {
    const projection = {
      thread: {
        id: "thread",
        activeProviderThreadId: "provider-thread",
        modelSelection: { instanceId: "cursor", model: "grok-4.7" },
      },
      runs: [{ id: "run", status: "completed", providerInstanceId: "cursor" }],
      providerSessions: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerInstanceId: "cursor",
          providerSessionId: "detached-session",
          nativeThreadRef: { driver: "cursor", nativeId: "agent-123", strength: "strong" },
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;

    expect(threadSupportsProviderHandoff(projection)).toBe(true);
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        runs: [{ ...projection.runs[0]!, status: "running" }],
      }),
    ).toBe(false);
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        providerThreads: [{ ...projection.providerThreads[0]!, nativeThreadRef: null }],
      }),
    ).toBe(false);
    // The limit hit the very first message: nothing native exists, so the
    // thread can start over on another provider.
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        runs: [{ ...projection.runs[0]!, status: "failed" }],
        providerThreads: [{ ...projection.providerThreads[0]!, nativeThreadRef: null }],
      }),
    ).toBe(true);
  });

  it("lets a thread leave a provider that never answered on it", () => {
    // Earlier turns ran on Claude; then the thread moved to a managed Copilot
    // agent that was never prepared here, and every open failed.
    const projection = {
      thread: {
        id: "thread",
        activeProviderThreadId: "copilot-thread",
        modelSelection: { instanceId: "copilot-managed", model: "claude-opus-5.5" },
      },
      runs: [
        { id: "run-1", status: "completed", providerInstanceId: "claudeAgent" },
        { id: "run-2", status: "failed", providerInstanceId: "copilot-managed" },
      ],
      providerSessions: [],
      providerThreads: [
        {
          id: "claude-thread",
          appThreadId: "thread",
          providerInstanceId: "claudeAgent",
          nativeThreadRef: { driver: "claudeAgent", nativeId: "s-1", strength: "strong" },
        },
        {
          id: "copilot-thread",
          appThreadId: "thread",
          providerInstanceId: "copilot-managed",
          nativeThreadRef: null,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(threadSupportsProviderHandoff(projection)).toBe(true);
    // Once that provider has answered, its native session is the one to keep.
    expect(
      threadSupportsProviderHandoff({
        ...projection,
        runs: [
          ...projection.runs,
          { ...projection.runs[1]!, id: "run-3", status: "completed" },
        ] as never,
      }),
    ).toBe(false);
  });

  it("lets an idle thread leave a provider that cannot run here", () => {
    // Managed Copilot answered earlier turns; it is no longer prepared on this
    // machine, so the latest open failed on a fresh provider thread and its
    // session record is gone. Nothing native is attached to keep.
    const projection = {
      thread: {
        id: "thread",
        activeProviderThreadId: "copilot-thread-2",
        modelSelection: { instanceId: "acpRegistry_copilot", model: "claude-opus-5.5" },
      },
      runs: [
        { id: "run-1", status: "completed", providerInstanceId: "acpRegistry_copilot" },
        { id: "run-2", status: "failed", providerInstanceId: "acpRegistry_copilot" },
      ],
      providerSessions: [],
      providerThreads: [
        {
          id: "copilot-thread-1",
          appThreadId: "thread",
          providerInstanceId: "acpRegistry_copilot",
          providerSessionId: null,
          nativeThreadRef: { driver: "acpRegistry", nativeId: "acp-1", strength: "strong" },
        },
        {
          id: "copilot-thread-2",
          appThreadId: "thread",
          providerInstanceId: "acpRegistry_copilot",
          providerSessionId: "missing-session",
          nativeThreadRef: null,
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;

    expect(threadSupportsProviderHandoff(projection)).toBe(false);
    expect(threadSupportsProviderHandoff(projection, { selectedInstanceCanRun: false })).toBe(true);
    expect(threadSupportsProviderHandoff(projection, { selectedInstanceCanRun: true })).toBe(false);
    // A turn that is still running keeps the thread where it is.
    expect(
      threadSupportsProviderHandoff(
        {
          ...projection,
          runs: [...projection.runs, { id: "run-3", status: "running" }] as never,
        },
        { selectedInstanceCanRun: false },
      ),
    ).toBe(false);
  });

  it("sorts queued messages and gates reorder and promotion from capabilities", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "active",
          status: "running",
          providerThreadId: "provider-thread",
          activeAttemptId: "attempt-active",
          ordinal: 1,
        },
        { id: "later", status: "queued", userMessageId: "message-later", ordinal: 3 },
        {
          id: "first",
          status: "queued",
          userMessageId: "message-first",
          ordinal: 2,
          queuePosition: 1,
        },
      ],
      messages: [
        {
          id: "message-first",
          text: "First",
          attachments: [
            {
              type: "image",
              id: "attachment-first",
              name: "first.png",
              mimeType: "image/png",
              sizeBytes: 64,
            },
          ],
        },
        { id: "message-later", text: "Later" },
      ],
      providerTurns: [
        {
          id: "provider-turn-active",
          runAttemptId: "attempt-active",
          status: "running",
        },
      ],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "running",
          capabilities: capabilities({ queued: true, restartSteer: true }),
        },
      ],
    } as never);

    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["first", "First"],
      ["later", "Later"],
    ]);
    expect(state.queuedRuns.map(({ attachments }) => attachments.map(({ id }) => id))).toEqual([
      ["attachment-first"],
      [],
    ]);
    expect(state.activeRun?.id).toBe("active");
    expect(state.canReorder).toBe(true);
    expect(state.canPromoteToSteer).toBe(true);
  });

  it("keeps held messages visible and clears the hold when they leave the queue", () => {
    for (const status of ["queued", "cancelled", "starting"] as const) {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: null },
        runs: [{ id: "held", status, userMessageId: "message", ordinal: 1, queueHeld: true }],
        messages: [{ id: "message", text: "Saved message" }],
        providerThreads: [],
        providerTurns: [],
        providerSessions: [],
      } as never);
      expect(state.isHeld).toBe(status === "queued");
      expect(state.queuedRuns.map(({ text }) => text)).toEqual(
        status === "queued" ? ["Saved message"] : [],
      );
    }
  });

  it("shows automatic deliveries as read-only rows in delivery order", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: null },
      runs: [
        {
          id: "provider-wake",
          status: "queued",
          userMessageId: "provider-wake",
          ordinal: 4,
          queuePosition: 3,
        },
        {
          id: "automatic",
          status: "queued",
          userMessageId: "message-automatic",
          ordinal: 2,
          queuePosition: 1,
        },
        {
          id: "visible",
          status: "queued",
          userMessageId: "message-visible",
          ordinal: 3,
          queuePosition: 2,
        },
      ],
      messages: [
        {
          id: "provider-wake",
          text: "Model-facing text",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "Monitor updated",
          },
        },
        {
          id: "message-automatic",
          text: "A delegated task reached a terminal state.",
          delegatedCompletion: {
            generation: 1,
            parentRunId: "run:parent",
            taskIds: ["task:child"],
          },
        },
        { id: "message-visible", text: "Visible queued message" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    // Delegated results go first, as the server delivers them; a notification
    // keeps its position among the person's messages.
    expect(
      state.queuedRuns.map(({ run, automatic, summary }) => [
        run.id,
        automatic === true,
        summary ?? null,
      ]),
    ).toEqual([
      ["automatic", true, null],
      ["visible", false, null],
      ["provider-wake", true, "Monitor updated"],
    ]);
  });

  it("removes only the promoted head from the visible queue", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "promoted",
          status: "starting",
          userMessageId: "message-promoted",
          providerThreadId: "provider-thread",
          ordinal: 2,
          queuePosition: null,
        },
        {
          id: "still-queued",
          status: "queued",
          userMessageId: "message-still-queued",
          providerThreadId: "provider-thread",
          ordinal: 3,
          queuePosition: 2,
        },
      ],
      messages: [
        { id: "message-promoted", text: "Run now" },
        { id: "message-still-queued", text: "Wait longer" },
      ],
      providerTurns: [],
      providerThreads: [],
      providerSessions: [],
    } as never);

    expect(state.activeRun?.id).toBe("promoted");
    expect(state.queuedRuns.map(({ run, text }) => [run.id, text])).toEqual([
      ["still-queued", "Wait longer"],
    ]);
  });

  it.each(["preparing", "starting", "waiting"] as const)(
    "does not promote queued work into a %s run",
    (status) => {
      const state = deriveThreadQueueWorkflowState({
        thread: { id: "thread", activeProviderThreadId: "provider-thread" },
        runs: [
          {
            id: "active",
            status,
            providerThreadId: "provider-thread",
            activeAttemptId: "attempt-active",
            ordinal: 1,
          },
          { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
        ],
        messages: [{ id: "message", text: "Queued" }],
        providerTurns: [
          {
            id: "provider-turn-active",
            runAttemptId: "attempt-active",
            status: status === "waiting" ? "completed" : "starting",
          },
        ],
        providerThreads: [
          {
            id: "provider-thread",
            appThreadId: "thread",
            providerSessionId: "provider-session",
          },
        ],
        providerSessions: [
          {
            id: "provider-session",
            status: "running",
            capabilities: capabilities({ queued: true, steer: true }),
          },
        ],
      } as never);

      expect(state.canPromoteToSteer).toBe(false);
    },
  );

  it("does not promote queued work until the running provider turn is projected", () => {
    const state = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [
        {
          id: "active",
          status: "running",
          providerThreadId: "provider-thread",
          activeAttemptId: "attempt-active",
          ordinal: 1,
        },
        { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
      ],
      messages: [{ id: "message", text: "Queued" }],
      providerTurns: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "running",
          capabilities: capabilities({ queued: true, steer: true }),
        },
      ],
    } as never);

    expect(state.canPromoteToSteer).toBe(false);
  });

  it("does not expose known unsupported queue or fork actions", () => {
    const projection = {
      thread: { id: "thread", activeProviderThreadId: "provider-thread" },
      runs: [{ id: "queued", status: "queued", userMessageId: "message", ordinal: 1 }],
      messages: [],
      providerThreads: [
        {
          id: "provider-thread",
          appThreadId: "thread",
          providerSessionId: "provider-session",
        },
      ],
      providerSessions: [
        {
          id: "provider-session",
          status: "ready",
          capabilities: capabilities(),
        },
      ],
    } as never;
    const queue = deriveThreadQueueWorkflowState(projection);
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(queue.canReorder).toBe(false);
    expect(queue.canPromoteToSteer).toBe(false);
    expect(canForkProjectedAssistantItem({ projectedItem, capabilities: capabilities() })).toBe(
      false,
    );
    expect(canDetachThreadProviderSession(projection)).toBe(true);
  });

  it("allows native, portable, and capability-unknown exact-run forks", () => {
    const projectedItem = {
      item: { type: "assistant_message", runId: "run", status: "completed" },
    } as never;

    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ nativeFork: true }),
      }),
    ).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem,
        capabilities: capabilities({ portableFork: true }),
      }),
    ).toBe(true);
    expect(canForkProjectedAssistantItem({ projectedItem })).toBe(true);
    expect(
      canForkProjectedAssistantItem({
        projectedItem: {
          item: { type: "assistant_message", runId: "run", status: "running" },
        } as never,
      }),
    ).toBe(false);
  });

  it("merges the newest provider-finished run while checkpoint capture is pending", () => {
    const projection = {
      runs: [
        { id: "newest-queued", status: "queued", ordinal: 3 },
        { id: "older-completed", status: "completed", ordinal: 1 },
        { id: "newest-finished", status: "waiting", ordinal: 2 },
      ],
    } as never;

    expect(resolveLatestMergeBackRun(projection)?.id).toBe("newest-finished");
  });

  it("does not let a stale completed run later in storage order hide the waiting checkpoint", () => {
    const projection = {
      runs: [
        { id: "newest-finished", status: "waiting", ordinal: 2 },
        { id: "older-completed", status: "completed", ordinal: 1 },
      ],
    } as never;

    expect(resolveLatestMergeBackRun(projection)?.id).toBe("newest-finished");
  });

  it.each(["preparing", "starting", "running"] as const)(
    "does not merge older history while a newer run is %s",
    (status) => {
      const projection = {
        runs: [
          { id: "older-completed", status: "completed", ordinal: 1 },
          { id: "newer-active", status, ordinal: 2 },
        ],
      } as never;

      expect(resolveLatestMergeBackRun(projection)).toBeNull();
    },
  );

  const steeringProjection = (overrides: Record<string, unknown> = {}) =>
    ({
      thread: {
        id: "thread",
        activeProviderThreadId: "provider-thread",
        providerInstanceId: "claude",
      },
      runs: [
        {
          id: "active",
          status: "running",
          providerThreadId: "provider-thread",
          activeAttemptId: "attempt-active",
          ordinal: 1,
        },
        { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
      ],
      messages: [{ id: "message", text: "Queued", runId: "queued" }],
      providerTurns: [{ id: "turn", runAttemptId: "attempt-active", status: "running" }],
      providerThreads: [
        { id: "provider-thread", appThreadId: "thread", providerSessionId: "provider-session" },
      ],
      providerSessions: [
        {
          id: "provider-session",
          providerInstanceId: "claude",
          status: "running",
          capabilities: capabilities({ queued: true, steer: true }),
        },
      ],
      turnItems: [],
      ...overrides,
    }) as never;

  it("names why Steer now is unavailable", () => {
    const steerable = deriveThreadQueueWorkflowState(steeringProjection());
    expect(steerable.canPromoteToSteer).toBe(true);
    expect(steerable.steerUnavailableReason).toBeNull();
    expect(steerable.waitReason).toBe("turn");

    const noTurn = deriveThreadQueueWorkflowState(steeringProjection({ providerTurns: [] }));
    expect(noTurn.canPromoteToSteer).toBe(false);
    expect(noTurn.steerUnavailableReason).toMatch(/No provider turn is running/);

    const deadSession = deriveThreadQueueWorkflowState(
      steeringProjection({
        providerSessions: [
          {
            id: "provider-session",
            providerInstanceId: "claude",
            status: "stopped",
            capabilities: capabilities({ queued: true, steer: true }),
          },
        ],
      }),
    );
    expect(deadSession.canPromoteToSteer).toBe(false);
    expect(deadSession.steerUnavailableReason).toMatch(/session is not live/);

    const cannotSteer = deriveThreadQueueWorkflowState(
      steeringProjection({
        providerSessions: [
          {
            id: "provider-session",
            providerInstanceId: "claude",
            status: "running",
            capabilities: capabilities({ queued: true }),
          },
        ],
      }),
    );
    expect(cannotSteer.steerUnavailableReason).toMatch(/cannot take a message/);

    const idle = deriveThreadQueueWorkflowState(
      steeringProjection({
        runs: [{ id: "queued", status: "queued", userMessageId: "message", ordinal: 2 }],
      }),
    );
    expect(idle.steerUnavailableReason).toMatch(/No turn is running/);
  });

  it("marks a row whose message is being steered into the running turn", () => {
    const state = deriveThreadQueueWorkflowState(
      steeringProjection({ messages: [{ id: "message", text: "Queued", runId: "active" }] }),
    );
    expect(state.queuedRuns.map(({ run, steering }) => [run.id, steering === true])).toEqual([
      ["queued", true],
    ]);
    // Once that turn ends the row is an ordinary queued message again.
    const ended = deriveThreadQueueWorkflowState(
      steeringProjection({
        runs: [
          { id: "active", status: "completed", ordinal: 1 },
          { id: "queued", status: "queued", userMessageId: "message", ordinal: 2 },
        ],
        messages: [{ id: "message", text: "Queued", runId: "active" }],
      }),
    );
    expect(ended.queuedRuns[0]?.steering).toBeUndefined();
  });

  it.each([
    ["stopped", "interrupted", undefined, undefined],
    ["failure", "failed", undefined, undefined],
    ["restart", "interrupted", true, undefined],
    ["usage_limit", "failed", undefined, "usage_limit"],
  ] as const)("says the queue is held: %s", (reason, lastStatus, forRestart, failureClass) => {
    const state = deriveThreadQueueWorkflowState(
      steeringProjection({
        runs: [
          {
            id: "last",
            status: lastStatus,
            ordinal: 1,
            startedAt: "2026-10-24T01:00:00.000Z",
            completedAt: DateTimeUtc("2026-10-24T01:05:00.000Z"),
            rootNodeId: "node-last",
          },
          {
            id: "queued",
            status: "queued",
            userMessageId: "message",
            ordinal: 2,
            queueHeld: true,
            ...(forRestart ? { queueHeldForRestart: true } : {}),
          },
        ],
        turnItems:
          failureClass === undefined
            ? []
            : [
                {
                  id: "error",
                  runId: "last",
                  nodeId: "node-last",
                  type: "error",
                  status: "failed",
                  ordinal: 5,
                  updatedAt: DateTimeUtc("2026-10-24T01:05:00.000Z"),
                  failure: { class: failureClass, message: "You've hit your limit" },
                },
              ],
      }),
    );
    expect(state.waitReason).toBe(reason);
    expect(state.isHeld).toBe(true);
  });
});
