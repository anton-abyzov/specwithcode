// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import type { ProjectMessageRouting } from "../../studio/projectMessageRouting";
import { ProjectCoordinatorDetails } from "./ProjectCoordinatorDetails";

const native = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  answer: vi.fn(),
  unmount: vi.fn(),
  items: [] as unknown[],
  detail: vi.fn(() => ({ data: undefined as unknown, isPending: false, error: null })),
}));
vi.mock("../../state/queries", () => ({
  useTurnItemDetail: native.detail,
}));
vi.mock("../chat/toolOutputPresentation", () => ({
  ToolCodePanel: ({ label, text }: { label: string; text: string }) => (
    <pre aria-label={label}>{text}</pre>
  ),
}));
vi.mock("../../state/entities", () => ({
  useThreadProjection: () => ({ projection: { turnItems: native.items } }),
  useThreadStatus: () => "live",
}));
vi.mock("../ChatView", () => ({
  default: (props: Record<string, unknown>) => {
    native.props = props;
    useEffect(() => () => native.unmount(props.threadId), []);
    return <button onClick={native.answer}>Answer native question</button>;
  },
}));
let root: Root, container: HTMLDivElement, trigger: HTMLButtonElement;
let routing: ProjectMessageRouting;
beforeEach(() => {
  vi.clearAllMocks();
  native.props = null;
  native.items = [];
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  trigger = document.createElement("button");
  container = document.createElement("div");
  document.body.append(trigger, container);
  trigger.focus();
  root = createRoot(container);
  routing = {
    coordinatorThreadId: "coord" as never,
    send: vi.fn(async () => {}),
    openCoordinator: vi.fn(),
    openThread: vi.fn(() => true),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  trigger.remove();
});
const mount = (view: "requests" | "activity" = "requests") =>
  act(async () =>
    root.render(
      <ProjectCoordinatorDetails
        environmentId={"host" as never}
        threadId={"coord" as never}
        routing={routing}
        view={view}
        onClose={() => root.render(null)}
      />,
    ),
  );
const click = (text: string) =>
  act(async () =>
    [...document.querySelectorAll("button")].find((button) => button.textContent === text)!.click(),
  );
it("opens a named modal for native controls, without another conversation or message composer", async () => {
  await mount();
  expect(native.props).toMatchObject({
    environmentId: "host",
    threadId: "coord",
    layoutMode: "embedded",
    routeKind: "server",
    reviewOnly: true,
  });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
  expect(dialog.textContent).toContain("Coordinator requests");
  expect(dialog.textContent).not.toContain("Back to coordinator");
  expect(dialog.querySelector("textarea")).toBeNull();
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
  await click("Answer native question");
  expect(native.answer).toHaveBeenCalledOnce();
  expect(routing.send).not.toHaveBeenCalled();
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click(),
  );
  expect(document.activeElement).toBe(trigger);
});
it("Escape dismisses review and restores the originating control", async () => {
  await mount();
  await act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
it("shows expandable tool output without mounting native chat or duplicating user messages", async () => {
  native.items = [
    { id: "u", type: "user_message", status: "completed", text: "Private user message" },
    {
      id: "t",
      type: "dynamic_tool",
      status: "completed",
      toolName: "Read",
      output: "File content",
    },
  ];
  await mount("activity");
  expect(native.props).toBeNull();
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("Coordinator activity");
  const item = dialog.querySelector("details")!;
  expect(item.querySelector("pre")).toBeNull();
  await act(async () => {
    item.open = true;
    item.dispatchEvent(new Event("toggle"));
  });
  expect(item.querySelector("pre")!.textContent).toContain("File content");
  expect(dialog.textContent).not.toContain("Private user message");
});

it("fetches withheld tool output lazily using the exact host, thread, item, and revision", async () => {
  native.items = [
    {
      id: "tool",
      threadId: "coord",
      type: "dynamic_tool",
      status: "completed",
      toolName: "Read",
      input: "README",
      outputOmitted: true,
      updatedAt: DateTime.makeUnsafe("2026-10-13T12:00:00Z"),
    },
  ];
  await mount("activity");
  expect(native.detail).toHaveBeenCalledWith(null);
  const item = document.querySelector('[role="dialog"] details') as HTMLDetailsElement;
  native.detail.mockReturnValue({
    data: {
      item: {
        ...(native.items[0] as object),
        outputOmitted: false,
        output: "Complete file content",
      },
    },
    isPending: false,
    error: null,
  });
  await act(async () => {
    item.open = true;
    item.dispatchEvent(new Event("toggle"));
  });
  expect(native.detail).toHaveBeenLastCalledWith({
    environmentId: "host",
    threadId: "coord",
    itemId: "tool",
    revision: "2026-10-13T12:00:00.000Z",
  });
  expect(item.querySelector('[aria-label="Output"]')!.textContent).toBe("Complete file content");
});

it("remounts request controls when the coordinator scope changes", async () => {
  await mount();
  await act(async () =>
    root.render(
      <ProjectCoordinatorDetails
        environmentId={"host" as never}
        threadId={"another-coord" as never}
        routing={{ ...routing, coordinatorThreadId: "another-coord" as never }}
        onClose={() => root.render(null)}
      />,
    ),
  );
  expect(native.unmount).toHaveBeenCalledExactlyOnceWith("coord");
  expect(native.props?.threadId).toBe("another-coord");
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
});
