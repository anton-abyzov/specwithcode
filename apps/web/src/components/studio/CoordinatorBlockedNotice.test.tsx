// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";

const start = vi.hoisted(() => vi.fn(async (_key: string) => undefined));
// The switcher's own start action; this notice only offers it.
vi.mock("./OrchestratorSwitcher", () => ({ useStartCoordinator: () => start }));

import { CoordinatorBlockedNotice } from "./CoordinatorBlockedNotice";

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  start.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const copy = (key: string, machine: string, canStart: boolean): OrchestratorCopy => ({
  key,
  machine,
  folder: `/${machine}/atlas`,
  role: canStart ? "workers" : "coordinator",
  canStart,
});
const buttons = () => [...container.querySelectorAll("button")].map((b) => b.textContent);

async function show(props: Partial<Parameters<typeof CoordinatorBlockedNotice>[0]> = {}) {
  await act(async () =>
    root.render(
      <CoordinatorBlockedNotice
        text="This copy runs workers only."
        coordinator={{ key: "m4:main", machine: "Anton's MacBook" }}
        current="minis:copy"
        members={[]}
        copies={[copy("m4:main", "Anton's MacBook", false), copy("minis:copy", "ministorm", true)]}
        onOpen={() => {}}
        {...props}
      />,
    ),
  );
}

it("opens the coordinator's checkout and starts a coordinator here through the existing action", async () => {
  const onOpen = vi.fn();
  await show({ onOpen });
  expect(buttons()).toEqual([
    "Open Anton's MacBook's coordinator",
    "Start a coordinator on ministorm",
  ]);
  await act(async () => container.querySelectorAll("button")[0]!.click());
  expect(onOpen).toHaveBeenCalledWith("m4:main");
  await act(async () => container.querySelectorAll("button")[1]!.click());
  expect(start).toHaveBeenCalledWith("minis:copy");
});

it("offers no start where a coordinator cannot start, and no open before choices load", async () => {
  await show({
    copies: [copy("minis:copy", "ministorm", false)],
    onOpen: null,
  });
  expect(buttons()).toEqual([]);
  expect(container.textContent).toBe("This copy runs workers only.");
});

it("says any other reason plainly, with no actions", async () => {
  await show({ text: "Reconnect its machine to send messages.", coordinator: null });
  expect(container.querySelector("[data-workers-only]")).toBeNull();
  expect(buttons()).toEqual([]);
  expect(container.querySelector("[role='status']")?.textContent).toBe(
    "Reconnect its machine to send messages.",
  );
});
