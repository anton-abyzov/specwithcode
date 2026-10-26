// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationV2ThreadProjection,
  type UserInputQuestion,
} from "@specweave-studio/contracts";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { getProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import {
  QUESTION_ALREADY_SETTLED,
  QUESTION_ALREADY_SETTLED_ON_CARD,
  QUESTION_SEND_INTERRUPTED,
} from "../../studio/coordinatorQuestionAnswers";
import {
  QUESTION_ANSWER_SENT,
  QUESTION_DISMISSED,
  QUESTION_SETTLED_ELSEWHERE,
} from "../chat/questionLiveStatus";
import { DISMISS_ALREADY_SETTLED } from "../chat/questionSendOutcome";
import { useCoordinatorQuestion, type CoordinatorQuestion } from "./useCoordinatorQuestion";

const commands = vi.hoisted(() => ({
  respond: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => commands.respond,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => commands.dismiss,
}));
// The host is back as soon as an answer waits for it.
const hostReady = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../lib/durableComposerDraftBindings", () => ({ whenHostReady: hostReady }));
const released = vi.hoisted(() => vi.fn());
vi.mock("../../lib/attachmentUploadQueue", async (original) => ({
  ...(await original<typeof import("../../lib/attachmentUploadQueue")>()),
  releaseDraftAttachment: released,
}));

const environmentId = EnvironmentId.make("host");
const coordinatorId = ThreadId.make("project-coordinator:atlas");
const requestId = RuntimeRequestId.make("ask-user:binding");
const layout: UserInputQuestion = {
  id: "q1",
  header: "Layout",
  question: "Which header layout?",
  options: [
    { label: "Compact", description: "One row" },
    { label: "Tall", description: "Two rows" },
  ],
  allowCustomAnswer: true,
};
const pages: UserInputQuestion = {
  id: "q2",
  header: "Pages",
  question: "Which pages change?",
  options: [{ label: "Settings", description: "Settings" }],
  allowCustomAnswer: true,
};
const projection = (
  questions: ReadonlyArray<UserInputQuestion>,
  status = "pending",
  answers?: Record<string, unknown>,
) => {
  const now = DateTime.makeUnsafe(Date.parse("2026-10-23T12:00:00Z"));
  return {
    thread: { id: coordinatorId },
    runtimeRequests: [
      {
        id: requestId,
        kind: "user_input",
        status,
        responseCapability: { type: "message" },
        createdAt: now,
        ...(answers === undefined ? {} : { answers }),
      },
    ],
    turnItems: [
      {
        type: "user_input_request",
        threadId: coordinatorId,
        requestId,
        responseMode: "message",
        questions,
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
};
const image: ChatAttachment = {
  type: "image",
  id: "uploaded-1",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 70,
};

let root: Root, container: HTMLDivElement, current: CoordinatorQuestion | null;
let composer: ReturnType<typeof getProjectCoordinatorComposer>;
const errors: Array<string | null> = [];
const announced: string[] = [];
const announce = (text: string) => {
  announced.push(text);
};
function Probe(props: {
  projection: OrchestrationV2ThreadProjection;
  isThisDevice?: boolean | undefined;
}) {
  current = useCoordinatorQuestion({
    environmentId,
    coordinatorId,
    projection: props.projection,
    composer,
    supportsQuestionAttachments: true,
    disabled: false,
    composerCanAnswer: true,
    reportError: (message) => errors.push(message),
    retireError: (message) => {
      if (errors.at(-1) === message) errors.push(null);
    },
    announce,
    isThisDevice: props.isThisDevice,
  });
  return null;
}
const render = (value: OrchestrationV2ThreadProjection, isThisDevice?: boolean) =>
  act(async () => root.render(<Probe projection={value} isThisDevice={isThisDevice} />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  composer = getProjectCoordinatorComposer("host", `atlas-${Math.random()}`);
  commands.respond.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  commands.dismiss.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  errors.length = 0;
  announced.length = 0;
  current = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("is null with no pending question and names the coordinator when one waits", async () => {
  await render(projection([layout], "resolved"));
  expect(current).toBeNull();
  await render(projection([layout]));
  expect(current?.askedBy).toBe("Coordinator");
  expect(current?.active.requestId).toBe(requestId);
});

it("a message sent from the composer answers in chat with its files", async () => {
  await render(projection([layout]));
  const sent = await act(() => current!.answerFromDraft("Use this layout", [image]));
  expect(sent).toEqual({ keepUploads: false });
  expect(commands.respond).toHaveBeenCalledOnce();
  const [{ input }] = commands.respond.mock.calls[0]!;
  expect(input).toMatchObject({
    threadId: coordinatorId,
    requestId,
    answers: { q1: "Use this layout" },
    attachmentsByQuestionId: { q1: [image] },
    answeredInChat: true,
  });
  expect(String(input.commandId)).toMatch(/^answer:ask-user:binding:/);
});

it("a resend of the same answer reuses its command id", async () => {
  await render(projection([layout]));
  commands.respond.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await expect(act(() => current!.answerFromDraft("Tall, please", undefined))).rejects.toThrow(
    "Send it again: the same answer is delivered once.",
  );
  await act(() => current!.answerFromDraft("Tall, please", undefined));
  const ids = commands.respond.mock.calls.map(([value]) => String(value.input.commandId));
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});

it("a refused answer is resent as a new command, never a replay of the refusal", async () => {
  await render(projection([layout]));
  commands.respond.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error("The coordinator is handing off."))),
  );
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toThrow(
    "The coordinator is handing off.",
  );
  await act(() => current!.answerFromDraft("Tall", undefined));
  const ids = commands.respond.mock.calls.map(([value]) => String(value.input.commandId));
  expect(ids).toHaveLength(2);
  expect(ids[1]).not.toBe(ids[0]);
  expect(ids[1]).toMatch(/^answer:ask-user:binding:/);
});

// The answer that reached this Mac while its service was busy with an update.
const notConnected = () =>
  AsyncResult.failure(
    Cause.fail(
      Object.assign(new Error("Anton's MacBook M4MAX is not connected."), {
        _tag: "EnvironmentRpcUnavailableError",
      }),
    ),
  );

it("an answer sent while this Mac is busy goes once it catches up, with no error", async () => {
  await render(projection([layout]), true);
  commands.respond.mockResolvedValueOnce(notConnected());
  const sent = await act(() => current!.answerFromDraft("Tall", undefined));
  expect(sent).toEqual({ keepUploads: false });
  const ids = commands.respond.mock.calls.map(([value]) => String(value.input.commandId));
  expect(ids).toHaveLength(2);
  expect(ids[1]).toBe(ids[0]);
  expect(hostReady).toHaveBeenCalledWith(environmentId, { cancelled: false });
  expect(errors.filter(Boolean)).toEqual([]);
});

it("an answer this Mac never takes says it is busy, never that it is not connected", async () => {
  await render(projection([layout]), true);
  commands.respond.mockResolvedValue(notConnected());
  hostReady.mockResolvedValueOnce(false);
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toThrow(
    "SpecWithCode on this Mac is busy",
  );
  expect(errors.join(" ")).not.toContain("not connected");
});

it("a dismissal this Mac never received goes again once it catches up", async () => {
  await render(projection([layout]), true);
  commands.dismiss.mockResolvedValueOnce(notConnected());
  await act(async () => current!.dismiss(requestId));
  await vi.waitFor(() => expect(commands.dismiss).toHaveBeenCalledTimes(2), { timeout: 3_000 });
  await vi.waitFor(() => expect(announced).toContain(QUESTION_DISMISSED));
  expect(errors.filter(Boolean)).toEqual([]);
});

it("a question settled elsewhere refuses the send and says so", async () => {
  await render(projection([layout]));
  commands.respond.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error(`Runtime request ${requestId} is resolved.`))),
  );
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toThrow(
    QUESTION_ALREADY_SETTLED,
  );
});

it("an earlier question of a card keeps its files for the answer still to come", async () => {
  await render(projection([layout, pages]));
  const first = await act(() => current!.answerFromDraft("", [image]));
  expect(first).toEqual({ keepUploads: true });
  expect(commands.respond).not.toHaveBeenCalled();
  expect(current?.questionIndex).toBe(1);
  await act(() => current!.answerFromDraft("Settings only", undefined));
  const [{ input }] = commands.respond.mock.calls[0]!;
  expect(input.answers).toEqual({ q1: "", q2: "Settings only" });
  expect(input.attachmentsByQuestionId).toEqual({ q1: [image] });
});

it("a new reply to an earlier question replaces its files, even with none", async () => {
  await render(projection([layout, pages]));
  await act(() => current!.answerFromDraft("", [image]));
  await act(async () => current!.previous());
  await act(() => current!.answerFromDraft("Tall", undefined));
  await act(() => current!.answerFromDraft("Settings only", undefined));
  const [{ input }] = commands.respond.mock.calls[0]!;
  expect(input.answers).toEqual({ q1: "Tall", q2: "Settings only" });
  expect(input.attachmentsByQuestionId).toBeUndefined();
});

it("an option sent from the card is not a chat reply and leaves the draft alone", async () => {
  await render(projection([layout]));
  composer.setPrompt("draft");
  await act(async () => current!.toggleOption("q1", "Tall"));
  await act(async () => current!.advance());
  const [{ input }] = commands.respond.mock.calls[0]!;
  expect(input.answers).toEqual({ q1: "Tall" });
  expect(input.answeredInChat).toBeUndefined();
  expect(composer.getSnapshot().prompt).toBe("draft");
});

it("tells a screen reader the answer was sent, and not that it settled elsewhere", async () => {
  await render(projection([layout]));
  await act(() => current!.answerFromDraft("Tall", undefined));
  expect(announced).toEqual([QUESTION_ANSWER_SENT]);
  await render(projection([layout], "resolved", { q1: "Tall" }));
  expect(announced).toEqual([QUESTION_ANSWER_SENT]);
});

const settledRefusal = () =>
  AsyncResult.failure(Cause.fail(new Error(`Runtime request ${requestId} is resolved.`)));
// The request settles on the host before its refusal of this send comes back.
const settleDuringSend = (answers: Record<string, unknown>) =>
  commands.respond.mockImplementationOnce(async () => {
    flushSync(() => root.render(<Probe projection={projection([layout], "resolved", answers)} />));
    return settledRefusal();
  });

it("a send refused as resolved is delivered when the host already holds these words", async () => {
  await render(projection([layout]));
  settleDuringSend({
    q1: 'Tall\n\nAttached image "screenshot.png": "/attachments/screenshot.png"',
  });
  const sent = await act(() => current!.answerFromDraft("Tall", [image]));
  expect(sent).toEqual({ keepUploads: false });
  expect(announced).toEqual([QUESTION_ANSWER_SENT]);
});

it("a send refused as resolved, with the same words but not its file, is not delivered", async () => {
  await render(projection([layout]));
  settleDuringSend({ q1: "Tall" });
  await expect(act(() => current!.answerFromDraft("Tall", [image]))).rejects.toThrow(
    QUESTION_ALREADY_SETTLED,
  );
  expect(announced).not.toContain(QUESTION_ANSWER_SENT);
});

it("a send refused as resolved with other words says it was settled elsewhere", async () => {
  await render(projection([layout]));
  settleDuringSend({ q1: "Compact" });
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toThrow(
    QUESTION_ALREADY_SETTLED,
  );
  expect(announced).not.toContain(QUESTION_ANSWER_SENT);
});

it("a refusal that comes back first is the news; its later settle stays quiet", async () => {
  await render(projection([layout]));
  commands.respond.mockResolvedValueOnce(settledRefusal());
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toThrow(
    QUESTION_ALREADY_SETTLED,
  );
  await render(projection([layout], "resolved", { q1: "Compact" }));
  expect(announced).toEqual([]);
  expect(errors.at(-1)).toBe(QUESTION_ALREADY_SETTLED);
});

it("an interrupted send that landed is announced as sent and its reply leaves the box", async () => {
  await render(projection([layout]));
  composer.setPrompt("Tall");
  commands.respond.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toThrow(
    QUESTION_SEND_INTERRUPTED,
  );
  expect(composer.getSnapshot().prompt).toBe("Tall");
  await render(projection([layout], "resolved", { q1: "Tall" }));
  expect(announced).toEqual([QUESTION_ANSWER_SENT]);
  expect(composer.getSnapshot().prompt).toBe("");
  expect(errors.at(-1)).toBeNull();
});

it("a landed reply's files leave the box and are released like a confirmed send's", async () => {
  const revoke = vi.fn();
  URL.revokeObjectURL = revoke;
  released.mockReset();
  const local: ComposerImageAttachment = {
    type: "image",
    name: "screenshot.png",
    mimeType: "image/png",
    sizeBytes: 70,
    id: "local-1",
    previewUrl: "blob:local-1",
    file: new File(["x"], "screenshot.png", { type: "image/png" }),
  };
  await render(projection([layout]));
  composer.setPrompt("Tall");
  composer.setAttachments([local]);
  commands.respond.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await expect(act(() => current!.answerFromDraft("Tall", [image]))).rejects.toThrow(
    QUESTION_SEND_INTERRUPTED,
  );
  await render(
    projection([layout], "resolved", {
      q1: 'Tall\n\nAttached image "screenshot.png": "/attachments/screenshot.png"',
    }),
  );
  expect(announced).toEqual([QUESTION_ANSWER_SENT]);
  expect(composer.getSnapshot().attachments).toEqual([]);
  expect(released).toHaveBeenCalledWith(local);
  expect(revoke).toHaveBeenCalledWith("blob:local-1");
});

it("an interrupted send that did not land says the question settled elsewhere", async () => {
  await render(projection([layout]));
  composer.setPrompt("Tall");
  commands.respond.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toThrow(
    QUESTION_SEND_INTERRUPTED,
  );
  await render(projection([layout], "resolved", { q1: "Compact" }));
  expect(composer.getSnapshot().prompt).toBe("Tall");
  // "Send it again" no longer holds: the reason beside the box says why it stayed,
  // and is the one thing a screen reader hears.
  expect(errors.at(-1)).toBe(QUESTION_ALREADY_SETTLED);
  expect(announced).toEqual([]);
});

/** The settled request and, after it, a follow-up the coordinator asked. */
const followUpId = RuntimeRequestId.make("ask-user:follow-up");
const settledWithFollowUp = (answers: Record<string, unknown>) => {
  const settled = projection([layout], "resolved", answers);
  const followUp = projection([pages]);
  return {
    ...settled,
    runtimeRequests: [
      ...settled.runtimeRequests,
      ...followUp.runtimeRequests.map((request) => ({ ...request, id: followUpId })),
    ],
    turnItems: [
      ...settled.turnItems,
      ...followUp.turnItems.map((item) => ({ ...item, requestId: followUpId })),
    ],
  } as OrchestrationV2ThreadProjection;
};

it("a follow-up question arriving with the settle retires the reason", async () => {
  await render(projection([layout]));
  composer.setPrompt("Tall");
  commands.respond.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toThrow(
    QUESTION_SEND_INTERRUPTED,
  );
  // As the composer shows the thrown reason.
  errors.push(QUESTION_SEND_INTERRUPTED);
  await render(settledWithFollowUp({ q1: "Compact" }));
  // Sending the box now would answer the follow-up: no advice to send it.
  expect(errors.at(-1)).toBeNull();
  expect(errors).not.toContain(QUESTION_ALREADY_SETTLED);
  expect(announced).toEqual([QUESTION_SETTLED_ELSEWHERE]);
  expect(composer.getSnapshot().prompt).toBe("Tall");
});

it("a follow-up question arriving after the settle retires the reason", async () => {
  await render(projection([layout]));
  composer.setPrompt("Tall");
  commands.respond.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toThrow(
    QUESTION_SEND_INTERRUPTED,
  );
  await render(projection([layout], "resolved", { q1: "Compact" }));
  expect(errors.at(-1)).toBe(QUESTION_ALREADY_SETTLED);
  await render(settledWithFollowUp({ q1: "Compact" }));
  // Sending the box now would answer the follow-up: the advice goes.
  expect(current!.active?.requestId).toBe(followUpId);
  expect(errors.at(-1)).toBeNull();
  expect(composer.getSnapshot().prompt).toBe("Tall");
});

it("a late result beside a follow-up already waiting gives no advice to send", async () => {
  await render(projection([layout]));
  composer.setPrompt("Tall");
  commands.respond.mockImplementationOnce(async () => {
    flushSync(() => root.render(<Probe projection={settledWithFollowUp({ q1: "Compact" })} />));
    return settledRefusal();
  });
  // The reply stays in the box, with nothing beside it.
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toMatchObject({
    message: "",
  });
  expect(errors).not.toContain(QUESTION_ALREADY_SETTLED);
  expect(announced).toEqual([QUESTION_SETTLED_ELSEWHERE]);
  expect(composer.getSnapshot().prompt).toBe("Tall");
});

it("a dismissal refused as already answered is said once", async () => {
  await render(projection([layout]));
  commands.dismiss.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error(DISMISS_ALREADY_SETTLED))),
  );
  await act(async () => current!.dismiss(requestId));
  expect(errors.at(-1)).toBe(DISMISS_ALREADY_SETTLED);
  await render(projection([layout], "resolved", { q1: "Compact" }));
  expect(errors.at(-1)).toBe(DISMISS_ALREADY_SETTLED);
  expect(announced).toEqual([]);
});

it("a refusal said first and retired by a follow-up is not said again", async () => {
  await render(projection([layout]));
  composer.setPrompt("Tall");
  commands.respond.mockResolvedValueOnce(settledRefusal());
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toThrow(
    QUESTION_ALREADY_SETTLED,
  );
  await render(settledWithFollowUp({ q1: "Compact" }));
  expect(errors.at(-1)).toBeNull();
  expect(announced).toEqual([]);
  expect(composer.getSnapshot().prompt).toBe("Tall");
});

it("a dismissal refused as answered, then retired by a follow-up, is said once", async () => {
  await render(projection([layout]));
  commands.dismiss.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error(DISMISS_ALREADY_SETTLED))),
  );
  await act(async () => current!.dismiss(requestId));
  expect(errors.at(-1)).toBe(DISMISS_ALREADY_SETTLED);
  await render(settledWithFollowUp({ q1: "Compact" }));
  expect(errors.at(-1)).toBeNull();
  expect(announced).toEqual([]);
});

it("an answer given on the card is not said to be in the box", async () => {
  await render(projection([layout]));
  commands.respond.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await act(async () => current!.toggleOption("q1", "Tall"));
  await act(async () => current!.advance());
  expect(errors.at(-1)).toBe(QUESTION_SEND_INTERRUPTED);
  await render(projection([layout], "resolved", { q1: "Compact" }));
  expect(errors.at(-1)).toBe(QUESTION_ALREADY_SETTLED_ON_CARD);
  expect(announced).toEqual([]);
});

it("an edited reply stays in the box when the earlier send lands", async () => {
  await render(projection([layout]));
  composer.setPrompt("Tall");
  commands.respond.mockResolvedValueOnce(AsyncResult.failure(Cause.interrupt()));
  await expect(act(() => current!.answerFromDraft("Tall", undefined))).rejects.toThrow(
    QUESTION_SEND_INTERRUPTED,
  );
  composer.setPrompt("Tall, and wider margins");
  await render(projection([layout], "resolved", { q1: "Tall" }));
  expect(announced).toEqual([QUESTION_ANSWER_SENT]);
  expect(composer.getSnapshot().prompt).toBe("Tall, and wider margins");
});

it("a dismissed question is announced once, as dismissed", async () => {
  await render(projection([layout]));
  await act(async () => current!.dismiss(requestId));
  expect(commands.dismiss).toHaveBeenCalledOnce();
  expect(announced).toEqual([QUESTION_DISMISSED]);
  await render(projection([layout], "cancelled"));
  expect(announced).toEqual([QUESTION_DISMISSED]);
});

it("a question answered from another window is announced", async () => {
  await render(projection([layout]));
  await render(projection([layout], "resolved", { q1: "Compact" }));
  expect(announced).toEqual([QUESTION_SETTLED_ELSEWHERE]);
});
