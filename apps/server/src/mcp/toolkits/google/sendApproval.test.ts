import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Google from "../../../integrations/google/GoogleAccountService.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { draftQuestionId, sendQuestions, sendRefusal, sendRequestId } from "./sendApproval.ts";
import { GoogleToolkit } from "./tools.ts";

const EPOCH = DateTime.makeUnsafe("2026-11-03T08:00:00.000Z");
const caller = liveThreadShell(ThreadId.make("briefing-thread"));
const card = sendRequestId(caller.id, ["d1", "d2"]);

const request = (
  id: string,
  status: "pending" | "resolved" | "cancelled",
  answers?: Record<string, unknown>,
) => ({
  id: RuntimeRequestId.make(id),
  kind: "user_input" as const,
  status,
  ...(answers === undefined ? {} : { answers }),
});

describe("sendRefusal", () => {
  const base = { threadId: caller.id, approvalRequestId: card, draftId: "d1" };

  it("allows a draft answered Send on this thread's card", () => {
    expect(
      sendRefusal({
        ...base,
        requests: [request(card, "resolved", { [draftQuestionId("d1")]: "Send" })],
      }),
    ).toBeNull();
    // A card an update reopened carries a prefixed id; the reopened answer counts.
    expect(
      sendRefusal({
        ...base,
        requests: [
          request(card, "cancelled"),
          request(`update-reopen:${card}`, "resolved", { [draftQuestionId("d1")]: ["Send"] }),
        ],
      }),
    ).toBeNull();
  });

  it.each([
    ["an unanswered card", [request(card, "pending")], /not answered/u],
    [
      "Don't send",
      [request(card, "resolved", { [draftQuestionId("d1")]: "Don't send" })],
      /did not choose Send/u,
    ],
    [
      "a typed answer",
      [request(card, "resolved", { [draftQuestionId("d1")]: "Send it but say Friday" })],
      /did not choose Send/u,
    ],
    [
      "Send for a different draft",
      [request(card, "resolved", { [draftQuestionId("d2")]: "Send" })],
      /no answer for that draft/u,
    ],
    ["no card at all", [], /not found/u],
  ])("refuses %s", (_name, requests, message) => {
    expect(sendRefusal({ ...base, requests })).toMatch(message);
  });

  it("refuses a card from another thread or an ordinary question", () => {
    const other = sendRequestId(ThreadId.make("someone-else"), ["d1"]);
    expect(
      sendRefusal({
        ...base,
        approvalRequestId: other,
        requests: [request(other, "resolved", { [draftQuestionId("d1")]: "Send" })],
      }),
    ).toMatch(/not a reply card from this thread/u);
    expect(
      sendRefusal({
        ...base,
        approvalRequestId: "ask-user:briefing-thread:x",
        requests: [
          request("ask-user:briefing-thread:x", "resolved", { [draftQuestionId("d1")]: "Send" }),
        ],
      }),
    ).toMatch(/not a reply card/u);
  });

  it("asks one Send or Don't send question per draft with the reply as Gmail holds it", () => {
    const [question] = sendQuestions([
      { draftId: "d1", to: "Dana <dana@example.com>", subject: "Re: Lunch", body: "Friday works." },
    ]);
    expect(question).toMatchObject({
      id: "draft:d1",
      header: "Reply to Dana <dana@example.com>",
      question: "Re: Lunch\n\nFriday works.",
      allowCustomAnswer: true,
    });
    expect(question?.options.map((option) => option.label)).toEqual(["Send", "Don't send"]);
  });
});

const scope: Context.McpInvocationScope = {
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  thread: {
    threadId: caller.id,
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const fixture = (requests: ReadonlyArray<ReturnType<typeof request>>) => {
  const sent: string[] = [];
  const dispatched: unknown[] = [];
  const deps = Layer.mergeAll(
    Layer.mock(Google.GoogleAccountService)({
      gmailDraft: (_projectId, draftId) =>
        Effect.succeed({
          draftId,
          messageId: `m-${draftId}`,
          threadId: "t1",
          to: "dana@example.com",
          subject: "Re: Lunch",
          body: `Reply ${draftId}`,
        }),
      gmailSendDraft: (_projectId, draftId) =>
        Effect.sync(() => {
          sent.push(draftId);
          return { sent: true as const, messageId: "sent-1", threadId: "t1" };
        }),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(caller),
      getThreadRecords: () =>
        Effect.succeed({
          thread: caller,
          runs: [
            {
              id: RunId.make("run:mcp-test"),
              ordinal: 1,
              status: "running",
              rootNodeId: NodeId.make("node:root"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              activeAttemptId: null,
              createdAt: EPOCH,
            },
          ],
          runtimeRequests: requests,
        } as never),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: 1 } as never;
        }),
    }),
    Layer.succeed(Context.McpInvocationContext, scope),
  );
  return {
    sent,
    dispatched,
    layer: Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(deps)),
  };
};

const call = (
  name: "studio_google_gmail_propose_send" | "studio_google_gmail_send_draft",
  params: unknown,
) =>
  Effect.gen(function* () {
    const toolkit = yield* GoogleToolkit;
    const result = yield* toolkit
      .handle(name as "studio_google_gmail_send_draft", params as never)
      .pipe(Stream.unwrap, Stream.runCollect);
    return result.at(-1)?.result as Record<string, unknown>;
  });

it.effect("shows one reply card in the calling thread with each draft from Gmail", () => {
  const f = fixture([]);
  return Effect.gen(function* () {
    const result = yield* call("studio_google_gmail_propose_send", { draftIds: ["d1", "d2"] });
    expect(result).toMatchObject({ approvalRequestId: card, status: "asked" });
    expect(f.dispatched).toHaveLength(1);
    expect(f.dispatched[0]).toMatchObject({
      type: "user_input_request.record",
      threadId: caller.id,
      requestId: card,
      questions: [
        { id: "draft:d1", question: "Re: Lunch\n\nReply d1" },
        { id: "draft:d2", question: "Re: Lunch\n\nReply d2" },
      ],
    });
    expect(f.sent).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("sends a draft only after the person chose Send for it", () => {
  const f = fixture([request(card, "resolved", { "draft:d1": "Send", "draft:d2": "Don't send" })]);
  return Effect.gen(function* () {
    const sent = yield* call("studio_google_gmail_send_draft", {
      draftId: "d1",
      approvalRequestId: card,
    });
    expect(sent).toMatchObject({ sent: true });
    const refused = yield* call("studio_google_gmail_send_draft", {
      draftId: "d2",
      approvalRequestId: card,
    });
    expect(refused).toMatchObject({ code: "capability_denied" });
    expect(f.sent).toEqual(["d1"]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("sends nothing while the card waits for an answer", () => {
  const f = fixture([request(card, "pending")]);
  return Effect.gen(function* () {
    const refused = yield* call("studio_google_gmail_send_draft", {
      draftId: "d1",
      approvalRequestId: card,
    });
    expect(refused).toMatchObject({ code: "capability_denied" });
    expect(f.sent).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});
