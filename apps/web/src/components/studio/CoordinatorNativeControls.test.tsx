// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, RuntimeRequestId } from "@specweave-studio/contracts";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import {
  ProjectMessageRoutingContext,
  type ProjectMessageRouting,
} from "../../studio/projectMessageRouting";
import { CoordinatorNativeControls } from "./CoordinatorNativeControls";
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
    onCustomAnswer: vi.fn(),
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
it("retains native question answers, with a labeled answer field and explicit submit", async () => {
  props.questions = [
    {
      requestId: RuntimeRequestId.make("q"),
      responseCapability: "live",
      createdAt: "2026-10-13T12:00:00Z",
      dismissible: true,
      questions: [
        {
          id: "q1",
          header: "Destination",
          question: "Where should this run?",
          options: [],
          multiSelect: false,
        },
      ],
    },
  ];
  props.answers = { q1: { customAnswer: "Local host" } };
  props.progress = derivePendingUserInputProgress(props.questions[0]!.questions, props.answers, 0);
  await render();
  expect(container.querySelector("label > span")!.textContent).toBe("Your answer");
  const textarea = container.querySelector("textarea")!;
  expect(textarea.value).toBe("Local host");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Other host",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(props.onCustomAnswer).toHaveBeenCalledWith("q1", "Other host");
  await act(async () => button("Send answer").click());
  expect(props.onAdvance).toHaveBeenCalledOnce();
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
