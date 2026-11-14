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
): OrchestratorCopy => ({
  key,
  machine,
  folder: "/w/atlas",
  role,
  main: role === "coordinator",
  label:
    role === "coordinator"
      ? { text: "Main" }
      : role === "workers"
        ? { text: "Copy · main on {machine}", values: { machine: "M4" } }
        : role === "pending"
          ? { text: "Moving main" }
          : { text: "Separate project" },
  canStart,
});

const handlers = () => ({
  onView: vi.fn<(key: string) => void>(),
  onSend: vi.fn<() => void>(),
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

it("keeps viewing, sending and starting as separate actions", async () => {
  const calls = handlers();
  await renderSwitcher(calls);
  await act(async () => item("menuitemradio", "Minis")!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("minis:p"));
  expect(calls.onSend).not.toHaveBeenCalled();
  expect(calls.onStart).not.toHaveBeenCalled();
});

it("switches the view only after its menu has closed", async () => {
  const menuOpenAtSwitch: boolean[] = [];
  const calls = handlers();
  calls.onView.mockImplementation(() =>
    menuOpenAtSwitch.push(document.querySelector('[role="menu"]') !== null),
  );
  await renderSwitcher(calls);
  await act(async () => item("menuitemradio", "Minis")!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledTimes(1));
  expect(menuOpenAtSwitch).toEqual([false]);
});

it("offers one Send item for add, move and sync, whatever the other copies run", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [copy("m4:p", "M4"), copy("mini:p", "Mini"), copy("minis:p", "Minis", "workers")],
  });
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
  expect(labels.filter((label) => /^(Add|Move to|Sync to|Send)/.test(label ?? ""))).toEqual([
    "Send to another machine…",
  ]);
  await act(async () => item("menuitem", "Send to another machine…")!.click());
  await vi.waitFor(() => expect(calls.onSend).toHaveBeenCalledTimes(1));
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
  await act(async () => item("menuitem", "Move running threads…")!.click());
  await vi.waitFor(() => expect(onMigrate).toHaveBeenCalledTimes(1));
  expect(menuOpenAtMigrate).toEqual([false]);
  expect(calls.onView).not.toHaveBeenCalled();
  expect(calls.onSend).not.toHaveBeenCalled();
  expect(calls.onStart).not.toHaveBeenCalled();
});

it("leaves thread migration off while the viewed machine is unreachable", async () => {
  await renderSwitcher(handlers());
  const migrate = item("menuitem", "Move running threads…");
  expect(migrate?.getAttribute("aria-disabled")).toBe("true");
  expect(migrate?.textContent).toBe("Move running threads…M4 offline");
});

it("lists a linked machine this app has no connection to as not connected", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [copy("m4:p", "M4")],
    unknown: [{ key: "minis:p", machine: "Minis" }],
  });
  const unknown = item("menuitemradio", "Minis");
  expect(unknown?.textContent).toBe("Minisnot connected");
  expect(unknown?.title).toBe(
    "This app isn't connected to Minis, so its copy can't be shown. Connect it in Settings > Machines.",
  );
  await act(async () => unknown!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("minis:p"));
});

it("marks an unreachable viewed machine by its dot, never as live", async () => {
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="Minis"
        connected={false}
        statusDetail="Reconnecting"
        current="minis:p"
        copies={[copy("m4:p", "M4"), copy("minis:p", "Minis")]}
        unknown={[]}
        savedMachineMissing={false}
        {...handlers()}
      />,
    ),
  );
  // The chip says the state in a word, for screen readers; the line above the
  // message box says the rest. Nothing about it is drawn in the chip but the dot.
  expect(container.querySelector("[data-orchestrator-status]")?.textContent).toBe(", Reconnecting");
  expect(container.querySelector("[data-orchestrator-status]")?.className).toBe("sr-only");
  expect(container.querySelector('.sws-dot[data-tone="failed"]')).not.toBeNull();
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
  expect(container.querySelector(".sws-host-name")?.textContent).toBe("Runs on Anna's Air");
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

it("offers Send and Leave in one machine menu, even with one copy", async () => {
  const onSend = vi.fn<() => void>();
  const onLeave = vi.fn<() => void>();
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="M4"
        connected
        statusDetail=""
        current="m4:p"
        copies={[copy("m4:p", "M4")]}
        unknown={[]}
        savedMachineMissing={false}
        onView={vi.fn()}
        onStart={null}
        onAllowWorkers={null}
        onSend={onSend}
        onLeave={onLeave}
      />,
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(`[aria-label="M4: this project's machines"]`)!
      .click(),
  );
  expect(document.querySelector('[role="menuitemradio"]')).toBeNull();
  expect(item("menuitem", "Leave this machine…")).toBeDefined();
  await act(async () => item("menuitem", "Send to another machine…")!.click());
  await vi.waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
  expect(onLeave).not.toHaveBeenCalled();
});

it("names machines once and labels every group of actions", async () => {
  const calls = handlers();
  await renderSwitcher({ ...calls, onLeave: vi.fn() });
  expect(
    [...document.querySelectorAll('[role="menuitemradio"]')].map((row) => row.textContent),
  ).toEqual(["M4Main", "MinisCopy · main on M4"]);
  expect(
    [...document.querySelectorAll('[data-slot="menu-label"]')].map((row) => row.textContent),
  ).toEqual(["View this project on", "This project", "On M4"]);
  expect([...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual(
    [
      "Send to another machine…",
      "Start a coordinator on Minis",
      "Move running threads…M4 offline",
      "Leave this machine…",
      "Machine access settings",
    ],
  );
  expect(document.querySelector('[role="menu"]')?.textContent).not.toMatch(/orchestrator/i);
  await act(async () => item("menuitem", "Machine access settings")!.click());
  expect(calls.onAllowWorkers).toHaveBeenCalledTimes(1);
});

it("stays a plain label with one copy and no machine actions", async () => {
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="M4"
        connected
        statusDetail=""
        current="m4:p"
        copies={[copy("m4:p", "M4")]}
        unknown={[]}
        savedMachineMissing={false}
        onView={vi.fn()}
        onStart={null}
        onAllowWorkers={null}
      />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
});
