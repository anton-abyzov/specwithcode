// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { ChatAttachment } from "@specweave-studio/contracts";
import { ProjectWorkerPane } from "./ProjectWorkerPane";

const state = vi.hoisted(() => ({
  send: vi.fn(),
  clear: vi.fn(),
  reportError: vi.fn(),
  draft: "Continue this work",
  attachments: [] as ChatAttachment[],
}));
vi.mock("./shell/ProjectThreadHeader", () => ({
  ProjectThreadHeader: () => <header>Worker</header>,
}));
vi.mock("./ProjectRoutedReplies", () => ({
  // A remote worker gets no coordinator, so nothing is placed in its timeline.
  useRoutedThreadMessages: (_project: unknown, coordinatorId: string | null) =>
    coordinatorId ? [{ id: "routed" }] : [],
}));
vi.mock("../ChatView", async () => {
  const { useProjectMessageRouting, routeProjectComposerSend } =
    await import("../../studio/projectMessageRouting");
  return {
    default: ({ environmentId, threadId }: { environmentId: string; threadId: string }) => {
      const routing = useProjectMessageRouting();
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
  state.send.mockResolvedValue(undefined);
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

it("opens the selected remote copy and includes its machine in the coordinator reply instead of a colliding local thread id", async () => {
  await render();
  await send();
  expect(
    container.querySelector('[data-chat-environment="m1"][data-chat-thread="shared-thread-id"]'),
  ).not.toBeNull();
  expect(container.querySelector("[data-routed-replies]")).toBeNull();
  expect(state.send).toHaveBeenCalledWith(
    "Regarding thread shared-thread-id on machine m1 (Investigate the build):\n\nContinue this work",
  );
  expect(state.clear).toHaveBeenCalledTimes(1);
});

it("keeps remote reply drafts and attachments when their files cannot safely cross hosts", async () => {
  state.attachments = [{ id: "pending-remote-file" } as ChatAttachment];
  await render();
  await send();
  expect(state.send).not.toHaveBeenCalled();
  expect(state.clear).not.toHaveBeenCalled();
  expect(state.draft).toBe("Continue this work");
  expect(state.attachments).toHaveLength(1);
  expect(state.reportError).toHaveBeenCalledWith(
    "Attach files in the coordinator composer when replying across machines.",
  );
});

it("preserves the remote draft when the coordinator rejects the routed request", async () => {
  state.send.mockRejectedValue(new Error("Coordinator connection lost"));
  await render();
  await send();
  expect(state.reportError).toHaveBeenCalledWith("Coordinator connection lost");
  expect(state.clear).not.toHaveBeenCalled();
  expect(state.draft).toBe("Continue this work");
});

it("keeps same-host replies and staged files associated with their local worker", async () => {
  state.attachments = [{ id: "pending-local-file" } as ChatAttachment];
  await render("m4");
  await send();
  expect(container.querySelector("[data-routed-replies]")).not.toBeNull();
  expect(state.send).toHaveBeenCalledWith(
    "Continue this work",
    "shared-thread-id",
    state.attachments,
  );
  expect(state.reportError).not.toHaveBeenCalled();
  expect(state.clear).toHaveBeenCalledTimes(1);
});
