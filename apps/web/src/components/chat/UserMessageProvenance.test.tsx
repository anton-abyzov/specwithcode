// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
} from "@specweave-studio/contracts";
import type { HandoffTimelineRun } from "@specweave-studio/client-runtime/handoff";
import type { ChatMessage } from "../../types";
import {
  ProjectMessageRoutingContext,
  type ProjectMessageRouting,
} from "../../studio/projectMessageRouting";
import { UserMessageProvenance } from "./UserMessageProvenance";

vi.mock("../../state/environments", () => ({
  useEnvironment: (environmentId: string) => (environmentId === "env-m1" ? { label: "M1" } : null),
}));
vi.mock("../settings/ScheduledTaskLink", () => ({
  ScheduledTaskLink: ({ children, taskId }: { children: ReactNode; taskId: string }) => (
    <a data-task-id={taskId}>{children}</a>
  ),
}));

const environmentId = EnvironmentId.make("env-m1");
const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: MessageId.make("request"),
  role: "user",
  streaming: false,
  text: "Inspect the project.",
  createdAt: "2026-10-13T00:00:00Z",
  updatedAt: "2026-10-13T00:00:00Z",
  runId: RunId.make("original-run"),
  ...overrides,
});
const run = (id: string, provider: string, model: string): HandoffTimelineRun => ({
  id: RunId.make(id),
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make(provider),
  modelSelection: { instanceId: ProviderInstanceId.make(provider), model },
});
const runs = [run("original-run", "claude", "opus-original"), run("new-run", "codex", "gpt-new")];
const markup = (input: ChatMessage, executionEnvironment = environmentId, recordedRuns = runs) =>
  renderToStaticMarkup(
    <UserMessageProvenance
      message={input}
      runs={recordedRuns}
      environmentId={executionEnvironment}
      onOpenThread={() => {}}
    />,
  );

describe("request execution provenance", () => {
  it("keeps each request's recorded model after later runs switch providers", () => {
    const original = markup(message());
    const latest = markup(message({ runId: RunId.make("new-run") }));
    expect(original).toContain("M1 · Claude Code · Opus Original");
    expect(original).not.toContain("gpt-new");
    expect(latest).toContain("M1 · Codex · GPT New");
    expect(original).toContain('data-environment-id="env-m1"');
    expect(original).toContain('data-run-id="original-run"');
  });

  it("marks missing run history explicitly and preserves unknown host identity", () => {
    const legacy = markup(message({ runId: null }));
    const unloaded = markup(message(), EnvironmentId.make("env-offline"), []);
    expect(legacy).toContain("M1 · Model not recorded");
    expect(unloaded).toContain("env-offline · Model not recorded");
    expect(legacy).not.toContain("opus-original");
    expect(unloaded).toContain(
      'aria-label="env-offline · Model not recorded. Execution environment: env-offline"',
    );
    expect(unloaded).not.toContain('title="Execution environment:');
  });

  it("retains automation attribution and the execution identity together", () => {
    const output = markup(
      message({ createdBy: "agent", scheduledTaskId: ScheduledTaskId.make("scheduled-1") }),
    );
    expect(output).toContain("Sent by automation");
    expect(output).toContain('data-task-id="scheduled-1"');
    expect(output).toContain("M1 · Claude Code · Opus Original");
  });

  it("preserves navigation to the sending coordinator after attribution extraction", async () => {
    const openCoordinator = vi.fn();
    const onOpenThread = vi.fn();
    const coordinatorThreadId = ThreadId.make("coordinator");
    const routing: ProjectMessageRouting = {
      coordinatorThreadId,
      openCoordinator,
      send: async () => {},
      openThread: () => true,
    };
    let renderer: ReactTestRenderer;
    await act(() => {
      renderer = create(
        <ProjectMessageRoutingContext value={routing}>
          <UserMessageProvenance
            message={message({ createdBy: "agent", senderThreadId: coordinatorThreadId })}
            runs={runs}
            environmentId={environmentId}
            onOpenThread={onOpenThread}
          />
        </ProjectMessageRoutingContext>,
      );
    });
    await act(() =>
      renderer!.root.findByProps({ "aria-label": "Open sending thread" }).props.onClick(),
    );
    expect(openCoordinator).toHaveBeenCalledOnce();
    expect(onOpenThread).not.toHaveBeenCalled();
    await act(() => renderer!.unmount());
  });
});
