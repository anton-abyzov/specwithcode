import type { ElicitationRequest } from "@anthropic-ai/claude-agent-sdk";
import { RuntimeRequestId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
import {
  forgetUncommittedFormAnswer,
  handOffClaudeFormAnswers,
  markClaudeFormAnswerCommitted,
  redactClaudeFormAnswers,
  takeClaudeFormAnswers,
} from "../orchestration-v2/ClaudeFormResponses.ts";
import {
  claudeElicitationCallKey,
  claudeToolServerName,
  type ClaudeMcpElicitations,
  isUnattendedClaudeTurn,
  makeClaudeMcpElicitations,
  secretFieldNotice,
  stoppedWaitingNotice,
  type ClaudeElicitationTurnContext,
  undeliveredAnswerNotice,
  UNATTENDED_MCP_ELICITATION_TIMEOUT_MS,
  unattendedTimeoutNotice,
  unreadableFormNotice,
} from "./ClaudeMcpElicitation.ts";
import { urlRefusedNotice } from "./ClaudeMcpUrlElicitation.ts";

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

// Request ids are unique per harness: a closing mark outlives its call (1493).
let harnesses = 0;

function harness(
  options: {
    thread?: "user" | "agent";
    held?: boolean;
    noTurn?: boolean;
    /** The adapter marks the call's end just after the abort (the CLI's output ended). */
    endsDuringSettle?: boolean;
    /** The settle after an abort never runs out on its own. */
    longSettle?: boolean;
    /** Counts each settle that runs out (it runs out at once). */
    countSettle?: () => void;
  } = {},
) {
  const prefix = `h${++harnesses}`;
  const events: Array<Event> = [];
  let released = 0;
  let requestCount = 0;
  const toolCalls = new Map<string, { readonly toolName: string }>();
  const context: ClaudeElicitationTurnContext = {
    input: turnInput(options.thread ?? "user"),
    providerTurnId: "provider-turn-1" as ClaudeElicitationTurnContext["providerTurnId"],
    heldRootFrames: options.held === true ? [{}] : [],
    toolCalls,
  };
  const timer = Effect.runSync(Deferred.make<void>());
  const grace = Effect.runSync(Deferred.make<void>());
  const outcomeLimit = Effect.runSync(Deferred.make<void>());
  const made: ClaudeMcpElicitations = makeClaudeMcpElicitations({
    activeTurn: Effect.succeed(options.noTurn === true ? null : context),
    buildApprovalRequestArtifacts: (input) =>
      Effect.sync(() => {
        requestCount += 1;
        const id = RuntimeRequestId.make(`${prefix}-request-${requestCount}`);
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
    abortSettle:
      options.endsDuringSettle === true
        ? Effect.suspend(() => elicitations.outputEnded).pipe(Effect.andThen(Effect.never))
        : options.longSettle === true
          ? Effect.never
          : options.countSettle !== undefined
            ? Effect.sync(options.countSettle)
            : Effect.void,
    resolveItemOrdinal: () => Effect.succeed(7),
    idAllocator: {
      derive: {
        turnItemFromProviderItem: ({ nativeItemId }: { nativeItemId: string }) => nativeItemId,
      },
    } as never,
    runPromise: Effect.runPromise,
    unattendedTimer: Deferred.await(timer),
    answerInFlightGrace: Deferred.await(grace),
    commitOutcomeLimit: Deferred.await(outcomeLimit),
  });
  // One CLI process's forms, plus the session's own calls.
  const elicitations = { ...made, ...made.forQuery() };
  const ask = (
    request: Partial<ElicitationRequest>,
    signal = new AbortController().signal,
    sdkRequestId = "sdk-request-1",
  ) =>
    elicitations.onElicitation(
      { serverName: "github", message: "Delete octo/repo?", ...request } as ElicitationRequest,
      { signal, requestId: sdkRequestId },
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
  // The thread shows one row per turn item; an update to the same item replaces it.
  const shownNotices = () => [
    ...new Map(
      events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
          ? [[String(event.turnItem.id), event.turnItem.message] as const]
          : [],
      ),
    ).values(),
  ];
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setImmediate(resolve));
    expect(check()).toBe(true);
  };
  const requestId = RuntimeRequestId.make(`${prefix}-request-1`);
  return {
    events,
    elicitations,
    made,
    ask,
    card,
    notices,
    shownNotices,
    toolCalls,
    context,
    until,
    requestId,
    prefix,
    fireTimer: () => Effect.runSync(Deferred.succeed(timer, undefined)),
    endGrace: () => Effect.runSync(Deferred.succeed(grace, undefined)),
    endOutcomeLimit: () => Effect.runSync(Deferred.succeed(outcomeLimit, undefined)),
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

  it("offers no Approve even on a form without fields, and accepts the person's Submit", async () => {
    const h = harness();
    const result = h.ask({ requestedSchema: { type: "object", properties: {} } });
    await h.until(() => h.card() !== undefined);
    expect(h.card().options?.map((option) => option.decision)).toEqual(["decline", "cancel"]);
    await Effect.runPromise(
      h.elicitations.respond({ requestId: h.requestId, decision: "accept", answers: {} }),
    );
    expect(await result).toEqual({ action: "accept", content: {} });
  });

  it("takes the person's answers from the in-process hand-off, not the redacted effect", async () => {
    const h = harness();
    const result = h.ask({ requestedSchema: confirmSchema });
    await h.until(() => h.card() !== undefined);
    handOffClaudeFormAnswers(h.requestId, { handOff: { name: "octo/repo" } });
    await Effect.runPromise(
      h.elicitations.respond({
        requestId: h.requestId,
        decision: "accept",
        answers: redactClaudeFormAnswers({ name: "octo/repo" }),
      }),
    );
    expect(await result).toEqual({ action: "accept", content: { name: "octo/repo" } });
    expect(takeClaudeFormAnswers(h.requestId)).toBeUndefined();
  });

  it("never passes a redacted summary on as the answer, even for a form without fields", async () => {
    for (const requestedSchema of [confirmSchema, { type: "object", properties: {} }]) {
      const h = harness();
      const result = h.ask({ requestedSchema });
      await h.until(() => h.card() !== undefined);
      await Effect.runPromise(
        h.elicitations.respond({
          requestId: h.requestId,
          decision: "accept",
          answers: redactClaudeFormAnswers({ name: "octo/repo" }),
        }),
      );
      expect(await result).toEqual({ action: "cancel" });
      expect(h.notices()).toEqual([
        "The answer to github's question didn't fit its form; it was cancelled.",
      ]);
    }
  });

  it("forgets a hand-off nothing took once the card closes", async () => {
    const h = harness();
    const controller = new AbortController();
    const result = h.ask({ requestedSchema: confirmSchema }, controller.signal);
    await h.until(() => h.card() !== undefined);
    handOffClaudeFormAnswers(h.requestId, { handOff: { name: "late" } });
    markClaudeFormAnswerCommitted({ type: "runtime-request.respond", requestId: h.requestId });
    controller.abort();
    h.endGrace();
    expect(await result).toEqual({ action: "cancel" });
    expect(takeClaudeFormAnswers(h.requestId)).toBeUndefined();
    expect(h.notices()).toEqual([undeliveredAnswerNotice("github")]);
  });

  it("declines a form that asks for a password or token, with a note, and shows no card", async () => {
    const h = harness();
    const result = await h.ask({
      requestedSchema: {
        type: "object",
        properties: { token: { type: "string", title: "GitHub token" } },
      },
    });
    expect(result).toEqual({ action: "decline" });
    expect(h.card()).toBeUndefined();
    expect(h.notices()).toEqual([secretFieldNotice("github", "GitHub token")]);
  });

  it("shows one URL note per tool call, however often the call retries (1495)", async () => {
    const h = harness();
    // The probe's -32042 call: three retries, each with a new request and elicitation id.
    h.toolCalls.set("toolu_open", { toolName: "mcp__github__open_link" });
    h.toolCalls.set("toolu_other", { toolName: "mcp__notion__search" });
    for (const attempt of [1, 2, 3])
      expect(
        await h.ask(
          { mode: "url", url: `ftp://example.com/sign-in?attempt=${attempt}` },
          undefined,
          `sdk-request-${attempt}`,
        ),
      ).toEqual({ action: "decline" });
    expect(h.shownNotices()).toEqual([urlRefusedNotice("github", "scheme")]);
    // Another tool call of the same server gets its own note.
    h.toolCalls.delete("toolu_open");
    h.toolCalls.set("toolu_open_again", { toolName: "mcp__github__open_link" });
    await h.ask({ mode: "url", url: "ftp://example.com/sign-in" }, undefined, "sdk-request-4");
    const refused = urlRefusedNotice("github", "scheme");
    expect(h.shownNotices()).toEqual([refused, refused]);
  });

  it("finds the tool call by the CLI's tool-name form of the server name", () => {
    const h = harness();
    h.toolCalls.set("toolu_gmail", { toolName: "mcp__claude_ai_Gmail__search_threads" });
    expect(claudeElicitationCallKey(h.context, "claude.ai Gmail", "r1")).toBe(
      "claude.ai Gmail:call:toolu_gmail",
    );
    // Claude Code folds runs of `_` in claude.ai names: "Docs: Search" is Docs_Search.
    expect(claudeToolServerName("claude.ai Docs: Search")).toBe("claude_ai_Docs_Search");
    expect(claudeToolServerName("my.server: v2")).toBe("my_server__v2");
    h.toolCalls.set("toolu_docs", { toolName: "mcp__claude_ai_Docs_Search__query" });
    expect(claudeElicitationCallKey(h.context, "claude.ai Docs: Search", "r1")).toBe(
      "claude.ai Docs: Search:call:toolu_docs",
    );
    // No single running call of that server: the request keys itself.
    expect(claudeElicitationCallKey(h.context, "github", "r1")).toBe("github:request:r1");
    h.toolCalls.set("toolu_gmail_2", { toolName: "mcp__claude_ai_Gmail__get_thread" });
    expect(claudeElicitationCallKey(h.context, "claude.ai Gmail", "r2")).toBe(
      "claude.ai Gmail:request:r2",
    );
  });

  it("keeps one note per request when two calls of a server run at once", async () => {
    const h = harness();
    h.toolCalls.set("toolu_a", { toolName: "mcp__github__open_link" });
    h.toolCalls.set("toolu_b", { toolName: "mcp__github__open_link" });
    await h.ask({ mode: "url", url: "ftp://example.com/a" }, undefined, "sdk-request-a");
    await h.ask({ mode: "url", url: "ftp://example.com/b" }, undefined, "sdk-request-b");
    const refused = urlRefusedNotice("github", "scheme");
    expect(h.shownNotices()).toEqual([refused, refused]);
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
    // The adapter marks the open cards before its Stop interrupts the CLI.
    await Effect.runPromise(h.elicitations.endedHere);
    controller.abort();
    expect(await result).toEqual({ action: "cancel" });
    const closed = h.events.filter(
      (event) =>
        (event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled") ||
        (event.type === "node.updated" && event.node.status === "cancelled") ||
        (event.type === "turn_item.updated" && event.turnItem.status === "cancelled"),
    );
    expect(closed).toHaveLength(3);
    // The person stopped the turn; no note says the server gave up.
    expect(h.notices()).toEqual([]);
    // A late answer to the closed card is taken and ignored.
    expect(
      await Effect.runPromise(
        h.elicitations.respond({ requestId: h.requestId, decision: "accept" }),
      ),
    ).toBe(true);
  });

  it("closes the card and says so when the server stops waiting on its own (1495)", async () => {
    const h = harness();
    const controller = new AbortController();
    const result = h.ask({ requestedSchema: confirmSchema }, controller.signal);
    await h.until(() => h.card() !== undefined);
    // The probe's legacy server cancels its request after 60 s; the SDK aborts.
    controller.abort();
    expect(await result).toEqual({ action: "cancel" });
    expect(
      h.events.filter(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
      ),
    ).toHaveLength(1);
    expect(h.notices()).toEqual([stoppedWaitingNotice("github")]);
    expect(stoppedWaitingNotice("github")).toBe("github stopped waiting for an answer.");
  });

  it("marks only the cards open at the adapter's end of their calls (1495)", async () => {
    const h = harness();
    // A steer ends the first form's call; Claude goes on in the same turn.
    const first = new AbortController();
    const firstResult = h.ask({ requestedSchema: confirmSchema }, first.signal, "sdk-request-1");
    await h.until(() => h.card() !== undefined);
    await Effect.runPromise(h.elicitations.endedHere);
    first.abort();
    expect(await firstResult).toEqual({ action: "cancel" });
    expect(h.notices()).toEqual([]);
    // A new form in the steered turn hits the server's timeout: the note shows.
    const second = new AbortController();
    const secondResult = h.ask({ requestedSchema: confirmSchema }, second.signal, "sdk-request-2");
    await h.until(
      () => h.events.filter((event) => event.type === "runtime_request.updated").length === 3,
    );
    second.abort();
    expect(await secondResult).toEqual({ action: "cancel" });
    expect(h.notices()).toEqual([stoppedWaitingNotice("github")]);
  });

  it("marks only the cards of the process the adapter ends (1495)", async () => {
    const h = harness();
    const old = h.elicitations;
    // A replacement process opened; its form waits while the old output ends.
    const replacement = h.made.forQuery();
    const controller = new AbortController();
    const result = replacement.onElicitation(
      {
        serverName: "github",
        message: "Delete octo/repo?",
        requestedSchema: confirmSchema,
      } as never,
      { signal: controller.signal, requestId: "sdk-request-new" },
    );
    await h.until(() => h.card() !== undefined);
    await Effect.runPromise(old.outputEnded);
    controller.abort();
    expect(await result).toEqual({ action: "cancel" });
    expect(h.notices()).toEqual([stoppedWaitingNotice("github")]);
  });

  it("keeps the server's cause when a Stop lands after the server already gave up (1495)", async () => {
    const h = harness({ longSettle: true });
    const controller = new AbortController();
    const result = h.ask({ requestedSchema: confirmSchema }, controller.signal);
    await h.until(() => h.card() !== undefined);
    controller.abort();
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    // The person presses Stop inside the settle; the turn then ends.
    await Effect.runPromise(h.elicitations.endedHere);
    await Effect.runPromise(h.elicitations.settleAborted);
    expect(await result).toEqual({ action: "cancel" });
    expect(h.notices()).toEqual([stoppedWaitingNotice("github")]);
  });

  it("keeps the server's cause when Stop then closes the CLI's output (1495)", async () => {
    const h = harness({ longSettle: true });
    const controller = new AbortController();
    const result = h.ask({ requestedSchema: confirmSchema }, controller.signal);
    await h.until(() => h.card() !== undefined);
    controller.abort();
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    // Stop marks, then its close ends the output, before the turn ends.
    await Effect.runPromise(h.elicitations.endedHere);
    await Effect.runPromise(h.elicitations.outputEnded);
    await Effect.runPromise(h.elicitations.settleAborted);
    expect(await result).toEqual({ action: "cancel" });
    expect(h.notices()).toEqual([stoppedWaitingNotice("github")]);
  });

  it("ends the grace when the answer's commit fails, so the note comes before the turn's end (1495)", async () => {
    const h = harness();
    const controller = new AbortController();
    const result = h.ask({ requestedSchema: confirmSchema }, controller.signal);
    await h.until(() => h.card() !== undefined);
    handOffClaudeFormAnswers(h.requestId, { handOff: { name: "octo/repo" } });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    forgetUncommittedFormAnswer({ type: "runtime-request.respond", requestId: h.requestId });
    // The grace never runs out here: the failed commit alone ends the wait.
    await Effect.runPromise(h.elicitations.settleAborted);
    expect(h.notices()).toEqual([stoppedWaitingNotice("github")]);
    expect(await result).toEqual({ action: "cancel" });
  });

  it("waits once, not per card, for the notes of several aborted forms (1495)", async () => {
    let settles = 0;
    const h = harness({ countSettle: () => (settles += 1) });
    const asks = [1, 2, 3].map((n) => {
      const controller = new AbortController();
      handOffClaudeFormAnswers(RuntimeRequestId.make(`${h.prefix}-request-${n}`), {
        handOff: { name: "octo/repo" },
      });
      return {
        controller,
        result: h.ask({ requestedSchema: confirmSchema }, controller.signal, `sdk-${n}`),
      };
    });
    await h.until(
      () => h.events.filter((event) => event.type === "runtime_request.updated").length === 3,
    );
    for (const { controller } of asks) controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    // Every commit is still running: the turn's end waits out one shared settle.
    settles = 0;
    await Effect.runPromise(h.elicitations.settleAborted);
    expect(settles).toBe(1);
    for (const n of [1, 2, 3])
      forgetUncommittedFormAnswer({
        type: "runtime-request.respond",
        requestId: RuntimeRequestId.make(`${h.prefix}-request-${n}`),
      });
    for (const { result } of asks) expect(await result).toEqual({ action: "cancel" });
  });

  it("shows the server's note before the turn ends, when the turn finishes inside the settle (1495)", async () => {
    const h = harness({ longSettle: true });
    const controller = new AbortController();
    let ended = false;
    const result = h.ask({ requestedSchema: confirmSchema }, controller.signal).finally(() => {
      ended = true;
    });
    await h.until(() => h.card() !== undefined);
    // The server's 60 s timeout; Claude handles the tool error and finishes at once.
    controller.abort();
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(ended).toBe(false);
    await Effect.runPromise(h.elicitations.settleAborted);
    expect(h.notices()).toEqual([stoppedWaitingNotice("github")]);
    expect(await result).toEqual({ action: "cancel" });
  });

  it("shows no note when the turn's end reaches the adapter just after the abort (1495)", async () => {
    // The CLI exited: the SDK aborts its requests before the adapter ends the turn.
    const h = harness({ endsDuringSettle: true });
    const controller = new AbortController();
    const result = h.ask({ requestedSchema: confirmSchema }, controller.signal);
    await h.until(() => h.card() !== undefined);
    controller.abort();
    expect(await result).toEqual({ action: "cancel" });
    expect(h.notices()).toEqual([]);
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
      "No one answered github's question in 5 minutes; it was cancelled.",
    );
    // Shorter than the HTTP stream drop the 1495 probe measured (about 356 s).
    expect(UNATTENDED_MCP_ELICITATION_TIMEOUT_MS).toBe(5 * 60 * 1_000);
  });

  it("refuses an answer that comes in after the timer began closing the card (1493)", async () => {
    const h = harness({ thread: "agent" });
    const result = h.ask({ requestedSchema: confirmSchema });
    await h.until(() => h.card() !== undefined);
    h.fireTimer();
    expect(await result).toEqual({ action: "cancel" });
    // A Submit recorded now would be overwritten by the cancelled card.
    expect(handOffClaudeFormAnswers(h.requestId, { handOff: { name: "octo/repo" } })).toBe(false);
    expect(takeClaudeFormAnswers(h.requestId)).toBeUndefined();
    expect(
      h.events.some(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
      ),
    ).toBe(true);
  });

  it("waits for an answer the app recorded when the timer fires before it arrives", async () => {
    const h = harness({ thread: "agent" });
    const result = h.ask({ requestedSchema: confirmSchema });
    await h.until(() => h.card() !== undefined);
    // The orchestrator recorded Submit; its delivery is still queued.
    handOffClaudeFormAnswers(h.requestId, { handOff: { name: "octo/repo" } });
    h.fireTimer();
    await new Promise((resolve) => setImmediate(resolve));
    await Effect.runPromise(
      h.elicitations.respond({
        requestId: h.requestId,
        decision: "accept",
        answers: redactClaudeFormAnswers({ name: "octo/repo" }),
      }),
    );
    expect(await result).toEqual({ action: "accept", content: { name: "octo/repo" } });
    expect(h.notices()).toEqual([]);
    expect(
      h.events.some(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
      ),
    ).toBe(false);
  });

  it("never overwrites a recorded answer as cancelled", async () => {
    // Stop while the answer is on its way: the answer still goes through.
    const stopped = harness();
    const controller = new AbortController();
    const first = stopped.ask({ requestedSchema: confirmSchema }, controller.signal);
    await stopped.until(() => stopped.card() !== undefined);
    handOffClaudeFormAnswers(stopped.requestId, { handOff: { name: "octo/repo" } });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    await Effect.runPromise(
      stopped.elicitations.respond({
        requestId: stopped.requestId,
        decision: "accept",
        answers: redactClaudeFormAnswers({ name: "octo/repo" }),
      }),
    );
    expect(await first).toEqual({ action: "accept", content: { name: "octo/repo" } });
    // The timer and its grace both run out before the answer arrives.
    const lost = harness({ thread: "agent" });
    const second = lost.ask({ requestedSchema: confirmSchema });
    await lost.until(() => lost.card() !== undefined);
    handOffClaudeFormAnswers(lost.requestId, { handOff: { name: "octo/repo" } });
    markClaudeFormAnswerCommitted({ type: "runtime-request.respond", requestId: lost.requestId });
    lost.fireTimer();
    lost.endGrace();
    expect(await second).toEqual({ action: "cancel" });
    expect(lost.notices()).toEqual([undeliveredAnswerNotice("github")]);
    for (const h of [stopped, lost])
      expect(
        h.events.filter(
          (event) =>
            (event.type === "runtime_request.updated" &&
              event.runtimeRequest.status === "cancelled") ||
            (event.type === "turn_item.updated" && event.turnItem.status === "cancelled"),
        ),
      ).toEqual([]);
  });

  it("closes the card when the answer's commit failed during the wait (1493)", async () => {
    const h = harness();
    const controller = new AbortController();
    const result = h.ask({ requestedSchema: confirmSchema }, controller.signal);
    await h.until(() => h.card() !== undefined);
    handOffClaudeFormAnswers(h.requestId, { handOff: { name: "octo/repo" } });
    controller.abort();
    await new Promise((resolve) => setImmediate(resolve));
    // The commit of that answer fails: nothing was recorded.
    forgetUncommittedFormAnswer({ type: "runtime-request.respond", requestId: h.requestId });
    h.endGrace();
    expect(await result).toEqual({ action: "cancel" });
    // The server gave up and no answer was recorded: AC-02's note, not D-11's (1495).
    expect(h.notices()).toEqual([stoppedWaitingNotice("github")]);
    expect(
      h.events.filter(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
      ),
    ).toHaveLength(1);
    expect(handOffClaudeFormAnswers(h.requestId, { handOff: { name: "late" } })).toBe(false);
  });

  it("waits past the grace for a commit still running, and closes the card if it fails (1493)", async () => {
    const h = harness({ thread: "agent" });
    let ended = false;
    const result = h.ask({ requestedSchema: confirmSchema }).finally(() => (ended = true));
    await h.until(() => h.card() !== undefined);
    handOffClaudeFormAnswers(h.requestId, { handOff: { name: "octo/repo" } });
    h.fireTimer();
    h.endGrace();
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    // The commit is still running: the call waits, so its events still land.
    expect(ended).toBe(false);
    forgetUncommittedFormAnswer({ type: "runtime-request.respond", requestId: h.requestId });
    // A Submit queued behind the failed commit is refused before the call wakes.
    expect(handOffClaudeFormAnswers(h.requestId, { handOff: { name: "late" } })).toBe(false);
    expect(await result).toEqual({ action: "cancel" });
    expect(h.notices()).toEqual([undeliveredAnswerNotice("github")]);
    expect(
      h.events.filter(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
      ),
    ).toHaveLength(1);
  });

  it("ends a call whose commit never settles, leaving the card as the record says (1493)", async () => {
    const h = harness({ thread: "agent" });
    const result = h.ask({ requestedSchema: confirmSchema });
    await h.until(() => h.card() !== undefined);
    handOffClaudeFormAnswers(h.requestId, { handOff: { name: "octo/repo" } });
    h.fireTimer();
    h.endGrace();
    h.endOutcomeLimit();
    expect(await result).toEqual({ action: "cancel" });
    expect(h.notices()).toEqual([undeliveredAnswerNotice("github")]);
    expect(
      h.events.some(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
      ),
    ).toBe(false);
  });

  it("leaves the record alone when a commit still running past the grace succeeds (1493)", async () => {
    const h = harness({ thread: "agent" });
    const result = h.ask({ requestedSchema: confirmSchema });
    await h.until(() => h.card() !== undefined);
    handOffClaudeFormAnswers(h.requestId, { handOff: { name: "octo/repo" } });
    h.fireTimer();
    h.endGrace();
    await new Promise((resolve) => setImmediate(resolve));
    markClaudeFormAnswerCommitted({ type: "runtime-request.respond", requestId: h.requestId });
    expect(await result).toEqual({ action: "cancel" });
    expect(h.notices()).toEqual([undeliveredAnswerNotice("github")]);
    expect(
      h.events.some(
        (event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
      ),
    ).toBe(false);
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
