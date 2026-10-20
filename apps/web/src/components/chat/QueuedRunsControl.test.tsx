import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
}));

vi.mock("@specweave-studio/client-runtime/environment", () => ({
  scopeThreadRef: () => ({}) as never,
}));

vi.mock("@specweave-studio/client-runtime/state/thread-workflows", () => ({
  deriveThreadQueueWorkflowState: () => state.workflow,
}));

vi.mock("../../state/entities", () => ({
  useThreadProjection: () => state.projection,
  useThreadShell: () => ({ title: "Release macOS app" }),
}));

// The hook's real shape: a UTC minute without a zone.
vi.mock("../../hooks/useNowMinute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNowMinute")>()),
  useNowMinute: () => "2026-10-15T12:00",
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    cancelQueuedRun: Symbol("cancelQueuedRun"),
    promoteQueuedRun: Symbol("promoteQueuedRun"),
    reorderQueuedRun: Symbol("reorderQueuedRun"),
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async () => undefined,
}));

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrls: (_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`),
}));

import { QueuedRunsControl } from "./QueuedRunsControl";

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", () => {
    state.projection = {
      projection: {
        messages: [
          {
            delegatedCompletion: {
              parentRunId: "run:parent",
              generation: 1,
              taskIds: ["task:child"],
            },
            id: "message:completion",
          },
        ],
      },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toBe("");
  });
});

describe("QueuedRunsControl attachments and edit mode", () => {
  const workflowWithAttachment = () => ({
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Queued with a screenshot",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        ],
      },
    ],
  });

  it("renders an attachment thumbnail on the queued row", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toContain("https://assets.test/attachment-1");
    expect(html).toContain("Queued with a screenshot");
    expect(html).toContain("Queue · after current turn");
    expect(html).toContain("Steer now");
    expect(html).toContain("Edit queued message");
    expect(html).toContain("Reorder queued message");
    expect(html).not.toContain("Move queued message up");
  });

  it("drops the optimistic pending row once the projection holds its message", () => {
    state.projection = {
      projection: { messages: [{ id: "message:acknowledged", text: "hello" }] },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[
          {
            id: "message:acknowledged" as never,
            inputIntent: "queued_turn",
            text: "hello",
            attachments: [],
          },
        ]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toBe("");
  });

  it("keeps the original queued message visible while editing", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={"run:queued" as never}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toContain("Queued with a screenshot");
  });
  it("disables immediate steering when the current turn cannot accept it", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = { ...workflowWithAttachment(), canPromoteToSteer: false };
    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );
    expect(html).toContain("Queue · after current turn");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^]*?Steer now<\/button>/);
    expect(html).not.toContain("next tool");
  });
  it("labels held messages as waiting to resume", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = {
      ...workflowWithAttachment(),
      isHeld: true,
      activeRun: null,
      canPromoteToSteer: false,
    };
    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );
    expect(html).toContain("Queue · waiting to resume");
    expect(html).not.toContain("Queue · after current turn");
  });
});

describe("QueuedRunsControl row summaries", () => {
  it("names the sending thread, reads a report as one line and says how long it waited", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [
        {
          run: {
            id: "run:report",
            userMessageId: "message:report",
            requestedAt: "2026-10-15T11:48:00.000Z",
          },
          text: "## **Outcome**\n\nSettings 12/12 pass; harnesses next.",
          attachments: [],
          senderThreadId: "thread:release",
          createdBy: "agent",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
      />,
    );

    expect(html).toContain('data-queued-sender="thread:release"');
    expect(html).toContain("Release macOS app");
    expect(html).toMatch(/data-queued-summary[^>]*>Outcome</);
    expect(html).toContain("queued 12 min");
  });
});

describe("QueuedRunsControl held queue", () => {
  const heldWorkflow = (held: boolean) => ({
    activeRun: null,
    canPromoteToSteer: false,
    canReorder: true,
    isHeld: held,
    queuedRuns: [1, 2].map((index) => ({
      run: {
        id: `run:handoff-${index}`,
        userMessageId: `message:handoff-${index}`,
        queueHeld: held,
      },
      text: `Handoff ${index}`,
      attachments: [],
    })),
  });

  const render = (props: { onResumeHeld?: () => void; resumeBusy?: boolean }) =>
    renderToStaticMarkup(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
        {...props}
      />,
    );

  it("says how many messages are held and offers Resume and Discard", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = heldWorkflow(true);

    const html = render({ onResumeHeld: () => undefined });

    expect(html).toContain('data-queue-held="2"');
    expect(html).toContain("2 queued messages held");
    expect(html).toContain("not sent until you resume");
    expect(html).toMatch(/<button[^>]*>Resume<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Resume<\/button>/);
    expect(html).toContain("Discard the 2 held messages");
    expect(html).toContain("Queue · waiting to resume");
    expect(html).toContain('data-variant="warning"');
  });

  it("disables Resume while it cannot act and shows no held row for a waiting queue", () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = heldWorkflow(true);
    expect(render({})).toMatch(/<button[^>]*disabled=""[^>]*>Resume<\/button>/);
    expect(render({ onResumeHeld: () => undefined, resumeBusy: true })).toMatch(
      /<button[^>]*disabled=""[^>]*>Resume<\/button>/,
    );

    state.workflow = heldWorkflow(false);
    const html = render({ onResumeHeld: () => undefined });
    expect(html).not.toContain("data-queue-held");
    expect(html).not.toContain("queued messages held");
    expect(html).toContain("Queue · after current turn");
  });
});
