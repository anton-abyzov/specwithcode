// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { MainOffer } from "../../studio/makeMain";
import type { MachineRowRole } from "../../studio/machineRowState";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";
import { copyRoleLabel } from "../../studio/workersOnlyCopy";

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import * as switcherModule from "./OrchestratorSwitcher";
import { linkKeeper, OrchestratorSwitcher, type MachineRowReach } from "./OrchestratorSwitcher";

/** The menu's actions; the info button by the first label is a menu item with no text. */
const ACTION_ITEMS = '[role="menuitem"]:not([data-slot="menu-info-button"])';

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

/** A machine of the project, as `orchestratorCopies` lists it, by its menu row role. */
const copy = (
  key: string,
  machine: string,
  rowRole: MachineRowRole = "main",
  canStart = false,
): OrchestratorCopy => ({
  key,
  machine,
  folder: "/w/atlas",
  role:
    rowRole === "copy"
      ? "workers"
      : rowRole === "moving"
        ? "pending"
        : rowRole === "independent"
          ? "independent"
          : "coordinator",
  main: rowRole === "main",
  rowRole,
  label:
    rowRole === "independent"
      ? { text: "Separate project" }
      : rowRole === "single"
        ? { text: "" }
        : copyRoleLabel(rowRole),
  canStart,
});

const handlers = () => ({
  onView: vi.fn<(key: string) => void>(),
  onMakeMain: vi.fn<(key: string) => void>(),
  onAllowWorkers: vi.fn<() => void>(),
});
/** The switch `useMakeMain` works out for a machine: pressable, or off with its reason. */
const offer = (key: string, machine: string, extra: Partial<MainOffer> = {}): MainOffer => ({
  key,
  machine,
  main: "M4",
  kind: "move",
  reason: null,
  note: null,
  ...extra,
});
const continueItems = () => [
  ...document.querySelectorAll<HTMLElement>("[data-orchestrator-continue]"),
];
const rows = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
const rowOf = (key: string) =>
  document.querySelector<HTMLElement>(`[data-orchestrator-view="${key}"]`)!;
const textsIn = (element: ParentNode, selector: string) =>
  [...element.querySelectorAll(selector)].map((node) => node.textContent);
const menuText = () => document.querySelector('[role="menu"]')?.textContent ?? "";
const menuOpen = () => document.querySelector('[role="menu"]') !== null;

type SwitcherProps = Parameters<typeof OrchestratorSwitcher>[0];

async function renderSwitcher(
  props: Partial<SwitcherProps> & Pick<SwitcherProps, "onView" | "onAllowWorkers">,
) {
  const label = props.label ?? "M4";
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="M4"
        projectTitle="Atlas"
        connected
        statusDetail=""
        current="m4:p"
        copies={[copy("m4:p", "M4"), copy("minis:p", "Minis", "copy", true)]}
        unknown={[]}
        savedMachineMissing={false}
        mainOffers={[offer("minis:p", "Minis"), offer("m1:p", "M1"), offer("m5:a", "M5")]}
        {...props}
      />,
    ),
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>(`[aria-label^="Viewing ${label}"]`)!.click(),
  );
}
const item = (role: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(`[role="${role}"]`)].find((element) =>
    element.textContent?.includes(text),
  );

/** Every row of AC-03 at once: one state each. */
const EVERY_ROW = {
  copies: [
    copy("m4:p", "M4"),
    copy("mini:p", "Mini", "copy"),
    copy("m1:p", "M1", "also-main"),
    copy("m3:p", "M3", "moving"),
    copy("m5:p", "M5", "independent"),
  ],
  unknown: [{ key: "linux-mini:p", machine: "linux-mini" }],
};

it("names the machine shown on the chip, and the newly shown machine after a row is picked", async () => {
  const onView = vi.fn<(key: string) => void>();
  const names: Record<string, string> = { "m4:p": "M4", "minis:p": "Minis" };
  function Page() {
    const [current, setCurrent] = useState("m4:p");
    return (
      <OrchestratorSwitcher
        label={names[current]!}
        projectTitle="Atlas"
        connected
        statusDetail=""
        current={current}
        copies={[copy("m4:p", "M4"), copy("minis:p", "Minis", "copy")]}
        unknown={[]}
        savedMachineMissing={false}
        onView={(key) => {
          onView(key);
          setCurrent(key);
        }}
        onAllowWorkers={null}
      />
    );
  }
  await act(async () => root.render(<Page />));
  expect(container.querySelector(".sws-host-name")?.textContent).toBe("On M4");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label^="Viewing M4"]')!.click(),
  );
  await act(async () => rowOf("minis:p").click());
  await vi.waitFor(() => expect(onView).toHaveBeenCalledWith("minis:p"));
  // The chip follows the machine shown, never where the coordinator is.
  await vi.waitFor(() =>
    expect(container.querySelector(".sws-host-name")?.textContent).toBe("On Minis"),
  );
  expect(container.querySelector("[data-coordinator-machine]")?.getAttribute("aria-label")).toBe(
    "Viewing Minis. Choose a machine to view",
  );
});

it("switches the view only after its menu has closed", async () => {
  const menuOpenAtSwitch: boolean[] = [];
  const calls = handlers();
  calls.onView.mockImplementation(() => menuOpenAtSwitch.push(menuOpen()));
  await renderSwitcher(calls);
  await act(async () => item("menuitemradio", "Minis")!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledTimes(1));
  expect(menuOpenAtSwitch).toEqual([false]);
  expect(calls.onMakeMain).not.toHaveBeenCalled();
});

it("gives every row exactly one state: pill, reason or nothing", async () => {
  await renderSwitcher({ ...handlers(), ...EVERY_ROW, onFix: vi.fn() });
  // This project's machines first, the separate project after them.
  expect(rows().map((row) => row.getAttribute("data-orchestrator-view"))).toEqual([
    "m4:p",
    "mini:p",
    "m1:p",
    "m3:p",
    "linux-mini:p",
    "m5:p",
  ]);
  expect(rows().map((row) => row.getAttribute("data-row-state"))).toEqual([
    "coordinator",
    "plain",
    "extra-coordinator",
    "handing-off",
    "cannot-open",
    "separate",
  ]);
  const said = (key: string) => [
    ...textsIn(rowOf(key), "[data-row-pill]"),
    ...textsIn(rowOf(key), "[data-row-reason]"),
  ];
  expect(said("m4:p")).toEqual(["Coordinator"]);
  // A plain machine has no role word at all.
  expect(said("mini:p")).toEqual([]);
  expect(rowOf("mini:p").textContent).toBe("Mini");
  expect(said("m1:p")).toEqual(["Extra coordinator"]);
  expect(said("m3:p")).toEqual(["Handing off the coordinator…"]);
  expect(said("m5:p")).toEqual(["Separate project"]);
  expect(said("linux-mini:p")).toEqual(["This window cannot open linux-mini"]);
  expect(textsIn(rowOf("linux-mini:p"), "[data-row-pill]")).toEqual([]);
  // The one step on a row sits beside it: Fix… for the extra coordinator, Connect… for the
  // machine this window cannot open, and nothing for any other row.
  expect(
    [...document.querySelectorAll("[data-orchestrator-fix]")].map((node) => [
      node.getAttribute("data-orchestrator-fix"),
      node.textContent,
      node.getAttribute("aria-label"),
    ]),
  ).toEqual([["m1:p", "Fix…", "Fix the extra coordinator on M1"]]);
  expect(
    [...document.querySelectorAll("[data-orchestrator-connect]")].map((node) => [
      node.getAttribute("data-orchestrator-connect"),
      node.textContent,
      node.getAttribute("aria-label"),
    ]),
  ).toEqual([["linux-mini:p", "Connect…", "Connect linux-mini"]]);
  // A separate project's row says what that means.
  expect(rowOf("m5:p").title).toBe(
    "Separate project: M5 added this repository on its own, with its own coordinator, threads and memory.",
  );
});

it("greys a machine this window cannot open: never pressable, with its reason and Connect…", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    copies: [copy("m4:p", "M4"), copy("m1:p", "M1", "copy")],
    unknown: [{ key: "linux-mini:p", machine: "linux-mini" }],
  });
  const greyed = rowOf("linux-mini:p");
  expect(greyed.getAttribute("aria-disabled")).toBe("true");
  expect(greyed.title).toBe("This window cannot open linux-mini");
  await act(async () => greyed.click());
  // Nothing to show there: a click never opens an empty page.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(calls.onView).not.toHaveBeenCalled();
  expect(menuOpen()).toBe(true);
  await act(async () => item("menuitem", "Connect…")!.click());
  expect(calls.onAllowWorkers).toHaveBeenCalledTimes(1);
  expect(calls.onView).not.toHaveBeenCalled();
});

it("greys a listed machine that refuses this window, the same way", async () => {
  const calls = handlers();
  const reachOf = (key: string): MachineRowReach =>
    key === "m1:p" ? { reach: "refused" } : { reach: "open" };
  await renderSwitcher({
    ...calls,
    reachOf,
    copies: [copy("m4:p", "M4"), copy("m1:p", "M1", "copy")],
  });
  const refused = rowOf("m1:p");
  expect(refused.getAttribute("data-row-state")).toBe("cannot-open");
  expect(refused.getAttribute("aria-disabled")).toBe("true");
  expect(textsIn(refused, "[data-row-reason]")).toEqual(["This window cannot open M1"]);
  await act(async () => refused.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(calls.onView).not.toHaveBeenCalled();
});

it("opens Fix… for an extra coordinator after the menu closed, never picking its row", async () => {
  const calls = handlers();
  const menuOpenAtFix: boolean[] = [];
  const onFix = vi.fn<(key: string) => void>(() => menuOpenAtFix.push(menuOpen()));
  await renderSwitcher({
    ...calls,
    onFix,
    copies: [copy("m4:p", "M4"), copy("m1:p", "M1", "also-main")],
  });
  await act(async () =>
    document.querySelector<HTMLElement>('[data-orchestrator-fix="m1:p"]')!.click(),
  );
  await vi.waitFor(() => expect(onFix).toHaveBeenCalledWith("m1:p"));
  expect(onFix).toHaveBeenCalledTimes(1);
  expect(menuOpenAtFix).toEqual([false]);
  expect(calls.onView).not.toHaveBeenCalled();
  expect(calls.onMakeMain).not.toHaveBeenCalled();
});

it("offers no Fix… while the page cannot open it, but still says Extra coordinator", async () => {
  await renderSwitcher({
    ...handlers(),
    copies: [copy("m4:p", "M4"), copy("m1:p", "M1", "also-main")],
  });
  expect(document.querySelector("[data-orchestrator-fix]")).toBeNull();
  expect(textsIn(rowOf("m1:p"), "[data-row-pill]")).toEqual(["Extra coordinator"]);
});

/** M1 offline with a time, M3 offline with none, M4 (the coordinator) offline too. */
const offlineReach = (key: string): MachineRowReach =>
  key === "m1:p"
    ? { reach: "offline", lastSeen: "2h ago" }
    : key === "m3:p" || key === "m4:p"
      ? { reach: "offline" }
      : { reach: "open" };
const offlineCopies = [
  copy("m4:p", "M4"),
  copy("m1:p", "M1", "copy"),
  copy("m3:p", "M3", "copy"),
  copy("minis:p", "Minis", "copy"),
];

it("keeps an offline machine pressable, in its own state, and views it on a click", async () => {
  const calls = handlers();
  await renderSwitcher({ ...calls, reachOf: offlineReach, copies: offlineCopies });
  const offline = rowOf("m1:p");
  expect(offline.getAttribute("data-row-state")).toBe("plain");
  expect(offline.getAttribute("aria-disabled")).not.toBe("true");
  expect(textsIn(offline, "[data-row-reason]")).toEqual([]);
  // An offline coordinator still reads "Coordinator".
  expect(rowOf("m4:p").getAttribute("data-row-state")).toBe("coordinator");
  expect(textsIn(rowOf("m4:p"), "[data-row-pill]")).toEqual(["Coordinator"]);
  expect(textsIn(rowOf("minis:p"), "[data-row-note]")).toEqual([]);
  await act(async () => offline.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("m1:p"));
});

it("notes an offline machine with when it was last seen", async () => {
  await renderSwitcher({ ...handlers(), reachOf: offlineReach, copies: offlineCopies });
  expect(textsIn(rowOf("m1:p"), "[data-row-note]")).toEqual(["Offline · last seen 2h ago"]);
  expect(textsIn(rowOf("m3:p"), "[data-row-note]")).toEqual(["Offline"]);
  expect(textsIn(rowOf("m4:p"), "[data-row-note]")).toEqual(["Offline"]);
});

it("tells two checkouts on one machine apart by their folders", async () => {
  await renderSwitcher({
    ...handlers(),
    copies: [
      copy("m4:p", "M4"),
      { ...copy("m1:a", "M1", "copy"), folder: "/w/a" },
      { ...copy("m1:b", "M1", "copy"), folder: "/w/b" },
    ],
  });
  expect(rows().map((row) => row.textContent)).toEqual(["M4Coordinator", "M1 · /w/a", "M1 · /w/b"]);
});

it("notes a machine that kept its old coordinator conversation, and views it on a click", async () => {
  const calls = handlers();
  await renderSwitcher(calls);
  const kept = rowOf("minis:p");
  expect(kept.getAttribute("data-row-state")).toBe("plain");
  expect(textsIn(kept, "[data-row-note]")).toEqual(["Old conversation kept"]);
  expect(kept.title).toBe(
    "Minis kept its coordinator conversation from before as history. View it to read that conversation.",
  );
  await act(async () => kept.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("minis:p"));
  expect(calls.onMakeMain).not.toHaveBeenCalled();
});

/** The switcher on Minis's page, where the coordinator is on M4. */
const onMinis = (extra: Partial<SwitcherProps> = {}) => ({
  label: "Minis",
  current: "minis:p",
  copies: [copy("m4:p", "M4"), copy("minis:p", "Minis", "copy"), copy("m1:p", "M1", "copy")],
  mainOffers: [offer("minis:p", "Minis"), offer("m1:p", "M1")],
  ...extra,
});

it("offers one Continue the coordinator here, for the machine shown, after the menu closed", async () => {
  const calls = handlers();
  const menuOpenAtContinue: boolean[] = [];
  calls.onMakeMain.mockImplementation(() => menuOpenAtContinue.push(menuOpen()));
  await renderSwitcher({ ...calls, ...onMinis() });
  // One item, for Minis only: M1 has an offer, but it is not the machine shown.
  expect(continueItems().map((node) => node.getAttribute("data-orchestrator-continue"))).toEqual([
    "minis:p",
  ]);
  expect(continueItems()[0]?.textContent).toBe("Continue the coordinator here");
  expect(continueItems()[0]?.title).toBe(
    "Syncs Minis, then moves the coordinator conversation here from M4. You confirm first.",
  );
  // It sits in the machine shown's own group.
  const labels = textsIn(document, '[data-slot="menu-label"]');
  expect(labels).toEqual(["Atlas on your machines", "Work on Minis"]);
  await act(async () => continueItems()[0]!.click());
  await vi.waitFor(() => expect(calls.onMakeMain).toHaveBeenCalledWith("minis:p"));
  expect(menuOpenAtContinue).toEqual([false]);
  expect(calls.onView).not.toHaveBeenCalled();
});

it("says a takeover is what Continue does once the coordinator's machine is offline", async () => {
  await renderSwitcher({
    ...handlers(),
    ...onMinis({ mainOffers: [offer("minis:p", "Minis", { kind: "takeover" })] }),
  });
  expect(continueItems()[0]?.title).toBe(
    "M4 is offline: the coordinator starts on Minis from the shared goal, memory and plan. You confirm first.",
  );
});

it("keeps Continue off with its note and reason while it is blocked", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    ...onMinis({
      mainOffers: [
        offer("minis:p", "Minis", {
          kind: "blocked",
          block: "waiting",
          reason: {
            text: "{main} must be silent for 10 minutes before the coordinator can continue on {machine}. That unlocks in {minutes} min.",
            values: { main: "M4", machine: "Minis", minutes: "7" },
          },
          note: { text: "in {minutes} min", values: { minutes: "7" } },
        }),
      ],
    }),
  });
  const row = continueItems()[0]!;
  expect(row.textContent).toBe("Continue the coordinator herein 7 min");
  expect(row.getAttribute("aria-disabled")).toBe("true");
  expect(row.title).toBe(
    "M4 must be silent for 10 minutes before the coordinator can continue on Minis. That unlocks in 7 min.",
  );
  await act(async () => row.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(calls.onMakeMain).not.toHaveBeenCalled();
});

it("offers no Continue on the coordinator's own machine, nor without an offer or a runner", async () => {
  // On M4, which holds the coordinator: offers for other machines are never shown.
  await renderSwitcher(handlers());
  expect(continueItems()).toEqual([]);
  await act(async () => root.render(<></>));
  // Not even with an offer for M4 itself: the coordinator is already here (AC-06).
  await renderSwitcher({
    ...handlers(),
    mainOffers: [offer("m4:p", "M4"), offer("minis:p", "Minis")],
  });
  expect(continueItems()).toEqual([]);
  await act(async () => root.render(<></>));
  await renderSwitcher({ ...handlers(), ...onMinis({ mainOffers: [offer("m1:p", "M1")] }) });
  expect(continueItems()).toEqual([]);
  await act(async () => root.render(<></>));
  await renderSwitcher({ ...handlers(), ...onMinis(), onMakeMain: null });
  expect(continueItems()).toEqual([]);
});

it("never starts a second coordinator and names no role in any item", async () => {
  // useStartCoordinator is gone (D-06): the only way to a coordinator here is Continue.
  expect("useStartCoordinator" in switcherModule).toBe(false);
  await renderSwitcher({
    ...handlers(),
    ...onMinis({
      copies: [
        copy("m4:p", "M4"),
        copy("minis:p", "Minis", "copy", true),
        copy("m1:p", "M1", "also-main"),
        copy("m3:p", "M3", "moving"),
        copy("m5:p", "M5", "independent"),
      ],
    }),
    unknown: [{ key: "linux-mini:p", machine: "linux-mini" }],
    onFix: vi.fn(),
    onCopy: vi.fn(),
    onLeave: vi.fn(),
    onMigrate: vi.fn(),
    onLink: vi.fn(),
    links: [{ key: "m6:p", machine: "Mac" }],
  });
  const text = menuText();
  expect(text).not.toContain("Start a coordinator here");
  expect(text).not.toMatch(/Make .* main/);
  expect(text).not.toContain("Copy · main on");
  expect(text).not.toMatch(/\bMain\b|\bmain\b|\bCopy\b|\bcopy\b/);
  for (const node of document.querySelectorAll<HTMLElement>('[role^="menuitem"]'))
    expect(node.title).not.toMatch(/\bMain\b|\bmain\b|\bCopy\b|\bcopy\b/);
  expect(document.querySelectorAll("[data-orchestrator-make-main]")).toHaveLength(0);
});

it("keeps the names of Send to another machine…, Move running threads… and Leave this machine…", async () => {
  const calls = handlers();
  await renderSwitcher({ ...calls, onCopy: vi.fn(), onLeave: vi.fn(), onMigrate: vi.fn() });
  expect(rows().map((row) => row.textContent)).toEqual([
    "M4Coordinator",
    "MinisOld conversation kept",
  ]);
  // No "This project" label: the project's actions sit under its machines.
  expect(textsIn(document, '[data-slot="menu-label"]')).toEqual([
    "Atlas on your machines",
    "Work on M4",
  ]);
  expect(textsIn(document, ACTION_ITEMS)).toEqual([
    "Send to another machine…",
    "Move running threads…",
    "Leave this machine…",
    "Machine access settings",
  ]);
  expect(menuText()).not.toMatch(/orchestrator/i);
  await act(async () => item("menuitem", "Machine access settings")!.click());
  expect(calls.onAllowWorkers).toHaveBeenCalledTimes(1);
});

it("opens thread migration as its own action, after the menu closes", async () => {
  const calls = handlers();
  const menuOpenAtMigrate: boolean[] = [];
  const onMigrate = vi.fn(() => menuOpenAtMigrate.push(menuOpen()));
  await renderSwitcher({ ...calls, onMigrate });
  await act(async () => item("menuitem", "Move running threads…")!.click());
  await vi.waitFor(() => expect(onMigrate).toHaveBeenCalledTimes(1));
  expect(menuOpenAtMigrate).toEqual([false]);
  expect(calls.onView).not.toHaveBeenCalled();
  expect(calls.onMakeMain).not.toHaveBeenCalled();
});

it("leaves thread migration off while the machine shown is offline", async () => {
  await renderSwitcher(handlers());
  const migrate = item("menuitem", "Move running threads…");
  expect(migrate?.getAttribute("aria-disabled")).toBe("true");
  expect(migrate?.textContent).toBe("Move running threads…M4 offline");
});

it("marks an offline machine shown by its dot, never as live", async () => {
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="Minis"
        projectTitle="Atlas"
        connected={false}
        statusDetail="Reconnecting"
        current="minis:p"
        copies={[copy("m4:p", "M4"), copy("minis:p", "Minis", "copy")]}
        unknown={[]}
        savedMachineMissing={false}
        {...handlers()}
      />,
    ),
  );
  // The chip still names the machine shown; the state is the dot, and a word for screen
  // readers. The line above the message box says the rest.
  expect(container.querySelector(".sws-host-name")?.textContent).toBe("On Minis");
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
        projectTitle="Atlas"
        connected
        statusDetail=""
        current="air:p"
        copies={[copy("air:p", "Anna's Air", "single")]}
        unknown={[]}
        savedMachineMissing={false}
        {...handlers()}
      />,
    ),
  );
  expect(container.querySelector(".sws-host-name")?.textContent).toBe("On Anna's Air");
  // No native tooltip floats over the message box; the computer's name is read out instead.
  expect(container.querySelector(".sws-host-name")?.hasAttribute("title")).toBe(false);
  expect(container.querySelector("[data-orchestrator-host]")?.textContent).toBe(
    " (Anna's MacBook Air)",
  );
});

it("offers one Send to another machine and Leave, even with one machine", async () => {
  const onCopy = vi.fn<() => void>();
  const onLeave = vi.fn<() => void>();
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="M4"
        projectTitle="Atlas"
        connected
        statusDetail=""
        current="m4:p"
        copies={[copy("m4:p", "M4", "single")]}
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

/** Opens the info button by the menu's first label, where what viewing means is kept. */
const showInfo = async () => {
  const button = document.querySelector<HTMLElement>('[data-slot="menu-info-button"]');
  if (button) await act(async () => button.click());
};
const unlinkedNote = () =>
  document.querySelector("[data-orchestrator-unlinked-note]")?.textContent ?? null;
const separate = [copy("m4:p", "M4", "independent"), copy("m1:p", "M1", "independent")];

it("keeps what viewing means behind the label's info button, opened without closing the menu", async () => {
  await renderSwitcher({ ...handlers(), copies: separate });
  const button = document.querySelector<HTMLElement>('[data-slot="menu-info-button"]');
  expect(button?.getAttribute("role")).toBe("menuitem");
  expect(button?.getAttribute("aria-label")).toBe("About: Atlas on your machines");
  expect(button?.getAttribute("aria-expanded")).toBe("false");
  // The menu opens on its machines: the info button follows them in item order.
  const items = [...document.querySelectorAll('[role^="menuitem"]')];
  expect(items[0]?.getAttribute("role")).toBe("menuitemradio");
  expect(items.indexOf(button!)).toBeGreaterThan(
    items.findLastIndex((node) => node.getAttribute("role") === "menuitemradio"),
  );
  expect(document.querySelector("[data-orchestrator-note]")).toBeNull();
  expect(unlinkedNote()).toBeNull();
  await showInfo();
  expect(menuOpen()).toBe(true);
  expect(button?.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector("[data-orchestrator-note]")?.textContent).toBe(
    "Pick a machine to see its threads and files. Nothing moves until you sync or hand off.",
  );
  await showInfo();
  expect(document.querySelector("[data-orchestrator-note]")).toBeNull();
});

it("says once that separate projects can still be opened and messaged", async () => {
  await renderSwitcher({ ...handlers(), copies: separate });
  expect(rows().map((row) => row.textContent)).toEqual([
    "M4Separate project",
    "M1Separate project",
  ]);
  await showInfo();
  expect(unlinkedNote()).toBe(
    "These are separate projects for this repository, each with its own coordinator, threads and memory. You can still open and message each one.",
  );
});

it("points at the link items when linking is offered", async () => {
  await renderSwitcher({
    ...handlers(),
    copies: separate,
    onLink: vi.fn<(key: string) => void>(),
    links: [{ key: "m1:p", machine: "M1" }],
  });
  await showInfo();
  expect(unlinkedNote()).toMatch(
    /You can still open and message each one\. Link them below to make one project\.$/,
  );
});

it("does not point at link items a listed machine does not have", async () => {
  // M3 is listed, but only M1 can be linked (M3 sits at another place in the repository).
  await renderSwitcher({
    ...handlers(),
    copies: [...separate, copy("m3:p", "M3", "independent")],
    onLink: vi.fn<(key: string) => void>(),
    links: [{ key: "m1:p", machine: "M1" }],
  });
  await showInfo();
  expect(unlinkedNote()).toMatch(/You can still open and message each one\.$/);
  expect(document.querySelectorAll("[data-orchestrator-link]")).toHaveLength(1);
});

it("keeps that note off a group with a linked machine this window never opened", async () => {
  await renderSwitcher({
    ...handlers(),
    copies: separate,
    unknown: [{ key: "m5:p", machine: "M5" }],
  });
  await showInfo();
  expect(unlinkedNote()).toBeNull();
});

it("keeps that note off linked projects and off a group with a linked machine", async () => {
  await renderSwitcher(handlers());
  await showInfo();
  expect(unlinkedNote()).toBeNull();
  await act(async () => root.render(<></>));
  // A linked machine in the group can hold a separate one back, so nothing promises otherwise.
  await renderSwitcher({
    ...handlers(),
    copies: [copy("m4:p", "M4"), copy("m1:p", "M1", "independent")],
  });
  expect(rows().map((row) => row.textContent)).toEqual(["M4Coordinator", "M1Separate project"]);
  await showInfo();
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
  // Linking never moves the coordinator, and the item says so before the confirmation does.
  expect(links[0]?.title).toBe(
    "Makes the project on M5 part of this one. The coordinator stays where it is, and threads and files stay where they are. You confirm what M5 gives up first.",
  );
  await act(async () => links[0]!.click());
  await vi.waitFor(() => expect(onLink).toHaveBeenCalledWith("m5:old"));
  expect(calls.onView).not.toHaveBeenCalled();
  expect(calls.onMakeMain).not.toHaveBeenCalled();
});

it("gives a separate project Link, never Continue or a coordinator move", async () => {
  // Shown on M5, a separate project, even with an offer for M5 itself: it has no coordinator
  // of this project to continue.
  await renderSwitcher({
    ...handlers(),
    label: "M5",
    current: "m5:old",
    onLink: vi.fn<(key: string) => void>(),
    copies: [copy("m4:p", "M4", "independent"), copy("m5:old", "M5", "independent")],
    links: [{ key: "m4:p", machine: "M4" }],
    mainOffers: [offer("m5:old", "M5"), offer("m4:p", "M4")],
  });
  const labels = textsIn(document, ACTION_ITEMS);
  expect(labels).toContain("Link M4 to this project…");
  expect(continueItems()).toEqual([]);
  expect(labels.some((label) => /^Make|^Move coordinator|^Continue/.test(label ?? ""))).toBe(false);
});

it("offers no link where linking is not allowed or nothing matches", async () => {
  const calls = handlers();
  await renderSwitcher({ ...calls, links: [{ key: "m5:old", machine: "M5" }] });
  expect(document.querySelector("[data-orchestrator-link]")).toBeNull();
  await act(async () => root.render(<></>));
  await renderSwitcher({ ...calls, onLink: vi.fn<(key: string) => void>() });
  expect(document.querySelector("[data-orchestrator-link]")).toBeNull();
});

it("stays a plain label with one machine and no machine actions", async () => {
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="M4"
        projectTitle="Atlas"
        connected
        statusDetail=""
        current="m4:p"
        copies={[copy("m4:p", "M4", "single")]}
        unknown={[]}
        savedMachineMissing={false}
        onView={vi.fn()}
        onMakeMain={null}
        onAllowWorkers={null}
      />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector(".sws-host-name")?.textContent).toBe("On M4");
});

it("opens linking on the coordinator's own project, never on one that follows an unloaded coordinator", () => {
  const atlas = { logicalProject: { id: "atlas" } };
  const viewed = { environmentId: "m5", id: "p", workspaceSettings: atlas };
  const coordinator = { environmentId: "m4", id: "p", workspaceSettings: atlas };
  const alone = { environmentId: "m5", id: "q" };
  const [m5, m4, single] = [viewed, coordinator, alone] as unknown as EnvironmentProject[];
  const copies = [copy("m4:p", "M4"), copy("m5:p", "M5", "copy")];
  expect(linkKeeper(m5!, [m4!, m5!], copies)).toBe(m4);
  // The coordinator's project is linked but never loaded here: nothing keeps it.
  expect(linkKeeper(m5!, [m5!], copies)).toBeNull();
  expect(linkKeeper(m5!, [m5!], [copy("m5:p", "M5", "copy")])).toBeNull();
  // A project on its own keeps itself.
  expect(linkKeeper(single!, [single!], [])).toBe(single);
});
