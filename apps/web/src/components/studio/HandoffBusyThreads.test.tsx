// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { HandoffBusyThreads } from "./HandoffBusyThreads";
import { ProjectMoveDialog, type ProjectMoveDialogContext } from "./ProjectMoveOptions";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, onClick }: any) => (
    <a
      href="#thread"
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("closes the move dialog when a thread opens, and labels each reason", async () => {
  const close = vi.fn();
  const dialog = { close } as unknown as ProjectMoveDialogContext;
  const reasons = [
    "running",
    "waiting_for_answer",
    "pending_approval",
    "provider_session",
    "pending_effect",
  ] as const;
  await act(async () =>
    root.render(
      <ProjectMoveDialog.Provider value={dialog}>
        <HandoffBusyThreads
          busy={{
            total: reasons.length,
            threads: reasons.map((reason) => ({
              threadId: reason as never,
              title: `Thread ${reason}`,
              projectId: "p" as never,
              reason,
            })),
          }}
          environmentId={"m4" as never}
          machineLabel="M4"
          projectTitle="Project"
        />
      </ProjectMoveDialog.Provider>,
    ),
  );
  expect(container.textContent).toContain("Running work");
  expect(container.textContent).toContain("Waiting for your answer");
  expect(container.textContent).toContain("Waiting for your approval");
  expect(container.textContent).toContain("Agent session running");
  expect(container.textContent).toContain("Step still pending");
  expect(container.textContent).not.toContain("more thread");
  await act(async () => container.querySelector("a")!.click());
  expect(close).toHaveBeenCalledTimes(1);
});
