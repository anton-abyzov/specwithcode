// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, RuntimeRequestId } from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";
import { getProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import {
  ProjectMessageRoutingContext,
  type ProjectMessageRouting,
} from "../../studio/projectMessageRouting";
import { CoordinatorNativeControls, firstRequestAction } from "./CoordinatorNativeControls";
import type { CoordinatorQuestionRecoveryContext } from "./CoordinatorQuestionCard";
import type { CoordinatorQuestion } from "./useCoordinatorQuestion";
const markdown = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock("../ChatMarkdown", () => ({
  default: (props: Record<string, unknown>) => {
    markdown.props = props;
    return <p>{props.text as string}</p>;
  },
}));
let root: Root, container: HTMLDivElement;
let props: ComponentProps<typeof CoordinatorNativeControls>;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  markdown.props = null;
  props = {
    markdownContext: {
      environmentId: EnvironmentId.make("host"),
      threadRef: scopeThreadRef(EnvironmentId.make("host"), ThreadId.make("coord")),
      cwd: "/scratch/atlas",
    },
    loading: false,
    disabled: false,
    error: null,
    approvals: [],
    respondingApprovals: [],
    onApproval: vi.fn(async () => undefined),
    questions: [],
    answers: {},
    questionIndex: 0,
    progress: null,
    respondingQuestions: [],
    onOption: vi.fn(),
    onPrevious: vi.fn(),
    onAdvance: vi.fn(),
    onDismiss: vi.fn(),
    planMarkdown: null,
    onImplementPlan: vi.fn(async () => true),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = () => act(async () => root.render(<CoordinatorNativeControls {...props} />));
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const approval = {
  requestId: RuntimeRequestId.make("a"),
  responseCapability: "live" as const,
  requestKind: "command" as const,
  detail: "git diff",
  createdAt: "2026-10-13T12:00:00Z",
  options: [
    { decision: "accept" as const, label: "Approve" },
    { decision: "decline" as const, label: "Decline" },
  ],
};
it("responds with the native request identity and provider decision", async () => {
  props.approvals = [approval];
  await render();
  expect(container.querySelector("textarea")).toBeNull();
  expect(button("Approve").dataset.slot).toBe("button");
  await act(async () => button("Approve").click());
  expect(props.onApproval).toHaveBeenCalledExactlyOnceWith("a", "accept");
});
it("lands keyboard focus on Decline, never Approve, whatever the provider's order", async () => {
  // The provider lists Approve first: a stray Enter must not approve.
  props.approvals = [approval];
  await render();
  expect(firstRequestAction(container)).toBe(button("Decline"));
  props.approvals = [{ ...approval, options: [{ decision: "accept", label: "Approve" }] }];
  await render();
  expect(firstRequestAction(container)).toBeNull();
});
it.each(["permission", "responding", "not_resumable"])(
  "prevents decisions when %s blocks the request",
  async (condition) => {
    props.approvals = [
      { ...approval, responseCapability: condition === "not_resumable" ? "not_resumable" : "live" },
    ];
    props.disabled = condition === "permission";
    props.respondingApprovals = condition === "responding" ? [approval.requestId] : [];
    await render();
    expect(button("Approve").disabled).toBe(true);
    await act(async () => button("Approve").click());
    expect(props.onApproval).not.toHaveBeenCalled();
  },
);
const destination: PendingUserInput = {
  requestId: RuntimeRequestId.make("q"),
  responseCapability: "live",
  createdAt: "2026-10-13T12:00:00Z",
  dismissible: true,
  questions: [
    {
      id: "q1",
      header: "Destination",
      question: "Where should this run?",
      options: [{ label: "Local host", description: "This Mac" }],
      multiSelect: false,
      allowCustomAnswer: true,
    },
  ],
} as PendingUserInput;
it("outside the project page a question keeps its options and no second answer box", async () => {
  props.questions = [destination];
  props.answers = { q1: { selectedOptionValues: ["Local host"] } };
  props.progress = derivePendingUserInputProgress(destination.questions, props.answers, 0);
  await render();
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.textContent).not.toContain("Your answer");
  await act(async () => button("Send answer").click());
  expect(props.onAdvance).toHaveBeenCalledOnce();
});

const recoveryFor = (composerCanAnswer: boolean) => {
  const composer = getProjectCoordinatorComposer("host", `project-${composerCanAnswer}`);
  composer.setPrompt("Use the Mac mini");
  const question = {
    requests: [destination],
    active: destination,
    askedBy: "Coordinator",
    answers: {},
    questionIndex: 0,
    progress: derivePendingUserInputProgress(destination.questions, {}, 0),
    respondingRequestIds: [],
    disabled: false,
    composerCanAnswer,
    toggleOption: vi.fn(),
    advance: vi.fn(),
    previous: vi.fn(),
    dismiss: vi.fn(),
    answerFromDraft: vi.fn(async () => ({ keepUploads: false })),
  } satisfies CoordinatorQuestion;
  const recovery: CoordinatorQuestionRecoveryContext = {
    question,
    composer,
    environmentId: EnvironmentId.make("host"),
    cwd: "/scratch/atlas",
    uploadsSupported: true,
    canAttach: true,
    maxFileBytes: null,
    composerProblem: composerCanAnswer ? null : "Choose a model for the coordinator first.",
  };
  return { composer, question, recovery };
};
const renderRecovery = (recovery: CoordinatorQuestionRecoveryContext) => {
  const close = vi.fn();
  const routing = {
    coordinatorQuestion: recovery,
    closeCoordinatorRequests: close,
  } as unknown as ProjectMessageRouting;
  props.questions = [destination];
  return {
    close,
    done: act(async () =>
      root.render(
        <ProjectMessageRoutingContext value={routing}>
          <CoordinatorNativeControls {...props} />
        </ProjectMessageRoutingContext>,
      ),
    ),
  };
};

it("points to the message box while it can answer, and closes onto it", async () => {
  const prompt = document.createElement("textarea");
  prompt.id = "project-prompt";
  document.body.append(prompt);
  const { recovery } = recoveryFor(true);
  const { close, done } = renderRecovery(recovery);
  await done;
  expect(container.textContent).toContain("Coordinator asks");
  expect(container.querySelector("textarea")).toBeNull();
  await act(async () => button("Answer in chat").click());
  expect(close).toHaveBeenCalledExactlyOnceWith(prompt);
  prompt.remove();
});

it("answers from the same draft only when the message box cannot send", async () => {
  const { composer, question, recovery } = recoveryFor(false);
  const { done } = renderRecovery(recovery);
  await done;
  const textarea = container.querySelector<HTMLTextAreaElement>(
    "[data-coordinator-draft-answer] textarea",
  )!;
  expect(container.querySelector("[data-recovery-reason]")!.textContent).toContain(
    "Choose a model for the coordinator first.",
  );
  // The box is the page's draft: what was typed below is here, and edits go back to it.
  expect(textarea.value).toBe("Use the Mac mini");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Use the Mac mini, not the server",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(composer.getSnapshot().prompt).toBe("Use the Mac mini, not the server");
  await act(async () => button("Send answer").click());
  expect(question.answerFromDraft).toHaveBeenCalledExactlyOnceWith(
    "Use the Mac mini, not the server",
    undefined,
  );
  expect(composer.getSnapshot().prompt).toBe("");
});

it.each([true, false])(
  "puts the first focus on the question's own way to answer (message box can send: %s)",
  async (composerCanAnswer) => {
    const { recovery } = recoveryFor(composerCanAnswer);
    const { done } = renderRecovery(recovery);
    await done;
    const first = firstRequestAction(container)!;
    expect(
      composerCanAnswer
        ? first.hasAttribute("data-answer-in-chat")
        : first.closest("[data-coordinator-draft-answer]") !== null && first.tagName === "TEXTAREA",
    ).toBe(true);
  },
);

it("shows held messages instead of saying nothing needs a response", async () => {
  props.heldQueue = <p>Held: update the release notes</p>;
  await render();
  expect(container.querySelector("[data-coordinator-held]")!.textContent).toContain(
    "Held: update the release notes",
  );
  expect(container.textContent).not.toContain("No requests need your response.");
});

it("keeps the draft and says why when the recovery answer is refused", async () => {
  const { composer, question, recovery } = recoveryFor(false);
  question.answerFromDraft.mockRejectedValueOnce(new Error("Runtime request q is resolved."));
  const { done } = renderRecovery(recovery);
  await done;
  await act(async () => button("Send answer").click());
  expect(container.querySelector("[role='alert']")!.textContent).toBe(
    "Runtime request q is resolved.",
  );
  expect(composer.getSnapshot().prompt).toBe("Use the Mac mini");
});

it("starts an approved plan once and disables the action while awaiting the host", async () => {
  props.planMarkdown = "# Plan\nUpdate the report.";
  let finish!: (value: boolean) => void;
  props.onImplementPlan = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await act(async () => button("Implement plan").click());
  expect(button("Starting…").disabled).toBe(true);
  await act(async () => button("Starting…").click());
  expect(props.onImplementPlan).toHaveBeenCalledOnce();
  await act(async () => finish(true));
  expect(button("Implement plan").disabled).toBe(false);
});

it("preserves the coordinator host, scoped thread, and checkout for proposed-plan links", async () => {
  const environmentId = EnvironmentId.make("remote-mac");
  const threadRef = scopeThreadRef(
    environmentId,
    ThreadId.make("project-coordinator:remote-project"),
  );
  props.markdownContext = { environmentId, threadRef, cwd: "/remote/project-checkout" };
  props.planMarkdown = "# Plan\nReview [source](src/remote.ts).";
  await render();
  expect(markdown.props).toMatchObject({
    environmentId,
    threadRef,
    cwd: "/remote/project-checkout",
    text: props.planMarkdown,
    isStreaming: false,
    headingLevelOffset: 2,
  });
});

it("closes only after a previously visible final request resolves", async () => {
  const close = vi.fn();
  const routing = { onCoordinatorRequestsResolved: close } as unknown as ProjectMessageRouting;
  const update = () =>
    act(async () =>
      root.render(
        <ProjectMessageRoutingContext value={routing}>
          <CoordinatorNativeControls {...props} />
        </ProjectMessageRoutingContext>,
      ),
    );
  await update();
  expect(close).not.toHaveBeenCalled();
  props.approvals = [approval];
  await update();
  props.approvals = [];
  props.respondingApprovals = [approval.requestId];
  await update();
  expect(close).not.toHaveBeenCalled();
  props.respondingApprovals = [];
  await update();
  expect(close).toHaveBeenCalledOnce();
  await update();
  expect(close).toHaveBeenCalledOnce();
});

it.each(["loading", "disabled", "error", "remaining", "question", "plan"])(
  "keeps the review open while %s remains",
  async (condition) => {
    const close = vi.fn();
    const routing = { onCoordinatorRequestsResolved: close } as unknown as ProjectMessageRouting;
    const update = () =>
      act(async () =>
        root.render(
          <ProjectMessageRoutingContext value={routing}>
            <CoordinatorNativeControls {...props} />
          </ProjectMessageRoutingContext>,
        ),
      );
    props.approvals = [approval];
    await update();
    props.approvals =
      condition === "remaining" ? [{ ...approval, requestId: RuntimeRequestId.make("b") }] : [];
    props.loading = condition === "loading";
    props.disabled = condition === "disabled";
    props.error = condition === "error" ? "Response failed" : null;
    props.respondingQuestions = condition === "question" ? [RuntimeRequestId.make("q")] : [];
    props.planMarkdown = condition === "plan" ? "Proposed work" : null;
    await update();
    expect(close).not.toHaveBeenCalled();
    props.approvals = [];
    props.loading = false;
    props.disabled = false;
    props.error = null;
    props.respondingQuestions = [];
    props.planMarkdown = null;
    await update();
    expect(close).toHaveBeenCalledOnce();
  },
);
