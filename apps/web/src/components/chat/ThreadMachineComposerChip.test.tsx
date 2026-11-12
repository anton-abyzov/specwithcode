// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
const move = vi.hoisted(() => vi.fn());
vi.mock("../handoff/HandOffThreadDialog", () => ({ requestHandOffThread: move }));
vi.mock("../handoff/useHandoffDestinations", () => ({
  useHandoffDestinations: () => [
    { environmentId: "other", label: "Laptop", state: "reachable" },
    { environmentId: "offline", label: "Offline machine", state: "offline", reason: "Offline" },
  ],
}));
import { ThreadMachineComposerChip } from "./ThreadMachineComposerChip";
let root: ReturnType<typeof createRoot>;
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  move.mockReset();
});
async function mount(canMove: boolean) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <ThreadMachineComposerChip
        machine={{
          kind: "laptop",
          label: "Build machine",
          tip: "Runs here",
          warning: null,
          color: "blue",
          canMove,
        }}
        size="sm"
        threadRef={{ environmentId: "source", threadId: "thread" } as any}
      />,
    ),
  );
  return container;
}
it("opens existing confirmed handoff for the chosen destination and disables offline machines", async () => {
  const container = await mount(true);
  expect(container.querySelector("[data-machine-color]")?.getAttribute("data-machine-color")).toBe(
    "blue",
  );
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
  expect(
    items.find((el) => el.textContent?.includes("Offline machine"))?.getAttribute("aria-disabled"),
  ).toBe("true");
  await act(async () => items.find((el) => el.textContent === "Move to Laptop")!.click());
  expect(move).toHaveBeenCalledWith(
    { environmentId: "source", threadId: "thread" },
    { destinationEnvironmentId: "other" },
  );
});
it("does not offer migration for private, moved or unauthorized threads", async () => {
  const container = await mount(false);
  expect(container.querySelector('[aria-haspopup="menu"]')).toBeNull();
  expect(container.textContent).toContain("Runs on Build machine");
});
