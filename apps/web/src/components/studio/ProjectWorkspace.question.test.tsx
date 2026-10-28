// @vitest-environment jsdom
import { act } from "react";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { QUESTION_ALREADY_SETTLED } from "../../studio/coordinatorQuestionAnswers";
import { getProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import {
  state,
  container,
  render,
  prompt,
  paste,
  png,
  alertText,
} from "./ProjectWorkspace.test-fixtures";

const requestId = "ask-user:binding";
/** The coordinator asked with ask_user: a pending message-mode request and its card. */
function ask() {
  const now = DateTime.makeUnsafe(Date.parse("2026-10-23T12:00:00Z"));
  state.runtimeRequests = [
    {
      id: requestId,
      kind: "user_input",
      status: "pending",
      responseCapability: { type: "message" },
      createdAt: now,
    },
  ];
  state.turnItems = [
    {
      type: "user_input_request",
      threadId: "coord",
      requestId,
      responseMode: "message",
      runId: "run-1",
      ordinal: 1,
      status: "waiting",
      questions: [
        {
          id: "q1",
          header: "App binding",
          question: "Which repository binding should the app use?",
          options: [{ label: "Registered binding", description: "The project's own" }],
          allowCustomAnswer: true,
        },
      ],
    } as never,
  ];
}
const send = () =>
  act(async () =>
    container.querySelector<HTMLButtonElement>("[aria-label='Send to coordinator']")!.click(),
  );

describe("answering the coordinator's question from the message box", () => {
  it("shows the question above the box, named as the coordinator's", async () => {
    ask();
    await render();
    const card = container.querySelector("[data-coordinator-question]")!;
    expect(card.getAttribute("aria-label")).toBe("Question from the coordinator");
    expect(card.textContent).toContain("Coordinator asks");
    expect(card.textContent).toContain("Which repository binding should the app use?");
    expect(container.querySelector("label[for='project-prompt']")!.textContent).toBe(
      "Your answer to the coordinator's question",
    );
  });

  it("sends what was typed and pasted as the answer, in chat", async () => {
    ask();
    await render();
    await paste([png()]);
    await prompt("Use the registered binding");
    await send();
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.send.mock.calls[0]![0].input).toMatchObject({
      threadId: "coord",
      requestId,
      answers: { q1: "Use the registered binding" },
      attachmentsByQuestionId: {
        q1: [{ type: "image", id: "pending-0", name: "shot.png", mimeType: "image/png" }],
      },
      answeredInChat: true,
    });
    expect(String(state.send.mock.calls[0]![0].input.commandId)).toMatch(
      /^answer:ask-user:binding:/,
    );
    expect(getProjectCoordinatorComposer("host", "project").getSnapshot().prompt).toBe("");
    expect(container.querySelector(".sws-attachments")).toBeNull();
  });

  it("keeps the words and the image, and says why, when the question was settled first", async () => {
    ask();
    await render();
    // The fixture squashes a failure to its `error`, as the real runtime squashes the cause.
    const refusal = new Error(`Runtime request ${requestId} is resolved.`);
    state.send.mockResolvedValueOnce({
      ...AsyncResult.failure(Cause.fail(refusal)),
      error: refusal,
    });
    await paste([png()]);
    await prompt("Use the registered binding");
    await send();
    expect(alertText()).toContain(QUESTION_ALREADY_SETTLED);
    expect(getProjectCoordinatorComposer("host", "project").getSnapshot().prompt).toBe(
      "Use the registered binding",
    );
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
  });

  it("keeps the draft and says why when the host cannot take files with an answer", async () => {
    ask();
    state.questionAttachments = false;
    await render();
    await paste([png()]);
    await prompt("Use the registered binding");
    await send();
    expect(state.send).not.toHaveBeenCalled();
    expect(alertText()).not.toBe("");
    expect(getProjectCoordinatorComposer("host", "project").getSnapshot().prompt).toBe(
      "Use the registered binding",
    );
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
  });

  it("sends a plain message when no question waits", async () => {
    await render();
    expect(container.querySelector("[data-coordinator-question]")).toBeNull();
    await prompt("Status?");
    await send();
    expect(state.send.mock.calls[0]![0].input).toMatchObject({ prompt: "Status?" });
    expect(state.send.mock.calls[0]![0].input.answeredInChat).toBeUndefined();
  });
});

describe("an answered coordinator question in the conversation", () => {
  const answered = (answeredInChat: boolean) => {
    const at = DateTime.makeUnsafe(Date.parse("2026-10-23T12:01:00Z"));
    state.turnItems = [
      {
        type: "user_input_request",
        threadId: "coord",
        requestId,
        responseMode: "message",
        runId: "run-1",
        ordinal: 1,
        status: "completed",
        updatedAt: at,
        completedAt: at,
        questions: [
          {
            id: "q1",
            header: "App binding",
            question: "Which repository binding should the app use?",
            options: [{ label: "Registered binding", description: "The project's own" }],
          },
        ],
        questionAnswer: {
          requestId,
          answers: { q1: answeredInChat ? "Use the registered one" : "Registered binding" },
          attachmentsByQuestionId: {},
          ...(answeredInChat ? { answeredInChat: true } : {}),
        },
      } as never,
    ];
    state.messages = [
      {
        id: `async-answer:${requestId}`,
        role: "user",
        createdBy: "user",
        text: answeredInChat ? "Use the registered one" : "Registered binding",
        createdAt: at,
        streaming: false,
        attachments: [],
      },
    ];
  };

  it("folds an answer sent from the card into a decision the coordinator asked for", async () => {
    answered(false);
    await render();
    const decision = container.querySelector("[data-coordinator-decision]")!;
    expect(decision.querySelector("section")!.getAttribute("aria-label")).toBe(
      "Decision on a question from Coordinator",
    );
    expect(decision.textContent).toContain("Registered binding");
    expect(container.querySelectorAll(".project-message-user")).toHaveLength(0);
  });

  it("keeps a reply typed in chat as the person's own message after the decision", async () => {
    answered(true);
    await render();
    const decision = container.querySelector("[data-coordinator-decision]")!;
    expect(decision.textContent).toContain("Answered in chat");
    const bubbles = container.querySelectorAll(".project-message-user");
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]!.textContent).toContain("Use the registered one");
    expect(bubbles[0]!.textContent).not.toContain("Which repository binding");
    expect(
      decision.compareDocumentPosition(bubbles[0]!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

it("removes an answered restored question on reconnect and preserves a different open question", async () => {
  ask();
  const original = {
    ...(state.runtimeRequests[0] as object),
    id: requestId,
    status: "resolved",
    answers: { q1: "Use registered binding" },
  };
  state.runtimeRequests = [
    original,
    { ...(state.runtimeRequests[0] as object), id: `update-reopen:${requestId}` },
  ];
  state.turnItems = [{ ...state.turnItems[0]!, requestId: `update-reopen:${requestId}` } as never];
  await render();
  expect(container.querySelector("[data-coordinator-question]")).toBeNull();
  ask();
  state.runtimeRequests = [
    original,
    ...state.runtimeRequests.map((r) => ({ ...(r as object), id: "ask-user:different" })),
  ];
  state.turnItems = state.turnItems.map(
    (i) => ({ ...i, requestId: "ask-user:different" }) as never,
  );
  await render();
  expect(container.querySelector("[data-coordinator-question]")?.textContent).toContain(
    "Which repository binding should the app use?",
  );
});

it("shows the actual coordinator question in attention instead of a circular instruction", async () => {
  ask();
  state.shells = state.shells.map((s) => ({ ...s, hasPendingUserInput: true }));
  await render();
  expect(container.textContent).not.toContain("The coordinator asked you a question.");
  expect(container.textContent).toContain("Which repository binding should the app use?");
});

it.each(["live", "cached", "synchronizing"])(
  "reconciles an obsolete question only from authoritative %s details",
  async (status) => {
    state.detailStatus = status;
    state.shells = state.shells.map((s) => ({ ...s, hasPendingUserInput: true }));
    await render();
    if (status === "live") {
      expect(container.textContent).not.toContain("The coordinator asked you a question.");
      expect(state.shellRefresh).toHaveBeenCalledOnce();
    } else {
      expect(state.shellRefresh).not.toHaveBeenCalled();
    }
  },
);
