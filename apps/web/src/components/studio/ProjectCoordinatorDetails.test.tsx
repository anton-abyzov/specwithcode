// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ProjectMessageRouting } from "../../studio/projectMessageRouting";
import { ProjectCoordinatorDetails } from "./ProjectCoordinatorDetails";

const native = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
  answer: vi.fn(),
}));
vi.mock("../ChatView", async () => {
  const { useProjectMessageRouting, routeProjectComposerSend } =
    await import("../../studio/projectMessageRouting");
  return {
    default: (props: Record<string, unknown>) => {
      native.props = props;
      const routing = useProjectMessageRouting();
      const send = async (nativeInput: boolean) => {
        const routed = await routeProjectComposerSend(routing, {
          prompt: "Continue",
          hasOtherContent: false,
          nativeInput,
          clear: () => {},
          reportError: () => {},
        });
        if (!routed) native.answer();
      };
      return (
        <div>
          {routing?.coordinatorModelControls}
          <button onClick={() => void send(false)}>Message</button>
          <button onClick={() => void send(true)}>Answer native question</button>
        </div>
      );
    },
  };
});
let root: Root, container: HTMLDivElement, trigger: HTMLButtonElement;
let routing: ProjectMessageRouting;
beforeEach(() => {
  vi.clearAllMocks();
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
    coordinatorModelControls: <span>Project saved model</span>,
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  trigger.remove();
});
const mount = () =>
  act(async () =>
    root.render(
      <ProjectCoordinatorDetails
        environmentId={"host" as never}
        threadId={"coord" as never}
        routing={routing}
        onClose={() => root.render(null)}
      />,
    ),
  );
const click = (text: string) =>
  act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === text)!
      .click(),
  );
it("embeds coordinator controls, focuses Back, and restores the attention trigger", async () => {
  await mount();
  expect(native.props).toMatchObject({
    environmentId: "host",
    threadId: "coord",
    layoutMode: "embedded",
    routeKind: "server",
    reserveTitleBarControlInset: false,
  });
  expect(native.props!.embeddedHeaderToolsTarget).toBeInstanceOf(HTMLSpanElement);
  expect(document.activeElement?.textContent).toBe("Back to coordinator");
  expect(container.textContent).toContain("Project saved model");
  await click("Back to coordinator");
  expect(document.activeElement).toBe(trigger);
});
it("routes ordinary replies once and leaves native questions in their runtime", async () => {
  await mount();
  await click("Message");
  expect(routing.send).toHaveBeenCalledExactlyOnceWith("Continue");
  await click("Answer native question");
  expect(native.answer).toHaveBeenCalledOnce();
  expect(routing.send).toHaveBeenCalledOnce();
});
