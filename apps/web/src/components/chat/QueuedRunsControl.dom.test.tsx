// @vitest-environment jsdom

import { OrchestrationV2DispatchCommandError } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
  results: [] as Array<unknown>,
  calls: [] as Array<{ readonly command: string; readonly input: unknown }>,
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

vi.mock("../../hooks/useNowMinute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNowMinute")>()),
  useNowMinute: () => "2026-10-24T12:00",
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: {
    cancelQueuedRun: "cancel",
    promoteQueuedRun: "promote",
    reorderQueuedRun: "reorder",
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => async (value: { readonly input: unknown }) => {
    state.calls.push({ command, input: value.input });
    return state.results.shift() ?? AsyncResult.success({ sequence: 1 });
  },
}));

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrls: () => [],
}));

import { QueuedRunsControl } from "./QueuedRunsControl";

const refusal = (message: string) =>
  AsyncResult.failure(
    Cause.fail(
      new OrchestrationV2DispatchCommandError({
        commandId: "command:test" as never,
        commandType: "queued-message.promote-to-steer",
        message,
      }),
    ),
  );

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  run: { id: `run:${id}`, userMessageId: `message:${id}`, requestedAt: "2026-10-24T11:50:00.000Z" },
  text: `Message ${id}`,
  attachments: [],
  ...extra,
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.projection = { projection: { messages: [] } };
  state.results = [];
  state.calls = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const render = async (props: { readonly actionsUnavailableReason?: string | null } = {}) =>
  act(async () =>
    root.render(
      <QueuedRunsControl
        environmentId={"environment:test" as never}
        optimisticMessages={[]}
        threadId={"thread:test" as never}
        editingRunId={null}
        onEditQueuedRun={() => undefined}
        onCancelEdit={() => undefined}
        {...props}
      />,
    ),
  );

const button = (name: string, index = 0): HTMLButtonElement => {
  const matches = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(
    (candidate) =>
      candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  const match = matches[index];
  if (match === undefined) throw new Error(`no button ${name}`);
  return match;
};

const alertText = () => container.querySelector('[role="alert"]')?.textContent ?? null;

describe("QueuedRunsControl command outcomes", () => {
  it("shows the server's refusal of Steer now next to the drawer and clears it on success", async () => {
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      waitReason: "turn",
      steerUnavailableReason: null,
      queuedRuns: [row("a"), row("b")],
    };
    state.results = [refusal("Provider session session-1 is not active.")];
    await render();

    await act(async () => button("Steer now").click());
    expect(state.calls).toEqual([
      {
        command: "promote",
        input: { threadId: "thread:test", queuedRunId: "run:a", targetRunId: "run:active" },
      },
    ]);
    expect(alertText()).toContain("Provider session session-1 is not active.");

    // The next queue command that succeeds clears it.
    await act(async () => button("Remove queued message", 1).click());
    expect(state.calls.at(-1)).toEqual({
      command: "cancel",
      input: { threadId: "thread:test", runId: "run:b" },
    });
    expect(alertText()).toBeNull();
  });

  it("shows a refused removal and a refused discard of a held queue", async () => {
    state.workflow = {
      activeRun: null,
      canPromoteToSteer: false,
      canReorder: true,
      isHeld: true,
      waitReason: "stopped",
      steerUnavailableReason: "No turn is running to steer into.",
      queuedRuns: [row("a", { run: { id: "run:a", userMessageId: "m", queueHeld: true } })],
    };
    state.results = [refusal("Run run:a is not queued.")];
    await render({});
    await act(async () => button("Remove queued message").click());
    expect(alertText()).toContain("Run run:a is not queued.");

    state.results = [refusal("Thread thread:test is not active.")];
    await act(async () => button("Discard").click());
    await act(async () => button("Discard 1?").click());
    expect(alertText()).toContain("Thread thread:test is not active.");
    expect(container.textContent).toContain("1 queued message held after Stop");
    expect(container.textContent).toContain("Queue · held after Stop");
  });
});

describe("QueuedRunsControl reasons", () => {
  it("disables every row action with the reason when the viewer cannot operate the thread", async () => {
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      waitReason: "turn",
      steerUnavailableReason: null,
      queuedRuns: [row("a")],
    };
    await render({ actionsUnavailableReason: "Studio Mac is not connected." });

    expect(button("Steer now").disabled).toBe(true);
    expect(button("Steer now").dataset.disabledReason).toBe("Studio Mac is not connected.");
    expect(button("Edit queued message").disabled).toBe(true);
    expect(button("Remove queued message").disabled).toBe(true);
    expect(container.querySelector('[aria-label^="Reorder queued message"]')).toBeNull();
    expect(container.querySelector("[data-queue-reason]")?.textContent).toContain(
      "Studio Mac is not connected.",
    );
    await act(async () => button("Steer now").click());
    expect(state.calls).toEqual([]);
  });

  it("names why Steer now is disabled and who queued each row", async () => {
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: false,
      canReorder: true,
      waitReason: "turn",
      steerUnavailableReason:
        "No provider turn is running right now, so there is nothing to steer into.",
      queuedRuns: [
        row("agent", { senderThreadId: "thread:release", createdBy: "agent" }),
        row("mine", { createdBy: "user" }),
      ],
    };
    await render();
    expect(button("Steer now").disabled).toBe(true);
    expect(button("Steer now").dataset.disabledReason).toMatch(/No provider turn is running/);
    expect(container.querySelector("[data-queue-reason]")?.textContent).toMatch(
      /Steer now is unavailable: No provider turn is running/,
    );
    expect(container.querySelector('[data-queued-sender="thread:release"]')?.textContent).toContain(
      "Release macOS app",
    );
    expect(container.querySelector('[data-queued-sender="you"]')?.textContent).toContain("You");
  });

  it("explains a queue held behind a usage limit or a failure", async () => {
    for (const [reason, header] of [
      ["usage_limit", "Queue · held by a usage limit"],
      ["failure", "Queue · held after a failure"],
    ] as const) {
      // A new projection, as the store hands out, recomputes the queue.
      state.projection = { projection: { messages: [] } };
      state.workflow = {
        activeRun: null,
        canPromoteToSteer: false,
        canReorder: true,
        isHeld: true,
        waitReason: reason,
        steerUnavailableReason: "No turn is running to steer into.",
        queuedRuns: [row("a", { run: { id: "run:a", userMessageId: "m", queueHeld: true } })],
      };
      await render();
      expect(container.querySelector("[data-queue-wait]")?.textContent).toBe(header);
      expect(container.querySelector("[data-queue-reason]")?.textContent?.length).toBeGreaterThan(
        20,
      );
    }
  });
});

describe("QueuedRunsControl automatic deliveries", () => {
  it("shows automatic rows read-only and never lets a message move ahead of one", async () => {
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      waitReason: "turn",
      steerUnavailableReason: null,
      queuedRuns: [
        row("result", { automatic: true, createdBy: "agent" }),
        row("a", { createdBy: "user" }),
        row("b", { createdBy: "user" }),
      ],
    };
    await render();

    const automatic = container.querySelectorAll("li")[0]!;
    expect(automatic.textContent).toContain("Delivers after this turn");
    expect(automatic.textContent).toContain("Automatic");
    expect(automatic.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll('[aria-label="Edit queued message"]')).toHaveLength(2);
    expect(container.querySelectorAll("button")).not.toHaveLength(0);

    // ArrowUp on the first person's row would land ahead of the delivery: ignored.
    const grip = container.querySelectorAll<HTMLButtonElement>(
      '[aria-label^="Reorder queued message"]',
    );
    expect(grip).toHaveLength(2);
    await act(async () =>
      grip[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })),
    );
    expect(state.calls).toEqual([]);
    await act(async () =>
      grip[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })),
    );
    expect(state.calls).toEqual([
      {
        command: "reorder",
        input: { threadId: "thread:test", runId: "run:b", beforeRunId: "run:a" },
      },
    ]);
  });

  it("shows a row being steered as in flight, removable but not steerable again", async () => {
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      waitReason: "turn",
      steerUnavailableReason: null,
      queuedRuns: [row("a", { steering: true })],
    };
    await render();
    expect(container.textContent).toContain("Steering…");
    expect(container.querySelector('[aria-label="Edit queued message"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Steer now"),
    ).toBe(false);
    expect(button("Remove queued message").disabled).toBe(false);
  });
});
