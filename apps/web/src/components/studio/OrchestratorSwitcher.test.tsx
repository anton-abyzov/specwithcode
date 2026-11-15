// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";

const startCoordinator = vi.hoisted(() => vi.fn());
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => startCoordinator }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));

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
          : { text: "not linked" },
  canStart,
});

const handlers = () => ({
  onView: vi.fn<(key: string) => void>(),
  onMove: vi.fn<(key: string) => void>(),
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

it("keeps viewing and moving as separate actions", async () => {
  const calls = handlers();
  await renderSwitcher(calls);
  await act(async () => item("menuitemradio", "Minis")!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("minis:p"));
  expect(calls.onMove).not.toHaveBeenCalled();
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

it("moves the coordinator only from its own item", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [copy("m4:p", "M4"), copy("minis:p", "Minis", "workers")],
  });
  await act(async () => item("menuitem", "Move coordinator to Minis…")!.click());
  expect(calls.onMove).toHaveBeenCalledWith("minis:p");
  expect(calls.onView).not.toHaveBeenCalled();
});

it("offers the coordinator-only move only to copies that run workers", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [copy("m4:p", "M4"), copy("mini:p", "Mini"), copy("minis:p", "Minis", "workers")],
  });
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
  expect(labels).not.toContain("Move coordinator to Mini…");
  expect(labels).toContain("Move coordinator to Minis…");
  expect(labels.some((label) => label?.startsWith("Sync to"))).toBe(false);
});

it("lists a machine that kept its coordinator once, as paused, with nothing to start here", async () => {
  const calls = handlers();
  await renderSwitcher(calls);
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(rows.map((row) => row.textContent)).toEqual(["M4Main", "Miniscoordinator paused"]);
  expect(rows[1]?.title).toBe(
    "Minis kept its coordinator from before and now runs workers only. View it to read that conversation or run it again.",
  );
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
  // Viewing is the one way to that coordinator: no Open, Start or Move beside it.
  expect(labels.filter((label) => label?.includes("Minis"))).toEqual([]);
  await act(async () => rows[1]!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("minis:p"));
  expect(calls.onMove).not.toHaveBeenCalled();
});

it("offers one item per machine, and none where any copy there coordinates or kept one", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [
      copy("m4:p", "M4"),
      // Two checkouts on m1: one kept its coordinator, so m1 gets no move.
      { ...copy("m1:a", "M1", "workers"), folder: "/w/a" },
      { ...copy("m1:b", "M1", "workers", true), folder: "/w/b" },
      // On m3 one copy runs its own coordinator, so the workers copy beside it gets nothing.
      copy("m3:a", "M3"),
      { ...copy("m3:b", "M3", "workers"), folder: "/w/b" },
      // m5 has two workers-only copies and gets one move.
      { ...copy("m5:a", "M5", "workers"), folder: "/w/a" },
      { ...copy("m5:b", "M5", "workers"), folder: "/w/b" },
    ],
  });
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
  expect(labels.filter((label) => /coordinator/.test(label ?? ""))).toEqual([
    "Move coordinator to M5 · /w/a…",
  ]);
});

it("says why when a coordinator does not start, and stays on this machine", async () => {
  toast.mockReset();
  startCoordinator.mockReset().mockResolvedValue({
    _tag: "Failure",
    cause: { _tag: "Fail", error: new Error("Reconnect M1 first.") },
  });
  const members = [
    { environmentId: "minis", id: "p", workspaceSettings: { logicalProject: { id: "atlas" } } },
  ] as unknown as EnvironmentProject[];
  let start!: (key: string) => Promise<boolean>;
  function Starter() {
    start = useStartCoordinator(members, [copy("minis:p", "Minis", "workers", true)]);
    return null;
  }
  await act(async () => root.render(<Starter />));
  expect(await start("minis:p")).toBe(false);
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Minis did not start a coordinator" }),
  );
});

it("offers nothing for a machine that already runs its own coordinator, but lists it to view", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [copy("m4:p", "M4"), copy("mini:p", "Mini"), copy("m1:p", "M1", "workers")],
  });
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
  expect(labels.filter((label) => label?.includes("Mini"))).toEqual([]);
  expect(labels.filter((label) => label?.includes("M1"))).toEqual(["Move coordinator to M1…"]);
  expect(item("menuitemradio", "Mini")).toBeDefined();
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
  expect(calls.onMove).not.toHaveBeenCalled();
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
  const starts: Array<(key: string) => Promise<boolean>> = [];
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
  expect(await starts[1]!("minis:p")).toBe(false);
  expect(startCoordinator).toHaveBeenCalledTimes(1);
  finish({ _tag: "Success" });
  expect(await first).toBe(true);
  // Once that start settles, another may run.
  await starts[1]!("minis:p");
  expect(startCoordinator).toHaveBeenCalledTimes(2);
});

it("offers one Copy to another machine and Leave, even with one copy", async () => {
  const onCopy = vi.fn<() => void>();
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
        onMove={null}
        onAllowWorkers={null}
        onCopy={onCopy}
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
  expect(item("menuitem", "Add to another machine…")).toBeUndefined();
  expect(item("menuitem", "Move to another machine…")).toBeUndefined();
  await act(async () => item("menuitem", "Copy to another machine…")!.click());
  await vi.waitFor(() => expect(onCopy).toHaveBeenCalledTimes(1));
  expect(onLeave).not.toHaveBeenCalled();
});

it("names machines once and labels every group of actions", async () => {
  const calls = handlers();
  await renderSwitcher({ ...calls, onCopy: vi.fn(), onLeave: vi.fn() });
  expect(
    [...document.querySelectorAll('[role="menuitemradio"]')].map((row) => row.textContent),
  ).toEqual(["M4Main", "Miniscoordinator paused"]);
  expect(
    [...document.querySelectorAll('[data-slot="menu-label"]')].map((row) => row.textContent),
  ).toEqual(["View this project on", "This project", "On M4"]);
  expect([...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent)).toEqual(
    [
      "Copy to another machine…",
      "Move running threads…M4 offline",
      "Leave this machine…",
      "Machine access settings",
    ],
  );
  expect(document.querySelector('[role="menu"]')?.textContent).not.toMatch(/orchestrator/i);
  await act(async () => item("menuitem", "Machine access settings")!.click());
  expect(calls.onAllowWorkers).toHaveBeenCalledTimes(1);
});

it("says not linked, with what that means, for checkouts registered on their own", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [copy("m4:p", "M4", "independent"), copy("m1:p", "M1", "independent")],
  });
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(rows.map((row) => row.textContent)).toEqual(["M4not linked", "M1not linked"]);
  expect(rows[1]?.title).toBe(
    "Not linked: M1 runs its own coordinator, threads and memory for this repository.",
  );
  expect(document.querySelector('[role="menu"]')?.textContent).not.toContain("separate project");
});

it("offers to link each same-repository project on another machine, from its own item", async () => {
  const calls = handlers();
  const onLink = vi.fn<(key: string) => void>();
  await renderSwitcher({
    ...calls,
    onLink,
    // Not listed among this project's machines: the two were never linked.
    links: [{ key: "m5:old", machine: "M5" }],
  });
  const links = [...document.querySelectorAll<HTMLElement>("[data-orchestrator-link]")];
  expect(links.map((link) => link.textContent)).toEqual(["Link with the project on M5…"]);
  expect(links[0]?.title).toContain("one project with one coordinator");
  await act(async () => links[0]!.click());
  await vi.waitFor(() => expect(onLink).toHaveBeenCalledWith("m5:old"));
  expect(calls.onView).not.toHaveBeenCalled();
  expect(calls.onMove).not.toHaveBeenCalled();
});

it("offers no link where linking is not allowed or nothing matches", async () => {
  const calls = handlers();
  await renderSwitcher({ ...calls, links: [{ key: "m5:old", machine: "M5" }] });
  expect(document.querySelector("[data-orchestrator-link]")).toBeNull();
  await act(async () => root.render(<></>));
  await renderSwitcher({ ...calls, onLink: vi.fn<(key: string) => void>() });
  expect(document.querySelector("[data-orchestrator-link]")).toBeNull();
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
        onMove={null}
        onAllowWorkers={null}
      />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
});
