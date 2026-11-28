import type { ElicitationRequest } from "@anthropic-ai/claude-agent-sdk";
import { RuntimeRequestId } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type * as ProviderAdapter from "../orchestration-v2/ProviderAdapter.ts";
import {
  type ClaudeElicitationTurnContext,
  type ClaudeMcpElicitations,
  makeClaudeMcpElicitations,
  stoppedWaitingNotice,
} from "./ClaudeMcpElicitation.ts";
import {
  planClaudeUrlElicitation,
  urlElicitationResult,
  urlRefusedNotice,
  urlUnattendedNotice,
} from "./ClaudeMcpUrlElicitation.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;

// Request ids are unique per harness: a closing mark outlives its call (1493).
let harnesses = 0;

function harness(options: { thread?: "user" | "agent"; scheduled?: boolean } = {}) {
  const prefix = `url${++harnesses}`;
  const events: Array<Event> = [];
  let requestCount = 0;
  const toolCalls = new Map<string, { readonly toolName: string }>();
  const context: ClaudeElicitationTurnContext = {
    input: {
      appThread: { createdBy: options.thread ?? "user" },
      threadId: "thread-1",
      runId: "run-1",
      rootNodeId: "node-root",
      providerThread: { id: "provider-thread-1" },
      message: {
        createdBy: "user",
        ...(options.scheduled === true ? { scheduledTaskId: "routine-1" } : {}),
      },
    } as unknown as ProviderAdapter.ProviderAdapterV2TurnInput,
    providerTurnId: "provider-turn-1" as ClaudeElicitationTurnContext["providerTurnId"],
    heldRootFrames: [],
    toolCalls,
  };
  const made: ClaudeMcpElicitations = makeClaudeMcpElicitations({
    activeTurn: Effect.succeed(context),
    buildApprovalRequestArtifacts: (input) =>
      Effect.sync(() => {
        requestCount += 1;
        const id = RuntimeRequestId.make(`${prefix}-request-${requestCount}`);
        return {
          node: { id: `node-request-${requestCount}`, parentNodeId: "x", status: "waiting" },
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
    releaseHeldRootFrames: () => Effect.void,
    abortSettle: Effect.void,
    resolveItemOrdinal: () => Effect.succeed(7),
    idAllocator: {
      derive: {
        turnItemFromProviderItem: ({ nativeItemId }: { nativeItemId: string }) => nativeItemId,
      },
    } as never,
    runPromise: Effect.runPromise,
    unattendedTimer: Effect.never,
    answerInFlightGrace: Effect.never,
    commitOutcomeLimit: Effect.never,
  });
  const forms = made.forQuery();
  const ask = (
    request: Partial<ElicitationRequest>,
    signal = new AbortController().signal,
    sdkRequestId = "sdk-request-1",
  ) =>
    forms.onElicitation(
      {
        serverName: "github",
        message: "Sign in to GitHub to continue.",
        mode: "url",
        ...request,
      } as ElicitationRequest,
      { signal, requestId: sdkRequestId },
    );
  type Card = Extract<Event, { type: "turn_item.updated" }>["turnItem"] & {
    readonly elicitation?: unknown;
    readonly options?: ReadonlyArray<{ decision: string }>;
    readonly appName?: string;
    readonly requestId?: string;
  };
  const cards = () => [
    ...new Map(
      events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "approval_request"
          ? [[String(event.turnItem.id), event.turnItem as Card] as const]
          : [],
      ),
    ).values(),
  ];
  const notices = () => [
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
  const press = (n: number, decision: "accept" | "decline" | "cancel") =>
    Effect.runPromise(
      made.respond({ requestId: RuntimeRequestId.make(`${prefix}-request-${n}`), decision }),
    );
  return { events, forms, ask, cards, notices, until, press, toolCalls };
}

const SIGN_IN = "https://github.com/login/device?code=ABCD";

describe("ClaudeMcpUrlElicitation", () => {
  it("shows the link on a card that only the person can accept", async () => {
    const h = harness();
    const result = h.ask({ url: SIGN_IN, elicitationId: "elicit-1" });
    await h.until(() => h.cards().length === 1);
    const card = h.cards()[0]!;
    expect(card.appName).toBe("github");
    // Exactly what the server sent: no elicitation id, token or sign-in added.
    expect(card.elicitation).toEqual({
      serverName: "github",
      mode: "url",
      message: "Sign in to GitHub to continue.",
      url: SIGN_IN,
    });
    // "I'm done, continue" lives on the link card only, so Full access never presses it.
    expect(card.options?.map((option) => option.decision)).toEqual(["decline", "cancel"]);
    expect(await h.press(1, "accept")).toBe(true);
    expect(await result).toEqual({ action: "accept" });
  });

  it("maps Decline and Cancel", async () => {
    for (const decision of ["decline", "cancel"] as const) {
      const h = harness();
      const result = h.ask({ url: SIGN_IN });
      await h.until(() => h.cards().length === 1);
      await h.press(1, decision);
      expect(await result).toEqual({ action: decision });
    }
    expect(urlElicitationResult("acceptForSession")).toEqual({ action: "accept" });
  });

  it("declines a link that is not a web link or hides user info, with a note and no card", async () => {
    for (const [url, reason] of [
      ["javascript:alert(1)", "scheme"],
      ["file:///etc/passwd", "scheme"],
      ["https://github.com@evil.example/login", "user-info"],
      ["https://user:pass@example.com/", "user-info"],
      [undefined, "unparseable"],
    ] as const) {
      const h = harness();
      expect(await h.ask({ ...(url === undefined ? {} : { url }) })).toEqual({
        action: "decline",
      });
      expect(h.cards()).toEqual([]);
      expect(h.notices()).toEqual([urlRefusedNotice("github", reason)]);
      // The refused link itself is never written to the thread.
      if (url !== undefined) expect(JSON.stringify(h.events)).not.toContain(url);
    }
  });

  it("shows a warned link on a card, unchanged, and leaves the warning to the card", () => {
    for (const url of [
      "http://example.com/sign-in",
      "https://xn--80ak6aa92e.com/Login?next=%2Fhome",
      "http://localhost:3000/callback",
    ]) {
      const plan = planClaudeUrlElicitation(
        { serverName: "s", message: "m", mode: "url", url },
        { unattended: false, remembered: undefined },
      );
      expect(plan).toEqual({
        type: "card",
        elicitation: { serverName: "s", mode: "url", message: "m", url },
      });
    }
  });

  it("declines a link in a thread that runs without the person, with a note", async () => {
    for (const options of [{ thread: "agent" as const }, { scheduled: true }]) {
      const h = harness(options);
      expect(await h.ask({ url: SIGN_IN })).toEqual({ action: "decline" });
      expect(h.cards()).toEqual([]);
      expect(h.notices()).toEqual([urlUnattendedNotice("github")]);
    }
  });

  it("shows one card per tool call: a -32042 retry gets the person's answer again", async () => {
    const h = harness();
    h.toolCalls.set("toolu_sign_in", { toolName: "mcp__github__create_issue" });
    h.toolCalls.set("toolu_other", { toolName: "mcp__notion__search" });
    const first = h.ask({ url: `${SIGN_IN}&attempt=1` }, undefined, "sdk-request-1");
    await h.until(() => h.cards().length === 1);
    await h.press(1, "accept");
    expect(await first).toEqual({ action: "accept" });
    // Claude Code retries the call; each retry has a new request and elicitation id.
    for (const attempt of [2, 3])
      expect(
        await h.ask({ url: `${SIGN_IN}&attempt=${attempt}` }, undefined, `sdk-request-${attempt}`),
      ).toEqual({ action: "accept" });
    expect(h.cards()).toHaveLength(1);
    // Another call of the same server asks the person again.
    h.toolCalls.delete("toolu_sign_in");
    h.toolCalls.set("toolu_again", { toolName: "mcp__github__create_issue" });
    const again = h.ask({ url: SIGN_IN }, undefined, "sdk-request-4");
    await h.until(() => h.cards().length === 2);
    await h.press(2, "decline");
    expect(await again).toEqual({ action: "decline" });
  });

  it("asks again after a stop: a stop is no answer", async () => {
    const h = harness();
    const controller = new AbortController();
    h.toolCalls.set("toolu_sign_in", { toolName: "mcp__github__create_issue" });
    const stopped = h.ask({ url: SIGN_IN }, controller.signal, "sdk-request-1");
    await h.until(() => h.cards().length === 1);
    // Stop: the adapter marks the end, then the SDK aborts.
    await Effect.runPromise(h.forms.endedHere);
    controller.abort();
    expect(await stopped).toEqual({ action: "cancel" });
    expect(h.cards()[0]?.status).toBe("cancelled");
    expect(h.notices()).toEqual([]);
    // A stop is no answer: the same call's next request shows a card again.
    const next = h.ask({ url: SIGN_IN }, undefined, "sdk-request-2");
    await h.until(() => h.cards().length === 2);
    await h.press(2, "cancel");
    expect(await next).toEqual({ action: "cancel" });
  });

  it("closes the card with a note when the server stops waiting", async () => {
    const h = harness();
    const controller = new AbortController();
    const result = h.ask({ url: SIGN_IN }, controller.signal);
    await h.until(() => h.cards().length === 1);
    controller.abort();
    expect(await result).toEqual({ action: "cancel" });
    expect(h.cards()[0]?.status).toBe("cancelled");
    expect(h.notices()).toEqual([stoppedWaitingNotice("github")]);
  });
});
