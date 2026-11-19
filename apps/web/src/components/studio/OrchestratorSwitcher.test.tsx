// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { MachineRowRole } from "../../studio/machineRowState";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";
import {
  forgetLinkRefusal,
  rememberLinkRefusal,
  resetLinkRefusalsForTest,
} from "../../studio/linkRefusals";

/** The project shown in `renderSwitcher`. */
const CURRENT = "laptopE:p";

// Commands answer by name where a test gives one; the menu's own get a bare stub.
const commands = vi.hoisted(() => ({
  handlers: {} as Record<string, (input: unknown) => unknown>,
}));
vi.mock("../../studio/machineHandoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../studio/machineHandoff")>()),
  machineHandoff: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: unknown) => {
    const handler = typeof name === "string" ? commands.handlers[name] : undefined;
    return handler
      ? async (request: unknown) => ({ _tag: "Success", value: await handler(request) })
      : vi.fn();
  },
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
const linkCopy = vi.hoisted(() => vi.fn());
vi.mock("../../studio/projectLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../studio/projectLink")>()),
  linkCopyAsWorkers: linkCopy,
}));

import * as switcherModule from "./OrchestratorSwitcher";
import { linkKeeper, OrchestratorSwitcher, type MachineRowReach } from "./OrchestratorSwitcher";
import { HandoffFolderCopyWatcher } from "./HandoffFolderCopyWatcher";
import { useCopyLink } from "./useCopyLink";

/** The end of Add's own dialog: the copy is done and is linked as the dialog links it. */
function AddDone() {
  useCopyLink({
    project: { environmentId: "laptopE", id: "p" } as never,
    sourceLabel: "Laptop E",
    targetLabel: "Rack F",
    machine: "rackF" as never,
    stage: "done",
    mode: "copy-only",
    copyProjectId: "old" as never,
    latestPending: { current: null },
    remember: vi.fn(),
  });
  return null;
}

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
  resetLinkRefusalsForTest();
  container.remove();
  document.body.innerHTML = "";
});

/**
 * A machine of the project, as `orchestratorCopies` lists it. Linked machines are equals:
 * each runs its own coordinator, and `main` only says which one project-wide settings are
 * read from (the first linked machine of a test, by default the one that is not `canStart`).
 */
const copy = (
  key: string,
  machine: string,
  rowRole: MachineRowRole = "linked",
  canStart = false,
  main = rowRole === "linked" && !canStart && !key.startsWith("member:"),
): OrchestratorCopy => ({
  key,
  machine,
  folder: "/w/atlas",
  role: rowRole === "independent" ? "independent" : "coordinator",
  main,
  rowRole,
  label: rowRole === "independent" ? { text: "Separate project" } : { text: "" },
  canStart,
});
/** A linked machine that is not the one settings are read from. */
const member = (key: string, machine: string, canStart = false): OrchestratorCopy =>
  copy(key, machine, "linked", canStart, false);

const handlers = () => ({
  onView: vi.fn<(key: string) => void>(),
  onAllowWorkers: vi.fn<() => void>(),
});
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
  const label = props.label ?? "Laptop E";
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="Laptop E"
        projectTitle="Atlas"
        connected
        statusDetail=""
        current="laptopE:p"
        copies={[copy("laptopE:p", "Laptop E"), member("towerH:p", "Tower H", true)]}
        unknown={[]}
        savedMachineMissing={false}
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
    member("mini:p", "Mini"),
    member("m1:p", "M1"),
    member("m3:p", "M3"),
    copy("m5:p", "M5", "independent"),
  ],
  unknown: [{ key: "linux-mini:p", machine: "linux-mini" }],
};

it("names the machine shown on the chip, and the newly shown machine after a row is picked", async () => {
  const onView = vi.fn<(key: string) => void>();
  const names: Record<string, string> = { "laptopE:p": "Laptop E", "towerH:p": "Tower H" };
  function Page() {
    const [current, setCurrent] = useState("laptopE:p");
    return (
      <OrchestratorSwitcher
        label={names[current]!}
        projectTitle="Atlas"
        connected
        statusDetail=""
        current={current}
        copies={[copy("laptopE:p", "Laptop E"), member("towerH:p", "Tower H")]}
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
  expect(container.querySelector(".sws-host-name")?.textContent).toBe("On Laptop E");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label^="Viewing Laptop E"]')!.click(),
  );
  await act(async () => rowOf("towerH:p").click());
  await vi.waitFor(() => expect(onView).toHaveBeenCalledWith("towerH:p"));
  // The chip follows the machine shown, never where the coordinator is.
  await vi.waitFor(() =>
    expect(container.querySelector(".sws-host-name")?.textContent).toBe("On Tower H"),
  );
  expect(container.querySelector("[data-coordinator-machine]")?.getAttribute("aria-label")).toBe(
    "Viewing Tower H. Choose a machine to view",
  );
});

it("switches the view only after its menu has closed", async () => {
  const menuOpenAtSwitch: boolean[] = [];
  const calls = handlers();
  calls.onView.mockImplementation(() => menuOpenAtSwitch.push(menuOpen()));
  await renderSwitcher(calls);
  await act(async () => item("menuitemradio", "Tower H")!.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledTimes(1));
  expect(menuOpenAtSwitch).toEqual([false]);
});

it("lists the project's machines as equals: no role word, no pill and no step on any of them (AC-01)", async () => {
  await renderSwitcher({ ...handlers(), ...EVERY_ROW });
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
    "plain",
    "plain",
    "plain",
    "plain",
    "cannot-open",
    "separate",
  ]);
  const said = (key: string) => [
    ...textsIn(rowOf(key), "[data-row-pill]"),
    ...textsIn(rowOf(key), "[data-row-reason]"),
  ];
  // Every linked machine reads the same: its name and nothing else.
  for (const [key, name] of [
    ["m4:p", "M4"],
    ["mini:p", "Mini"],
    ["m1:p", "M1"],
    ["m3:p", "M3"],
  ] as const) {
    expect(said(key)).toEqual([]);
    expect(rowOf(key).textContent).toBe(name);
    expect(rowOf(key).title).toBe(name);
  }
  expect(said("m5:p")).toEqual(["Separate project"]);
  expect(said("linux-mini:p")).toEqual(["This window cannot open linux-mini"]);
  expect(textsIn(rowOf("linux-mini:p"), "[data-row-pill]")).toEqual([]);
  // No row offers to make a coordinator give way; the one step is Connect…, for the
  // machine this window cannot open.
  expect(document.querySelector("[data-orchestrator-fix]")).toBeNull();
  expect(document.querySelector("[data-orchestrator-continue]")).toBeNull();
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
    copies: [copy("laptopE:p", "Laptop E"), member("deskB:p", "Desk B")],
    unknown: [{ key: "box-a:p", machine: "box-a" }],
  });
  const greyed = rowOf("box-a:p");
  expect(greyed.getAttribute("aria-disabled")).toBe("true");
  expect(greyed.title).toBe("This window cannot open box-a");
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
    key === "deskB:p" ? { reach: "refused" } : { reach: "open" };
  await renderSwitcher({
    ...calls,
    reachOf,
    copies: [copy("laptopE:p", "Laptop E"), member("deskB:p", "Desk B")],
  });
  const refused = rowOf("deskB:p");
  expect(refused.getAttribute("data-row-state")).toBe("cannot-open");
  expect(refused.getAttribute("aria-disabled")).toBe("true");
  expect(textsIn(refused, "[data-row-reason]")).toEqual(["This window cannot open Desk B"]);
  await act(async () => refused.click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(calls.onView).not.toHaveBeenCalled();
});

/** Desk B offline with a time, Kiosk D offline with none, Laptop E (the coordinator) offline too. */
const offlineReach = (key: string): MachineRowReach =>
  key === "deskB:p"
    ? { reach: "offline", lastSeen: "2h ago" }
    : key === "kioskD:p" || key === "laptopE:p"
      ? { reach: "offline" }
      : { reach: "open" };
const offlineCopies = [
  copy("laptopE:p", "Laptop E"),
  member("deskB:p", "Desk B"),
  member("kioskD:p", "Kiosk D"),
  member("towerH:p", "Tower H"),
];

it("keeps an offline machine pressable, in its own state, and views it on a click", async () => {
  const calls = handlers();
  await renderSwitcher({ ...calls, reachOf: offlineReach, copies: offlineCopies });
  const offline = rowOf("deskB:p");
  expect(offline.getAttribute("data-row-state")).toBe("plain");
  expect(offline.getAttribute("aria-disabled")).not.toBe("true");
  expect(textsIn(offline, "[data-row-reason]")).toEqual([]);
  // Every offline machine keeps the same plain row.
  expect(rowOf("laptopE:p").getAttribute("data-row-state")).toBe("plain");
  expect(textsIn(rowOf("laptopE:p"), "[data-row-pill]")).toEqual([]);
  expect(textsIn(rowOf("towerH:p"), "[data-row-note]")).toEqual([]);
  await act(async () => offline.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("deskB:p"));
});

it("notes an offline machine with when it was last seen", async () => {
  await renderSwitcher({ ...handlers(), reachOf: offlineReach, copies: offlineCopies });
  expect(textsIn(rowOf("deskB:p"), "[data-row-note]")).toEqual(["Offline · last seen 2h ago"]);
  expect(textsIn(rowOf("kioskD:p"), "[data-row-note]")).toEqual(["Offline"]);
  expect(textsIn(rowOf("laptopE:p"), "[data-row-note]")).toEqual(["Offline"]);
});

it("tells two checkouts on one machine apart by their folders", async () => {
  await renderSwitcher({
    ...handlers(),
    copies: [
      copy("laptopE:p", "Laptop E"),
      { ...member("deskB:a", "Desk B"), folder: "/w/a" },
      { ...member("deskB:b", "Desk B"), folder: "/w/b" },
    ],
  });
  expect(rows().map((row) => row.textContent)).toEqual([
    "Laptop E",
    "Desk B · /w/a",
    "Desk B · /w/b",
  ]);
});

it("views a machine that used to follow another one like any other, with no note about its past", async () => {
  const calls = handlers();
  await renderSwitcher(calls);
  const row = rowOf("towerH:p");
  expect(row.getAttribute("data-row-state")).toBe("plain");
  expect(textsIn(row, "[data-row-note]")).toEqual([]);
  expect(row.title).toBe("Tower H");
  await act(async () => row.click());
  await vi.waitFor(() => expect(calls.onView).toHaveBeenCalledWith("towerH:p"));
});

/** The switcher on Tower H's page, one of three linked machines. */
const onTowerH = (extra: Partial<SwitcherProps> = {}) => ({
  label: "Tower H",
  current: "towerH:p",
  copies: [
    copy("laptopE:p", "Laptop E"),
    member("towerH:p", "Tower H"),
    member("deskB:p", "Desk B"),
  ],
  ...extra,
});

it("offers no way to move, continue or take over a coordinator on any machine shown (AC-35)", async () => {
  for (const shown of [{}, onTowerH()]) {
    await renderSwitcher({ ...handlers(), ...shown, onMigrate: vi.fn(), onLeave: vi.fn() });
    expect(document.querySelector("[data-orchestrator-continue]")).toBeNull();
    expect(document.querySelector("[data-orchestrator-fix]")).toBeNull();
    expect(menuText()).not.toMatch(/Continue the coordinator|Handing off|Extra coordinator|Fix…/);
    await act(async () => root.render(<></>));
  }
});

it("never starts a second coordinator and names no role in any item", async () => {
  // Every machine already runs its own coordinator: nothing starts, moves or demotes one.
  expect("useStartCoordinator" in switcherModule).toBe(false);
  await renderSwitcher({
    ...handlers(),
    ...onTowerH({
      copies: [
        copy("m4:p", "M4"),
        member("minis:p", "Minis", true),
        member("m1:p", "M1"),
        member("m3:p", "M3"),
        copy("m5:p", "M5", "independent"),
      ],
    }),
    unknown: [{ key: "linux-mini:p", machine: "linux-mini" }],
    onSync: vi.fn(),
    onAdd: vi.fn(),
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
  expect(text).not.toMatch(/[Cc]oordinator|Handing off|Fix…/);
  expect(document.querySelectorAll("[data-orchestrator-make-main]")).toHaveLength(0);
});

it("offers Sync… and Add to another machine…, and keeps the names of Move running threads… and Leave this machine…", async () => {
  const calls = handlers();
  await renderSwitcher({
    ...calls,
    onSync: vi.fn(),
    onAdd: vi.fn(),
    onLeave: vi.fn(),
    onMigrate: vi.fn(),
  });
  expect(rows().map((row) => row.textContent)).toEqual([
    "Laptop E",
    "Tower H",
  ]);
  // No "This project" label: the project's actions sit under its machines.
  expect(textsIn(document, '[data-slot="menu-label"]')).toEqual([
    "Atlas on your machines",
    "Work on Laptop E",
  ]);
  expect(textsIn(document, ACTION_ITEMS)).toEqual([
    "Sync…",
    "Add to another machine…",
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
});

it("leaves thread migration off while the machine shown is offline", async () => {
  await renderSwitcher(handlers());
  const migrate = item("menuitem", "Move running threads…");
  expect(migrate?.getAttribute("aria-disabled")).toBe("true");
  expect(migrate?.textContent).toBe("Move running threads…Laptop E offline");
});

it("marks an offline machine shown by its dot, never as live", async () => {
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="Tower H"
        projectTitle="Atlas"
        connected={false}
        statusDetail="Reconnecting"
        current="towerH:p"
        copies={[copy("laptopE:p", "Laptop E"), member("towerH:p", "Tower H")]}
        unknown={[]}
        savedMachineMissing={false}
        {...handlers()}
      />,
    ),
  );
  // The chip still names the machine shown; the state is the dot, and a word for screen
  // readers. The line above the message box says the rest.
  expect(container.querySelector(".sws-host-name")?.textContent).toBe("On Tower H");
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

it("offers Add to another machine and Leave with one machine, and no Sync without a second", async () => {
  const onAdd = vi.fn<() => void>();
  const onLeave = vi.fn<() => void>();
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="Laptop E"
        projectTitle="Atlas"
        connected
        statusDetail=""
        current="laptopE:p"
        copies={[copy("laptopE:p", "Laptop E", "single")]}
        unknown={[]}
        savedMachineMissing={false}
        onView={vi.fn()}
        onAllowWorkers={null}
        onAdd={onAdd}
        onLeave={onLeave}
      />,
    ),
  );
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>(`[aria-label="Laptop E: this project's machines"]`)!
      .click(),
  );
  expect(document.querySelector('[role="menuitemradio"]')).toBeNull();
  expect(item("menuitem", "Leave this machine…")).toBeDefined();
  expect(item("menuitem", "Sync…")).toBeUndefined();
  expect(item("menuitem", "Send to another machine…")).toBeUndefined();
  expect(item("menuitem", "Move to another machine…")).toBeUndefined();
  await act(async () => item("menuitem", "Add to another machine…")!.click());
  await vi.waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
  expect(onLeave).not.toHaveBeenCalled();
});

it("shows one sync fact on a row for another machine, and none on the machine shown", async () => {
  const onOpenChange = vi.fn<(open: boolean) => void>();
  await renderSwitcher({
    ...handlers(),
    ...onTowerH({
      copies: [
        copy("laptopE:p", "Laptop E"),
        member("towerH:p", "Tower H"),
        member("kioskD:p", "Kiosk D"),
        member("deskB:p", "Desk B"),
      ],
    }),
    onSync: vi.fn(),
    onOpenChange,
    syncOf: (key) =>
      key === "laptopE:p"
        ? {
            sync: {
              tone: "differs",
              text: "{k} of {n} repositories differ",
              values: { k: "3", n: "5" },
            },
          }
        : key === "kioskD:p"
          ? { sync: { tone: "same", text: "Same as {shown}", values: { shown: "Tower H" } } }
          : key === "deskB:p"
            ? {
                sync: { tone: "unknown", text: "Not checked yet" },
                needsUpdate: { version: "1.0.360" },
              }
            : // The machine shown: a fact passed for it is never drawn.
              { sync: { tone: "same", text: "Same as {shown}", values: { shown: "Tower H" } } },
  });
  // Opening the menu is when the statuses are read.
  expect(onOpenChange).toHaveBeenCalledWith(true, expect.anything());
  const facts = (key: string) =>
    textsIn(document.querySelector(`[data-orchestrator-view="${key}"]`)!, "[data-row-sync]");
  expect(facts("laptopE:p")).toEqual(["3 of 5 repositories differ"]);
  expect(facts("kioskD:p")).toEqual(["Same as Tower H"]);
  expect(facts("deskB:p")).toEqual(["Not checked yet"]);
  expect(facts("towerH:p")).toEqual([]);
  expect(
    textsIn(document.querySelector('[data-orchestrator-view="deskB:p"]')!, "[data-row-note]"),
  ).toEqual(["Needs update · 1.0.360"]);
});

it("greys Sync… with its reason when the machine shown cannot sync", async () => {
  const onSync = vi.fn<() => void>();
  await renderSwitcher({
    ...handlers(),
    onSync,
    syncBlocked: { text: "This window can only read {machine}", values: { machine: "Laptop E" } },
  });
  const sync = item("menuitem", "Sync…This window can only read Laptop E")!;
  expect(sync.getAttribute("aria-disabled")).toBe("true");
  await act(async () => sync.click());
  expect(onSync).not.toHaveBeenCalled();
});

/** Opens the info button by the menu's first label, where what viewing means is kept. */
const showInfo = async () => {
  const button = document.querySelector<HTMLElement>('[data-slot="menu-info-button"]');
  if (button) await act(async () => button.click());
};
const unlinkedNote = () =>
  document.querySelector("[data-orchestrator-unlinked-note]")?.textContent ?? null;
const separate = [
  copy("laptopE:p", "Laptop E", "independent"),
  copy("deskB:p", "Desk B", "independent"),
];

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
    "Laptop ESeparate project",
    "Desk BSeparate project",
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
    links: [{ key: "deskB:p", machine: "Desk B" }],
  });
  await showInfo();
  expect(unlinkedNote()).toMatch(
    /You can still open and message each one\. Link them below to make one project\.$/,
  );
});

it("does not point at link items a listed machine does not have", async () => {
  // Kiosk D is listed, but only Desk B can be linked (Kiosk D sits at another place in the repository).
  await renderSwitcher({
    ...handlers(),
    copies: [...separate, copy("kioskD:p", "Kiosk D", "independent")],
    onLink: vi.fn<(key: string) => void>(),
    links: [{ key: "deskB:p", machine: "Desk B" }],
  });
  await showInfo();
  expect(unlinkedNote()).toMatch(/You can still open and message each one\.$/);
  expect(document.querySelectorAll("[data-orchestrator-link]")).toHaveLength(1);
});

it("keeps that note off a group with a linked machine this window never opened", async () => {
  await renderSwitcher({
    ...handlers(),
    copies: separate,
    unknown: [{ key: "rackF:p", machine: "Rack F" }],
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
    copies: [copy("laptopE:p", "Laptop E"), copy("deskB:p", "Desk B", "independent")],
  });
  expect(rows().map((row) => row.textContent)).toEqual([
    "Laptop E",
    "Desk BSeparate project",
  ]);
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
    links: [{ key: "rackF:old", machine: "Rack F" }],
  });
  const links = [...document.querySelectorAll<HTMLElement>("[data-orchestrator-link]")];
  expect(links.map((link) => link.textContent)).toEqual(["Link Rack F to this project…"]);
  // Linking never moves the coordinator, and the item says so before the confirmation does.
  expect(links[0]?.title).toBe(
    "Makes the project on Rack F part of this one. The coordinator stays where it is, and threads and files stay where they are. You confirm what Rack F gives up first.",
  );
  await act(async () => links[0]!.click());
  await vi.waitFor(() => expect(onLink).toHaveBeenCalledWith("rackF:old"));
  expect(calls.onView).not.toHaveBeenCalled();
});

it("says under Link why the last try to link failed, until the two are linked", async () => {
  const menu = { ...handlers(), onLink: vi.fn(), links: [{ key: "rackF:old", machine: "Rack F" }] };
  const refusal = () => document.querySelector("[data-orchestrator-link-refusal]")?.textContent;
  await renderSwitcher(menu);
  expect(refusal()).toBeUndefined();
  // Add ended without linking and its dialog was closed: the menu still says why.
  await act(async () =>
    rememberLinkRefusal(CURRENT, "rackF:old", {
      text: "Project notes differ on {machine}.",
      values: { machine: "Rack F" },
    }),
  );
  expect(refusal()).toBe("Not linked yet. Project notes differ on Rack F.");
  expect(document.querySelector("[data-orchestrator-link]")?.textContent).toContain(
    "Link Rack F to this project…",
  );
  // A failure for another pair of projects is not this row's.
  await act(async () => resetLinkRefusalsForTest());
  await act(async () =>
    rememberLinkRefusal(CURRENT, "rackF:other", { text: "No.", verbatim: true }),
  );
  expect(refusal()).toBeUndefined();
  await act(async () => rememberLinkRefusal(CURRENT, "rackF:old", { text: "No.", verbatim: true }));
  expect(refusal()).toBe("Not linked yet. No.");
  await act(async () => forgetLinkRefusal("rackF:old", CURRENT));
  expect(refusal()).toBeUndefined();
});

it("says under Link why linking threw, after Add was closed and the menu opened again", async () => {
  linkCopy.mockRejectedValue(new Error("The two notes could not be merged."));
  await act(async () => root.render(<AddDone />));
  expect(linkCopy).toHaveBeenCalledTimes(1);
  // Add is closed: nothing of it is on screen, and nothing was put in the menu's memory here.
  await act(async () => root.render(<div />));
  await renderSwitcher({
    ...handlers(),
    onLink: vi.fn(),
    links: [{ key: "rackF:old", machine: "Rack F" }],
  });
  expect(document.querySelector("[data-orchestrator-link-refusal]")?.textContent).toBe(
    "Not linked yet. The two notes could not be merged.",
  );
});

it("says under Link why a copy finished in the background could not be linked", async () => {
  // The copy to Rack F finished with Add closed; the watcher links it and the link throws.
  vi.useFakeTimers();
  try {
    linkCopy.mockRejectedValue(new Error("The two notes could not be merged."));
    localStorage.setItem(
      "specwithcode:folder-copy:laptopE:p",
      JSON.stringify({
        operationId: "00000000-0000-4000-8000-000000000009",
        environmentId: "rackF",
        mode: "copy-only",
        targetFolder: "/home/sam/projects/atlas",
        projectId: null,
      }),
    );
    commands.handlers = {
      copyStatus: () => ({
        state: "applied",
        mode: "copy-only",
        committed: true,
        projectId: "old",
        rows: [],
        checks: [],
        unstable: [],
      }),
    };
    await act(async () =>
      root.render(
        <HandoffFolderCopyWatcher
          environmentId={"laptopE" as never}
          projectId="p"
          projectName="Atlas"
          machineLabel={() => "Rack F"}
        />,
      ),
    );
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(linkCopy).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    commands.handlers = {};
    localStorage.clear();
  }
  // Nothing of the copy is on screen, and nothing was put in the menu's memory here.
  await renderSwitcher({
    ...handlers(),
    onLink: vi.fn(),
    links: [{ key: "rackF:old", machine: "Rack F" }],
  });
  expect(document.querySelector("[data-orchestrator-link-refusal]")?.textContent).toBe(
    "Not linked yet. The two notes could not be merged.",
  );
});

it("gives a separate project Link, never Continue or a coordinator move", async () => {
  // Shown on Rack F, a separate project, even with an offer for Rack F itself: it has no coordinator
  // of this project to continue.
  await renderSwitcher({
    ...handlers(),
    label: "Rack F",
    current: "rackF:old",
    onLink: vi.fn<(key: string) => void>(),
    copies: [
      copy("laptopE:p", "Laptop E", "independent"),
      copy("rackF:old", "Rack F", "independent"),
    ],
    links: [{ key: "laptopE:p", machine: "Laptop E" }],
  });
  const labels = textsIn(document, ACTION_ITEMS);
  expect(labels).toContain("Link Laptop E to this project…");
  expect(document.querySelector("[data-orchestrator-continue]")).toBeNull();
  expect(labels.some((label) => /^Make|^Move coordinator|^Continue/.test(label ?? ""))).toBe(false);
});

it("offers no link where linking is not allowed or nothing matches", async () => {
  const calls = handlers();
  await renderSwitcher({ ...calls, links: [{ key: "rackF:old", machine: "Rack F" }] });
  expect(document.querySelector("[data-orchestrator-link]")).toBeNull();
  await act(async () => root.render(<></>));
  await renderSwitcher({ ...calls, onLink: vi.fn<(key: string) => void>() });
  expect(document.querySelector("[data-orchestrator-link]")).toBeNull();
});

it("stays a plain label with one machine and no machine actions", async () => {
  await act(async () =>
    root.render(
      <OrchestratorSwitcher
        label="Laptop E"
        projectTitle="Atlas"
        connected
        statusDetail=""
        current="laptopE:p"
        copies={[copy("laptopE:p", "Laptop E", "single")]}
        unknown={[]}
        savedMachineMissing={false}
        onView={vi.fn()}
        onAllowWorkers={null}
      />,
    ),
  );
  expect(container.querySelector("button")).toBeNull();
  expect(container.querySelector(".sws-host-name")?.textContent).toBe("On Laptop E");
});

it("opens linking on the coordinator's own project, never on one that follows an unloaded coordinator", () => {
  const atlas = { logicalProject: { id: "atlas" } };
  const viewed = { environmentId: "rackF", id: "p", workspaceSettings: atlas };
  const coordinator = { environmentId: "laptopE", id: "p", workspaceSettings: atlas };
  const alone = { environmentId: "rackF", id: "q" };
  const [rackF, laptopE, single] = [viewed, coordinator, alone] as unknown as EnvironmentProject[];
  const copies = [copy("laptopE:p", "Laptop E"), member("rackF:p", "Rack F")];
  expect(linkKeeper(rackF!, [laptopE!, rackF!], copies)).toBe(laptopE);
  // The coordinator's project is linked but never loaded here: nothing keeps it.
  expect(linkKeeper(rackF!, [rackF!], copies)).toBeNull();
  expect(linkKeeper(rackF!, [rackF!], [member("rackF:p", "Rack F")])).toBeNull();
  // A project on its own keeps itself.
  expect(linkKeeper(single!, [single!], [])).toBe(single);
});
