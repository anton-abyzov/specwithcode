// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";

const startCoordinator = vi.hoisted(() => vi.fn());
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => startCoordinator }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { OrchestratorSwitcher, useStartCoordinator } from "./OrchestratorSwitcher";

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
  await act(async () => item("menuitem", "Hand off coordinator to Minis")!.click());
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

it("opens thread migration as its own action, after the menu closes", async () => {
  const calls = handlers();
  const menuOpenAtMigrate: boolean[] = [];
  const onMigrate = vi.fn(() =>
    menuOpenAtMigrate.push(document.querySelector('[role="menu"]') !== null),
  );
  await renderSwitcher({ ...calls, onMigrate });
  await act(async () => item("menuitem", "Move M4's running threads…")!.click());
  await vi.waitFor(() => expect(onMigrate).toHaveBeenCalledTimes(1));
  expect(menuOpenAtMigrate).toEqual([false]);
  expect(calls.onView).not.toHaveBeenCalled();
  expect(calls.onMove).not.toHaveBeenCalled();
  expect(calls.onStart).not.toHaveBeenCalled();
});

it("leaves thread migration off while the viewed machine is unreachable", async () => {
  await renderSwitcher(handlers());
  const migrate = item("menuitem", "Move M4's running threads…");
  expect(migrate?.getAttribute("aria-disabled")).toBe("true");
  expect(migrate?.textContent).toBe("Move M4's running threads… (M4 offline)");
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

it("runs one coordinator start at a time across the switcher and the composer notice", async () => {
  let finish!: (value: { _tag: "Success" }) => void;
  startCoordinator
    .mockReset()
    .mockResolvedValue({ _tag: "Success" })
    .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
  const members = [
    { environmentId: "minis", id: "p", workspaceSettings: { logicalProject: { id: "atlas" } } },
  ] as unknown as EnvironmentProject[];
  const copies = [copy("minis:p", "Minis", "workers", true)];
  const starts: Array<(key: string) => Promise<void>> = [];
  // Two buttons on one page, each with its own hook, as the switcher and the notice are.
  function Starter() {
    starts.push(useStartCoordinator(members, copies));
    return null;
  }
  await act(async () =>
    root.render(
      <>
        <Starter />
        <Starter />
      </>,
    ),
  );
  const first = starts[0]!("minis:p");
  await starts[1]!("minis:p");
  expect(startCoordinator).toHaveBeenCalledTimes(1);
  finish({ _tag: "Success" });
  await first;
  // Once that start settles, another may run.
  await starts[1]!("minis:p");
  expect(startCoordinator).toHaveBeenCalledTimes(2);
});
