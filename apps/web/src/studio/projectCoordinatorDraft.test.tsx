// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  enqueueProjectCoordinatorDraft,
  useProjectCoordinatorDraft,
} from "./projectCoordinatorDraft";
let root: Root, container: HTMLElement;
const prefill = vi.fn();
function Harness({ environmentId, projectId }: { environmentId: string; projectId: string }) {
  useProjectCoordinatorDraft(environmentId, projectId, prefill);
  return null;
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  prefill.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
});
it("queues by exact checkout until mounted, then consumes once under StrictMode", async () => {
  enqueueProjectCoordinatorDraft({ environmentId: "m1", projectId: "project", text: "PR request" });
  await act(async () => root.render(<Harness environmentId="m4" projectId="project" />));
  expect(prefill).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <StrictMode>
        <Harness environmentId="m1" projectId="project" />
      </StrictMode>,
    ),
  );
  expect(prefill).toHaveBeenCalledExactlyOnceWith("PR request");
  await act(async () =>
    enqueueProjectCoordinatorDraft({
      environmentId: "m1",
      projectId: "project",
      text: "Follow-up",
    }),
  );
  expect(prefill.mock.calls).toEqual([["PR request"], ["Follow-up"]]);
});
it("keeps requests staged for an unmounted project in order", async () => {
  enqueueProjectCoordinatorDraft({ environmentId: "offline", projectId: "later", text: "First" });
  enqueueProjectCoordinatorDraft({ environmentId: "offline", projectId: "later", text: "Second" });
  await act(async () => root.render(<Harness environmentId="offline" projectId="later" />));
  expect(prefill).toHaveBeenCalledExactlyOnceWith("First\n\nSecond");
});
