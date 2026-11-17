// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { MainOffer } from "../../studio/makeMain";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";

const startCoordinator = vi.hoisted(() => vi.fn());
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => startCoordinator }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("../ui/toast", () => ({ toastManager: { add: toast } }));

import { linkKeeper, OrchestratorSwitcher, useStartCoordinator } from "./OrchestratorSwitcher";

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
  onMakeMain: vi.fn<(key: string) => void>(),
  onAllowWorkers: vi.fn<() => void>(),
});
/** The switch `useMakeMain` works out for a copy: pressable, or off with its reason. */
const offer = (key: string, machine: string, extra: Partial<MainOffer> = {}): MainOffer => ({
  key,
  machine,
  main: "M4",
  kind: "move",
  reason: null,
  note: null,
  ...extra,
});
const makeMainItems = () => [
  ...document.querySelectorAll<HTMLElement>("[data-orchestrator-make-main]"),
];

async function renderSwitcher(
  props: Partial<Parameters<typeof OrchestratorSwitcher>[0]> &
    Pick<Parameters<typeof OrchestratorSwitcher>[0], "onView" | "onAllowWorkers">,
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
        mainOffers={[offer("minis:p", "Minis"), offer("m1:p", "M1"), offer("m5:a", "M5")]}
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

it("keeps viewing and switching main as separate actions", async () => {
  const calls = handlers();
  await renderSwitcher(calls);
  await act(async () => item("menuitemradio", "Minis")!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("minis:p"));
  expect(calls.onMakeMain).not.toHaveBeenCalled();
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

it("makes a copy main only from its own item, after the menu has closed", async () => {
  const calls = handlers();
  const menuOpenAtSwitch: boolean[] = [];
  calls.onMakeMain.mockImplementation(() =>
    menuOpenAtSwitch.push(document.querySelector('[role="menu"]') !== null),
  );
  await renderSwitcher({
    ...calls,
    copies: [copy("m4:p", "M4"), copy("minis:p", "Minis", "workers")],
  });
  expect(makeMainItems()[0]?.title).toBe(
    "Moves the coordinator and its conversation from M4 to Minis. M4 becomes a copy. You confirm first.",
  );
  await act(async () => item("menuitem", "Make Minis main")!.click());
  await vi.waitFor(() => expect(calls.onMakeMain).toHaveBeenCalledWith("minis:p"));
  expect(menuOpenAtSwitch).toEqual([false]);
  expect(calls.onView).not.toHaveBeenCalled();
});

it("offers Make main to linked copies only: never to main, never to a copy that is not linked", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [
      copy("m4:p", "M4"),
      copy("mini:p", "Mini"),
      copy("minis:p", "Minis", "workers"),
      copy("m3:p", "M3", "independent"),
    ],
    // An offer for a copy that is not linked is never shown: it has no main to become.
    mainOffers: [offer("minis:p", "Minis"), offer("m3:p", "M3"), offer("m4:p", "M4")],
  });
  expect(makeMainItems().map((row) => row.textContent)).toEqual(["Make Minis main"]);
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
  expect(labels.some((label) => label?.startsWith("Move coordinator"))).toBe(false);
  expect(labels.some((label) => label?.startsWith("Sync to"))).toBe(false);
});

it("has no Make main while the page cannot run the switch, or for a copy with no offer", async () => {
  await renderSwitcher({ ...handlers(), onMakeMain: null });
  expect(makeMainItems()).toEqual([]);
  await act(async () => root.render(<></>));
  await renderSwitcher({ ...handlers(), mainOffers: [] });
  expect(makeMainItems()).toEqual([]);
});

it("offers Make main on the copy's own page, for the viewed copy", async () => {
  const calls = handlers();
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="Minis"
        connected
        statusDetail=""
        current="minis:p"
        copies={[copy("m4:p", "M4"), copy("minis:p", "Minis", "workers")]}
        unknown={[]}
        savedMachineMissing={false}
        mainOffers={[offer("minis:p", "Minis")]}
        {...calls}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label^="Viewing Minis"]')!.click(),
  );
  expect(makeMainItems().map((row) => row.textContent)).toEqual(["Make Minis main"]);
});

it("keeps Make main off, saying when it unlocks, until the old main has been gone long enough", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [copy("m4:p", "M4"), copy("minis:p", "Minis", "workers")],
    mainOffers: [
      offer("minis:p", "Minis", {
        kind: "blocked",
        reason: {
          text: "{main} must be unreachable for 10 minutes before {machine} can become main. That unlocks in {minutes} min.",
          values: { main: "M4", machine: "Minis", minutes: "7" },
        },
        note: { text: "in {minutes} min", values: { minutes: "7" } },
      }),
    ],
  });
  const row = makeMainItems()[0]!;
  expect(row.textContent).toBe("Make Minis mainin 7 min");
  expect(row.getAttribute("aria-disabled")).toBe("true");
  expect(row.title).toBe(
    "M4 must be unreachable for 10 minutes before Minis can become main. That unlocks in 7 min.",
  );
  await act(async () => row.click());
  expect(calls.onMakeMain).not.toHaveBeenCalled();
});

it("says a takeover is what Make main does once the old main is unreachable", async () => {
  await renderSwitcher({
    ...handlers(),
    copies: [copy("m4:p", "M4"), copy("minis:p", "Minis", "workers")],
    mainOffers: [offer("minis:p", "Minis", { kind: "takeover" })],
  });
  expect(makeMainItems()[0]?.title).toBe(
    "M4 is unreachable: Minis takes over and starts from the shared goal, memory and plan. You confirm first.",
  );
});

it("lists a machine that kept its conversation as paused, and can make it main again", async () => {
  const calls = handlers();
  await renderSwitcher(calls);
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(rows.map((row) => row.textContent)).toEqual(["M4Main", "Miniscoordinator paused"]);
  expect(rows[1]?.title).toBe(
    "Minis kept its coordinator conversation from before as history. View it to read that conversation.",
  );
  // It never starts a second coordinator: the one item moves main there.
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
  expect(labels.filter((label) => label?.includes("Minis"))).toEqual(["Make Minis main"]);
  await act(async () => rows[1]!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("minis:p"));
  expect(calls.onMakeMain).not.toHaveBeenCalled();
});

it("offers one item per machine, and none where any copy there is main", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [
      copy("m4:p", "M4"),
      // Two checkouts on m1: the one with an offer gets the item, once.
      { ...copy("m1:a", "M1", "workers"), folder: "/w/a" },
      { ...copy("m1:b", "M1", "workers", true), folder: "/w/b" },
      // On m3 one copy runs its own coordinator, so the copy beside it gets nothing.
      copy("m3:a", "M3"),
      { ...copy("m3:b", "M3", "workers"), folder: "/w/b" },
      // m5 has two copies and gets one item.
      { ...copy("m5:a", "M5", "workers"), folder: "/w/a" },
      { ...copy("m5:b", "M5", "workers"), folder: "/w/b" },
    ],
    mainOffers: [
      offer("m1:b", "M1"),
      offer("m3:b", "M3"),
      offer("m5:a", "M5"),
      offer("m5:b", "M5"),
    ],
  });
  expect(makeMainItems().map((row) => row.textContent)).toEqual([
    "Make M1 · /w/b main",
    "Make M5 · /w/a main",
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
  expect(labels.filter((label) => label?.includes("M1"))).toEqual(["Make M1 main"]);
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
  expect(calls.onMakeMain).not.toHaveBeenCalled();
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

it("offers one Send to another machine and Leave, even with one copy", async () => {
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
        onMakeMain={null}
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
  await act(async () => item("menuitem", "Send to another machine…")!.click());
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
      "Send to another machine…",
      "Make Minis main",
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
  // The old row note is gone; the sentence above the rows may still call the projects separate.
  expect(rows.map((row) => row.textContent).join(" ")).not.toContain("separate project");
});

const unlinkedNote = () =>
  document.querySelector("[data-orchestrator-unlinked-note]")?.textContent ?? null;

it("says once that not linked projects can still be viewed and messaged", async () => {
  await renderSwitcher({
    ...handlers(),
    copies: [copy("m4:p", "M4", "independent"), copy("m1:p", "M1", "independent")],
  });
  expect(unlinkedNote()).toBe(
    "Not linked: these are separate projects for this repository, each with its own coordinator, threads and memory. That does not stop you viewing or messaging any of them.",
  );
});

it("points at the link items when linking is offered", async () => {
  await renderSwitcher({
    ...handlers(),
    copies: [copy("m4:p", "M4", "independent"), copy("m1:p", "M1", "independent")],
    onLink: vi.fn<(key: string) => void>(),
    links: [{ key: "m1:p", machine: "M1" }],
  });
  expect(unlinkedNote()).toMatch(
    /That does not stop you viewing or messaging any of them\. Link them below to make one project\.$/,
  );
});

it("does not point at link items a listed copy does not have", async () => {
  // M3 is listed, but only M1 can be linked (M3 sits at another place in the repository).
  await renderSwitcher({
    ...handlers(),
    copies: [
      copy("m4:p", "M4", "independent"),
      copy("m1:p", "M1", "independent"),
      copy("m3:p", "M3", "independent"),
    ],
    onLink: vi.fn<(key: string) => void>(),
    links: [{ key: "m1:p", machine: "M1" }],
  });
  expect(unlinkedNote()).toMatch(/That does not stop you viewing or messaging any of them\.$/);
  expect(document.querySelectorAll("[data-orchestrator-link]")).toHaveLength(1);
});

it("keeps that note off a group with a linked machine this app never loaded", async () => {
  await renderSwitcher({
    ...handlers(),
    copies: [copy("m4:p", "M4", "independent"), copy("m1:p", "M1", "independent")],
    unknown: [{ key: "m5:p", machine: "M5" }],
  });
  expect(unlinkedNote()).toBeNull();
});

it("keeps that note off linked projects and off a group with a linked copy", async () => {
  await renderSwitcher(handlers());
  expect(unlinkedNote()).toBeNull();
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // A linked copy in the group can hold an unlinked one back, so nothing promises otherwise.
  await renderSwitcher({
    ...handlers(),
    copies: [copy("m4:p", "M4"), copy("m1:p", "M1", "independent")],
  });
  expect(
    [...document.querySelectorAll('[role="menuitemradio"]')].map((row) => row.textContent),
  ).toEqual(["M4Main", "M1not linked"]);
  expect(unlinkedNote()).toBeNull();
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
  expect(links.map((link) => link.textContent)).toEqual(["Link M5 to this project…"]);
  // Linking never changes main, and the item says so before the confirmation does.
  expect(links[0]?.title).toBe(
    "Makes the project on M5 part of this one. Main does not change, and threads and files stay where they are. You confirm what M5 gives up first.",
  );
  await act(async () => links[0]!.click());
  await vi.waitFor(() => expect(onLink).toHaveBeenCalledWith("m5:old"));
  expect(calls.onView).not.toHaveBeenCalled();
  expect(calls.onMakeMain).not.toHaveBeenCalled();
});

it("gives a copy that is not linked Link, never Make main or a coordinator move", async () => {
  await renderSwitcher({
    ...handlers(),
    onLink: vi.fn<(key: string) => void>(),
    copies: [copy("m4:p", "M4", "independent"), copy("m5:old", "M5", "independent")],
    links: [{ key: "m5:old", machine: "M5" }],
    mainOffers: [offer("m5:old", "M5")],
  });
  const labels = [...document.querySelectorAll('[role="menuitem"]')].map((row) => row.textContent);
  expect(labels).toContain("Link M5 to this project…");
  expect(labels.some((label) => /^Make|^Move coordinator/.test(label ?? ""))).toBe(false);
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
        onMakeMain={null}
        onAllowWorkers={null}
      />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
});

it("opens linking on main's own copy, and never on a copy that takes work from an unloaded main", () => {
  const atlas = { logicalProject: { id: "atlas" } };
  const viewed = { environmentId: "m5", id: "p", workspaceSettings: atlas };
  const main = { environmentId: "m4", id: "p", workspaceSettings: atlas };
  const alone = { environmentId: "m5", id: "q" };
  const [m5, m4, single] = [viewed, main, alone] as unknown as EnvironmentProject[];
  const copies = [copy("m4:p", "M4"), copy("m5:p", "M5", "workers")];
  expect(linkKeeper(m5!, [m4!, m5!], copies)).toBe(m4);
  // Main is linked but its copy never loaded here: nothing keeps main, so nothing is offered.
  expect(linkKeeper(m5!, [m5!], copies)).toBeNull();
  expect(linkKeeper(m5!, [m5!], [copy("m5:p", "M5", "workers")])).toBeNull();
  // A project on its own keeps itself.
  expect(linkKeeper(single!, [single!], [])).toBe(single);
});
