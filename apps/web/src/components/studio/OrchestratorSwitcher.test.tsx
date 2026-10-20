// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";
import { OrchestratorSwitcher } from "./OrchestratorSwitcher";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const copy = (
  key: string,
  machine: string,
  role: OrchestratorCopy["role"] = "coordinator",
  canStart = false,
): OrchestratorCopy => ({ key, machine, folder: "/w/atlas", role, canStart });

const handlers = () => ({
  onView: vi.fn<(key: string) => void>(),
  onMove: vi.fn<(key: string) => void>(),
  onStart: vi.fn<(key: string) => void>(),
  onAllowWorkers: vi.fn<() => void>(),
});

async function renderSwitcher(
  props: Partial<Parameters<typeof OrchestratorSwitcher>[0]> & ReturnType<typeof handlers>,
) {
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="M4"
        connected
        statusDetail=""
        current="m4:p"
        copies={[copy("m4:p", "M4"), copy("minis:p", "Minis", "workers", true)]}
        unknown={[]}
        savedMachineMissing={false}
        {...props}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label^="Viewing M4"]')!.click(),
  );
}
const item = (role: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find((element) =>
    element.textContent?.includes(text),
  );

it("keeps viewing, moving and starting as separate actions", async () => {
  const calls = handlers();
  await renderSwitcher(calls);
  await act(async () => item("menuitemradio", "View Minis's orchestrator")!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("minis:p"));
  expect(calls.onMove).not.toHaveBeenCalled();
  expect(calls.onStart).not.toHaveBeenCalled();
});

it("switches the view only after its menu has closed", async () => {
  const menuOpenAtSwitch: boolean[] = [];
  const calls = handlers();
  calls.onView.mockImplementation(() =>
    menuOpenAtSwitch.push(document.querySelector('[role="menu"]') !== null),
  );
  await renderSwitcher(calls);
  await act(async () => item("menuitemradio", "View Minis's orchestrator")!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledTimes(1));
  expect(menuOpenAtSwitch).toEqual([false]);
});

it("moves the coordinator only from its own item", async () => {
  const calls = handlers();
  await renderSwitcher(calls);
  await act(async () => item("menuitem", "Move coordinator to Minis")!.click());
  expect(calls.onMove).toHaveBeenCalledWith("minis:p");
  expect(calls.onView).not.toHaveBeenCalled();
});

it("starts a coordinator on a ready workers-only copy", async () => {
  const calls = handlers();
  await renderSwitcher(calls);
  await act(async () => item("menuitem", "Start a coordinator on Minis")!.click());
  expect(calls.onStart).toHaveBeenCalledWith("minis:p");
  expect(calls.onView).not.toHaveBeenCalled();
});

it("leaves thread migration off until thread handoff is available", async () => {
  await renderSwitcher(handlers());
  const migrate = item("menuitem", "Migrate threads");
  expect(migrate?.getAttribute("aria-disabled")).toBe("true");
});

it("lists a linked machine never synced here as Unknown", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [copy("m4:p", "M4")],
    unknown: [{ key: "minis:p", machine: "Minis" }],
  });
  const unknown = item("menuitemradio", "Minis");
  expect(unknown?.textContent).toContain("Unknown");
  await act(async () => unknown!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("minis:p"));
});

it("labels an unreachable viewed machine read-only, never as live", async () => {
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="Minis"
        connected={false}
        statusDetail="Minis unreachable · last synced 5 min ago · read-only"
        current="minis:p"
        copies={[copy("m4:p", "M4"), copy("minis:p", "Minis")]}
        unknown={[]}
        savedMachineMissing={false}
        {...handlers()}
      />,
    ),
  );
  expect(container.querySelector("[data-orchestrator-status]")?.textContent).toContain(
    "Minis unreachable · last synced 5 min ago · read-only",
  );
});

it("shows a nickname as typed, never trimming its owner", async () => {
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="Anna's Air"
        hostLabel="Anna's MacBook Air"
        connected
        statusDetail=""
        current="air:p"
        copies={[copy("air:p", "Anna's Air")]}
        unknown={[]}
        savedMachineMissing={false}
        {...handlers()}
      />,
    ),
  );
  expect(container.querySelector(".sws-host-name")?.textContent).toBe("Anna's Air");
});
