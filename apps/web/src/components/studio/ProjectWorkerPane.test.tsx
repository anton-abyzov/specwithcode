// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ChatAttachment } from "@specweave-studio/contracts";
import { ProjectWorkerPane } from "./ProjectWorkerPane";

const state = vi.hoisted(() => ({
  send: vi.fn(),
  routing: null as import("../../studio/projectMessageRouting").ProjectMessageRouting | null,
  clear: vi.fn(),
  reportError: vi.fn(),
  draft: "Continue this work",
  attachments: [] as ChatAttachment[],
}));
vi.mock("./shell/ProjectThreadHeader", () => ({
  ProjectThreadHeader: () => <header>Worker</header>,
}));
vi.mock("./ProjectRoutedReplies", () => ({
  useRoutedThreadMessages: () => [{ id: "routed" }],
}));
vi.mock("../ChatView", async () => {
  const { useProjectMessageRouting, routeProjectComposerSend } =
    await import("../../studio/projectMessageRouting");
  return {
    default: ({ environmentId, threadId }: { environmentId: string; threadId: string }) => {
      const routing = useProjectMessageRouting();
      state.routing = routing;
      return (
        <section data-chat-environment={environmentId} data-chat-thread={threadId}>
          {routing?.routedMessages?.length ? <div data-routed-replies /> : null}
          <button
            onClick={() =>
              void routeProjectComposerSend(routing, {
                prompt: state.draft,
                hasOtherContent: false,
                nativeInput: false,
                prepareAttachments: async () => state.attachments,
                clear: () => {
                  state.draft = "";
                  state.clear();
                },
                reportError: state.reportError,
              })
            }
          >
            Send reply
          </button>
        </section>
      );
    },
  };
});
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  state.draft = "Continue this work";
  state.attachments = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = (environmentId = "m1") =>
  act(async () =>
    root.render(
      <ProjectWorkerPane
        project={{ environmentId: "m4", id: "project" } as never}
        thread={{ environmentId, id: "shared-thread-id", title: "Investigate the build" } as never}
        coordinatorId={"coordinator" as never}
        header={{} as never}
        openCoordinator={() => {}}
        openThread={() => false}
        send={state.send}
        suspendShortcuts={false}
        toolsSlot={null}
      />,
    ),
  );
const send = () => act(async () => container.querySelector<HTMLButtonElement>("button")!.click());

it.each([
  ["on another machine", "m1"],
  ["on this machine", "m4"],
])(
  "lets a worker %s take its message and files itself, with no coordinator turn",
  async (_, environmentId) => {
    state.attachments = [{ id: "pending-file" } as ChatAttachment];
    await render(environmentId);
    await send();
    expect(
      container.querySelector(
        `[data-chat-environment="${environmentId}"][data-chat-thread="shared-thread-id"]`,
      ),
    ).not.toBeNull();
    // Earlier messages that went elsewhere still show where they went.
    expect(container.querySelector("[data-routed-replies]")).not.toBeNull();
    expect(state.reportError).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
    // The composer's own send runs instead, so the draft is not cleared here.
    expect(state.clear).not.toHaveBeenCalled();
    expect(state.draft).toBe("Continue this work");
    expect(state.attachments).toHaveLength(1);
  },
);

it("never sends a message typed in a thread on another machine to the coordinator here", async () => {
  await render("m1");
  await expect(state.routing!.send("Keep going")).rejects.toThrow("on its own machine");
  expect(state.send).not.toHaveBeenCalled();
});
