import type { ElicitationRequest } from "@anthropic-ai/claude-agent-sdk";
import { RuntimeRequestId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
import {
  isUnattendedClaudeTurn,
  makeClaudeMcpElicitations,
  type ClaudeElicitationTurnContext,
  UNATTENDED_MCP_ELICITATION_TIMEOUT_MS,
  unattendedTimeoutNotice,
  unreadableFormNotice,
  urlModeNotice,
} from "./ClaudeMcpElicitation.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;

const confirmSchema = {
  type: "object",
  properties: { name: { type: "string", title: "Type the repository name" } },
  required: ["name"],
};

const turnInput = (thread: "user" | "agent", scheduled = false) =>
  ({
    appThread: { createdBy: thread },
    threadId: "thread-1",
    runId: "run-1",
    rootNodeId: "node-root",
    providerThread: { id: "provider-thread-1" },
    message: {
      createdBy: "user",
      ...(scheduled ? { scheduledTaskId: "routine-1" } : {}),
    },
  }) as unknown as ProviderAdapter.ProviderAdapterV2TurnInput;

function harness(options: { thread?: "user" | "agent"; held?: boolean; noTurn?: boolean } = {}) {
  const events: Array<Event> = [];
  let released = 0;
  let requestCount = 0;
  const context: ClaudeElicitationTurnContext = {
    input: turnInput(options.thread ?? "user"),
    providerTurnId: "provider-turn-1" as ClaudeElicitationTurnContext["providerTurnId"],
    heldRootFrames: options.held === true ? [{}] : [],
  };
  const timer = Effect.runSync(Deferred.make<void>());
  const elicitations = makeClaudeMcpElicitations({
    activeTurn: Effect.succeed(options.noTurn === true ? null : context),
    buildApprovalRequestArtifacts: (input) =>
      Effect.sync(() => {
        requestCount += 1;
        const id = RuntimeRequestId.make(`request-${requestCount}`);
        return {
          node: { id: "node-request", parentNodeId: "node-from-item", status: "waiting" },
          request: { id, kind: input.requestKind, status: "pending" },
          turnItem: {
            id: `item-${requestCount}`,
            type: "approval_request",
            requestId: id,
            requestKind: input.requestKind,
            prompt: input.prompt,
            status: "waiting",
          },
        } as never;
      }),
    emitProviderEvent: (event) => Effect.sync(() => void events.push(event)),
    releaseHeldRootFrames: () => Effect.sync(() => void (released += 1)),
    resolveItemOrdinal: () => Effect.succeed(7),
    idAllocator: {
      derive: {
        turnItemFromProviderItem: ({ nativeItemId }: { nativeItemId: string }) => nativeItemId,
      },
    } as never,
    runPromise: Effect.runPromise,
    unattendedTimer: Deferred.await(timer),
  });
  const ask = (request: Partial<ElicitationRequest>, signal = new AbortController().signal) =>
    elicitations.onElicitation(
      { serverName: "github", message: "Delete octo/repo?", ...request } as ElicitationRequest,
      { signal, requestId: "sdk-request-1" },
    );
  const card = () =>
    events.find(
      (event): event is Extract<Event, { type: "turn_item.updated" }> =>
        event.type === "turn_item.updated" && event.turnItem.type === "approval_request",
    )?.turnItem as Extract<Event, { type: "turn_item.updated" }>["turnItem"] & {
      readonly elicitation?: unknown;
      readonly options?: ReadonlyArray<{ decision: string }>;
      readonly appName?: string;
    };
  const notices = () =>
    events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
        ? [event.turnItem.message]
        : [],
    );
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
    expect(check()).toBe(true);
  };
  const requestId = RuntimeRequestId.make("request-1");
  return {
    events,
    elicitations,
    ask,
    card,
    notices,
    until,
    requestId,
    fireTimer: () => Effect.runSync(Deferred.succeed(timer, undefined)),
    released: () => released,
  };
}

describe("ClaudeMcpElicitation", () => {
  it("shows a form card and sends the person's content back as accept", async () => {
    const h = harness();
    const result = h.ask({ mode: "form", requestedSchema: confirmSchema });
    await h.until(() => h.card() !== undefined);
    const card = h.card();
    expect(card.appName).toBe("github");
    expect(card.elicitation).toEqual({
      serverName: "github",
      mode: "form",
      message: "Delete octo/repo?",
      requestedSchema: confirmSchema,
    });
    // A form with fields offers no Approve, so Full access never answers it.
    expect(card.options?.map((option) => option.decision)).toEqual(["decline", "cancel"]);
    const runtimeRequest = h.events.find((event) => event.type === "runtime_request.updated");
    expect(
      runtimeRequest?.type === "runtime_request.updated" && runtimeRequest.runtimeRequest.kind,
    ).toBe("mcp-elicitation");
    const node = h.events.find((event) => event.type === "node.updated");
    expect(node?.type === "node.updated" && node.node.parentNodeId).toBe("node-root");

    expect(
      await Effect.runPromise(
        h.elicitations.respond({
          requestId: h.requestId,
          decision: "accept",
          answers: { name: "octo/repo", stray: 1 },
        }),
      ),
    ).toBe(true);
    expect(await result).toEqual({ action: "accept", content: { name: "octo/repo" } });
    // The app resolved the request; nothing here closes it again.
    expect(h.events.filter((event) => event.type === "runtime_request.updated")).toHaveLength(1);
  });

  it("maps Decline and Cancel", async () => {
    for (const decision of ["decline", "cancel"] as const) {
      const h = harness();
      const result = h.ask({ requestedSchema: confirmSchema });
      await h.until(() => h.card() !== undefined);
      await Effect.runPromise(h.elicitations.respond({ requestId: h.requestId, decision }));
      expect(await result).toEqual({ action: decision });
    }
  });

  it("cancels content that does not fit the form, with a note", async () => {
    const h = harness();
    const result = h.ask({ requestedSchema: confirmSchema });
    await h.until(() => h.card() !== undefined);
    await Effect.runPromise(
      h.elicitations.respond({ requestId: h.requestId, decision: "accept", answers: {} }),
    );
    expect(await result).toEqual({ action: "cancel" });
    expect(h.notices()).toEqual([
      "The answer to github's question didn't fit its form; it was cancelled.",
    ]);
  });

  it("offers Submit on a confirm-only form and accepts it with empty content", async () => {
    const h = harness();
    const result = h.ask({ requestedSchema: { type: "object", properties: {} } });
    await h.until(() => h.card() !== undefined);
    expect(h.card().options?.map((option) => option.decision)).toEqual([
      "accept",
      "decline",
      "cancel",
    ]);
    await Effect.runPromise(h.elicitations.respond({ requestId: h.requestId, decision: "accept" }));
    expect(await result).toEqual({ action: "accept", content: {} });
  });

  it("declines URL mode visibly without a card or a link", async () => {
    const h = harness();
    const result = await h.ask({ mode: "url", url: "https://evil.example/login" });
    expect(result).toEqual({ action: "decline" });
    expect(h.card()).toBeUndefined();
    expect(h.notices()).toEqual([urlModeNotice("github")]);
    expect(JSON.stringify(h.events)).not.toContain("evil.example");
  });

  it("cancels a form it cannot show, with a note", async () => {
    const h = harness();
    const result = await h.ask({
      requestedSchema: { type: "object", properties: { deep: { type: "object" } } },
    });
    expect(result).toEqual({ action: "cancel" });
    expect(h.card()).toBeUndefined();
    expect(h.notices()).toEqual([unreadableFormNotice("github")]);
  });

  it("closes the card as cancelled when the turn stops", async () => {
    const h = harness();
    const controller = new AbortController();
    const result = h.ask({ requestedSchema: confirmSchema }, controller.signal);
    await h.until(() => h.card() !== undefined);
    controller.abort();
    expect(await result).toEqual({ action: "cancel" });
    const closed = h.events.filter(
      (event) =>
        (event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled") ||
        (event.type === "node.updated" && event.node.status === "cancelled") ||
        (event.type === "turn_item.updated" && event.turnItem.status === "cancelled"),
    );
    expect(closed).toHaveLength(3);
    // A late answer to the closed card is taken and ignored.
    expect(
      await Effect.runPromise(
        h.elicitations.respond({ requestId: h.requestId, decision: "accept" }),
      ),
    ).toBe(true);
  });

  it("answers a signal that was already aborted at once", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    expect(await h.ask({ requestedSchema: confirmSchema }, controller.signal)).toEqual({
      action: "cancel",
    });
  });

  it("cancels an unattended thread's card when the timer ends, with a note", async () => {
    const h = harness({ thread: "agent" });
    const result = h.ask({ requestedSchema: confirmSchema });
    await h.until(() => h.card() !== undefined);
    h.fireTimer();
    expect(await result).toEqual({ action: "cancel" });
    expect(h.notices()).toEqual([unattendedTimeoutNotice("github")]);
    expect(unattendedTimeoutNotice("github")).toBe(
      "No one answered github's question in 30 minutes; it was cancelled.",
    );
    expect(UNATTENDED_MCP_ELICITATION_TIMEOUT_MS).toBe(30 * 60 * 1_000);
  });

  it("keeps a watched thread's card open past the timer", async () => {
    const h = harness({ thread: "user" });
    const result = h.ask({ requestedSchema: confirmSchema });
    await h.until(() => h.card() !== undefined);
    h.fireTimer();
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.notices()).toEqual([]);
    await Effect.runPromise(
      h.elicitations.respond({
        requestId: h.requestId,
        decision: "accept",
        answers: { name: "x" },
      }),
    );
    expect(await result).toEqual({ action: "accept", content: { name: "x" } });
  });

  it("goes on with output held for the prompt echo before it asks", async () => {
    const h = harness({ held: true });
    void h.ask({ requestedSchema: confirmSchema });
    await h.until(() => h.card() !== undefined);
    expect(h.released()).toBe(1);
  });

  it("declines when no turn is active", async () => {
    const h = harness({ noTurn: true });
    expect(await h.ask({ requestedSchema: confirmSchema })).toEqual({ action: "decline" });
  });

  it("is not the owner of other requests", async () => {
    const h = harness();
    expect(
      await Effect.runPromise(
        h.elicitations.respond({ requestId: RuntimeRequestId.make("other"), decision: "accept" }),
      ),
    ).toBe(false);
  });

  it("reads unattended from the thread, not from the turn's message", () => {
    expect(isUnattendedClaudeTurn(turnInput("user"))).toBe(false);
    expect(isUnattendedClaudeTurn(turnInput("agent"))).toBe(true);
    expect(isUnattendedClaudeTurn(turnInput("user", true))).toBe(true);
    const wake = {
      ...turnInput("user"),
      message: { createdBy: "system" },
    } as unknown as ProviderAdapter.ProviderAdapterV2TurnInput;
    expect(isUnattendedClaudeTurn(wake)).toBe(false);
  });
});
