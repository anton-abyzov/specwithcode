// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  nicknames: {} as Record<string, { name: string; updatedAt: string; short?: string }>,
  labels: new Map<string, string>(),
  fleet: new Map<string, string>(),
  saved: new Map<string, string>(),
  removed: new Set<string>(),
  replaced: new Map<string, string>(),
  environments: [] as Array<{ environmentId: string; connection: { phase: string } }>,
  saveIdentity: vi.fn(() => true),
}));
vi.mock("../../studio/machineNickname", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../studio/machineNickname")>();
  return {
    ...actual,
    useMachineNameSources: () => ({ nicknames: state.nicknames, labels: state.labels }),
    useCustomMachineNickname: (id: string | null) => state.nicknames[id ?? ""]?.name ?? null,
    // The real hook reads the store inside its own module, past this mock; resolve from state.
    useMachineNameHolder: () => (id: string, name: string) =>
      actual.findMachineNameHolder(
        state.nicknames,
        actual.knownMachineLabels({
          labels: state.labels,
          saved: state.saved,
          fleet: state.fleet,
          removed: state.removed,
        }),
        id,
        name,
      ),
  };
});
vi.mock("../../studio/machineIdentity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../studio/machineIdentity")>();
  return {
    ...actual,
    useMachineShortLabelPreview: () => (id: string, name: string) =>
      actual.previewMachineShortLabel(
        {
          nicknames: state.nicknames,
          labels: state.labels,
          kinds: new Map(),
          fleet: [...state.fleet.keys()],
          saved: state.saved,
          removed: state.removed,
        },
        id,
        name,
      ),
    useMachineIdentity: (id: string | null) =>
      id === null
        ? null
        : {
            environmentId: id,
            name: "Anton M5MAX PROLED",
            color: "violet",
            icon: "laptop",
            short: state.nicknames[id]?.short ?? "AM",
            derivedShort: "AM",
          },
  };
});
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: state.environments }),
  usePrimaryEnvironmentId: () => "primary",
}));
vi.mock("../../studio/fleet", () => ({ useStudioFleet: () => ({ snapshot: null }) }));
// The proof itself (complete lists, a live successor) is `replacedMachineRecords`, tested on its own.
vi.mock("./useReplacedMachineRecords", () => ({
  useReplacedMachineRecords: () => state.replaced,
}));
vi.mock("./RemoveOldRecord", () => ({
  RemoveOldRecord: ({ environmentId }: { environmentId: string }) => (
    <button type="button" data-remove-old-record={environmentId}>
      Remove old record
    </button>
  ),
}));
vi.mock("../../studio/useRenameMachine", () => ({
  useRenameMachine: () => ({ lock: null, rename: vi.fn(), saveIdentity: state.saveIdentity }),
}));

import { RenameMachineDialog } from "./RenameMachineDialog";

const live = EnvironmentId.make("live-m5");
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  state.nicknames = {};
  state.labels = new Map([[live, "Anton M5MAX PROLED"]]);
  state.fleet = new Map();
  state.saved = new Map();
  state.removed = new Set();
  state.replaced = new Map();
  state.environments = [{ environmentId: live, connection: { phase: "connected" } }];
  state.saveIdentity.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const open = () =>
  act(() =>
    root.render(
      <RenameMachineDialog
        environmentId={live}
        hostLabel="Anton M5MAX PROLED"
        open
        onOpenChange={() => {}}
      />,
    ),
  );
const nameInput = () => document.querySelector<HTMLInputElement>("input")!;
const button = (text: string) =>
  [...document.querySelectorAll("button")].find((item) => item.textContent === text)!;
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("RenameMachineDialog", () => {
  it("opens within the name limit and keeps the computer name in view", () => {
    open();
    expect(nameInput().value).toBe("Anton M5MAX");
    expect(nameInput().value.length).toBeLessThanOrEqual(16);
    expect(document.querySelector("[data-machine-host-name]")?.textContent).toBe(
      "Computer name: Anton M5MAX PROLED, unchanged.",
    );
    expect(document.querySelector("[data-preview-name]")?.textContent).toBe("Anton M5MAX PROLED");
    expect(button("Save").disabled).toBe(true);
  });

  it("saves the cut computer name when it is typed on purpose", () => {
    open();
    type(nameInput(), "Anton M5MA");
    type(nameInput(), "Anton M5MAX");
    expect(button("Save").disabled).toBe(false);
    act(() => button("Save").click());
    expect(state.saveIdentity).toHaveBeenCalledWith(
      live,
      expect.objectContaining({ name: "Anton M5MAX" }),
    );
  });

  it("warns about a clash for the cut computer name chosen on purpose", () => {
    state.nicknames = { other: { name: "Anton M5MAX", updatedAt: "2026-11-12T00:00:00Z" } };
    state.labels.set("other", "Studio M3");
    open();
    type(nameInput(), "Anton M5MA");
    type(nameInput(), "Anton M5MAX");
    expect(document.querySelector("[data-machine-name-clash]")).not.toBeNull();
  });

  it("previews the letters it shows now while the name is unchanged", () => {
    open();
    expect(document.querySelector("[data-preview-short]")?.textContent).toBe("AM");
  });

  it("keeps chosen chip letters while the name stays the same", () => {
    state.nicknames = {
      [live]: { name: "Studio", updatedAt: "2026-11-13T00:00:00Z", short: "MX" },
    };
    open();
    type(nameInput(), "Studi");
    type(nameInput(), "Studio");
    expect(document.querySelector("[data-preview-short]")?.textContent).toBe("MX");
    expect(button("Save").disabled).toBe(true);
    type(nameInput(), "Desk");
    expect(document.querySelector("[data-preview-short]")?.textContent).not.toBe("MX");
  });

  it("saves M5 in one step with the chip letters following the name", () => {
    state.nicknames = {
      [live]: { name: "Anton M5MAX", updatedAt: "2026-11-13T00:00:00Z", short: "m5x" },
    };
    open();
    act(() => button("Use M5").click());
    expect(nameInput().value).toBe("M5");
    expect(document.activeElement).toBe(nameInput());
    expect(document.querySelector("[data-preview-name]")?.textContent).toBe("M5");
    expect(document.querySelector("[data-preview-short]")?.textContent).toBe("M5");
    act(() => button("Save").click());
    expect(state.saveIdentity).toHaveBeenCalledWith(
      live,
      expect.objectContaining({ name: "M5", short: "" }),
    );
  });

  // The M5 report: this machine is "m5" with letters "m5"; two dead registrations
  // of the same computer left their synced "m5" nicknames behind.
  const leftovers = {
    "0c69470d": { name: "m5", updatedAt: "2026-11-11T00:00:00Z" },
    dd453fc8: { name: "m5", updatedAt: "2026-11-12T00:00:00Z", short: "" },
  };

  it("offers no Use M5 to a machine already called m5", () => {
    state.nicknames = {
      ...leftovers,
      [live]: { name: "m5", updatedAt: "2026-11-13T00:00:00Z", short: "m5" },
    };
    open();
    expect(document.querySelector("[data-machine-name-suggestion]")).toBeNull();
    expect(document.querySelector("[data-preview-short]")?.textContent).toBe("m5");
  });

  it("never calls a case-only change of the machine's own name a clash", () => {
    state.nicknames = {
      ...leftovers,
      [live]: { name: "m5", updatedAt: "2026-11-13T00:00:00Z", short: "m5" },
    };
    // Even a live machine that shares the name today is no new clash.
    state.labels.set("other", "Studio M3");
    state.nicknames.other = { name: "m5", updatedAt: "2026-11-13T00:00:00Z" };
    open();
    type(nameInput(), "M5");
    expect(document.querySelector("[data-machine-name-clash]")).toBeNull();
    expect(button("Save").disabled).toBe(false);
  });

  it("lets no leftover nickname hold the name or its chip letters", () => {
    state.nicknames = {
      ...leftovers,
      [live]: { name: "Anton M5MAX", updatedAt: "2026-11-13T00:00:00Z" },
    };
    open();
    act(() => button("Use M5").click());
    expect(document.querySelector("[data-machine-name-clash]")).toBeNull();
    expect(document.querySelector("[data-preview-short]")?.textContent).toBe("M5");
  });

  it("names an old record of this computer plainly and offers to remove it", () => {
    state.nicknames = { stale: { name: "m5", updatedAt: "2026-11-12T00:00:00Z" } };
    state.saved.set("stale", "Anton M5MAX PROLED");
    state.environments.push({ environmentId: "stale", connection: { phase: "error" } });
    state.replaced = new Map([["stale", live]]);
    open();
    type(nameInput(), "M5");
    const clash = document.querySelector("[data-machine-name-clash]");
    expect(clash?.getAttribute("data-machine-name-clash-kind")).toBe("old-copy");
    expect(clash?.textContent).toContain(
      "An old record of this computer, which can't connect, is still called m5.",
    );
    expect(
      clash?.querySelector("[data-remove-old-record]")?.getAttribute("data-remove-old-record"),
    ).toBe("stale");
    expect(button("Save").disabled).toBe(false);
  });

  it("offers no removal for a record of this computer not proven old", () => {
    // Reconnecting, or the lists are incomplete: it may be the live machine's own record.
    state.nicknames = { twin: { name: "m5", updatedAt: "2026-11-12T00:00:00Z" } };
    state.saved.set("twin", "Anton M5MAX PROLED");
    state.environments.push({ environmentId: "twin", connection: { phase: "connecting" } });
    open();
    type(nameInput(), "M5");
    const clash = document.querySelector("[data-machine-name-clash]");
    expect(clash?.getAttribute("data-machine-name-clash-kind")).toBe("same-computer");
    expect(clash?.textContent).toContain("If it is an old copy, remove it under Other machines.");
    expect(clash?.querySelector("[data-remove-old-record]")).toBeNull();
  });

  it("lets a record removed here hold neither the name nor its chip letters", () => {
    state.fleet = new Map([["0c69470d", "Anton M5MAX PROLED"]]);
    state.nicknames = {
      "0c69470d": { name: "m5", updatedAt: "2026-11-12T00:00:00Z" },
      [live]: { name: "Anton M5MAX", updatedAt: "2026-11-13T00:00:00Z" },
    };
    open();
    act(() => button("Use M5").click());
    expect(document.querySelector("[data-machine-name-clash]")).not.toBeNull();
    expect(document.querySelector("[data-preview-short]")?.textContent).not.toBe("M5");
    state.removed = new Set(["0c69470d"]);
    type(nameInput(), "M");
    type(nameInput(), "M5");
    expect(document.querySelector("[data-machine-name-clash]")).toBeNull();
    expect(document.querySelector("[data-preview-short]")?.textContent).toBe("M5");
  });

  it("names another machine that goes by the name by its computer name", () => {
    state.nicknames = { other: { name: "m5", updatedAt: "2026-11-12T00:00:00Z" } };
    state.labels.set("other", "Studio M3");
    state.environments.push({ environmentId: "other", connection: { phase: "connected" } });
    open();
    type(nameInput(), "M5");
    const clash = document.querySelector("[data-machine-name-clash]");
    expect(clash?.getAttribute("data-machine-name-clash-kind")).toBe("other");
    expect(clash?.textContent).toContain("Studio M3 is already called m5.");
    expect(clash?.querySelector("[data-remove-old-record]")).toBeNull();
  });

  it("lets the chip letters follow the computer name when going back to it", () => {
    state.nicknames = {
      [live]: { name: "Studio", updatedAt: "2026-11-13T00:00:00Z", short: "MX" },
    };
    open();
    act(() => button("Use the computer name").click());
    expect(state.saveIdentity).toHaveBeenCalledWith(
      live,
      expect.objectContaining({ name: "", short: "" }),
    );
  });

  it("previews the chip letters the fleet will assign after saving", () => {
    // Sorted ids decide who claims first: this machine before "zeta", so after the
    // rename it takes BE and zeta moves on, though zeta shows BE today.
    state.labels = new Map([
      [live, "Alpha"],
      ["zeta", "Beta"],
    ]);
    open();
    type(nameInput(), "Big Engine");
    expect(document.querySelector("[data-preview-short]")?.textContent).toBe("BE");
  });

  it("previews derived letters once chosen ones are cleared", () => {
    state.nicknames = {
      [live]: { name: "Studio", updatedAt: "2026-11-13T00:00:00Z", short: "MX" },
    };
    state.labels = new Map([[live, "Anton M5MAX PROLED"]]);
    open();
    act(() => button("Customize chip letters, color and icon").click());
    type(document.querySelector<HTMLInputElement>("[data-machine-short-input]")!, "");
    expect(document.querySelector("[data-preview-short]")?.textContent).toBe("ST");
  });

  it("keeps chip letters, color and icon under Customize", () => {
    open();
    expect(document.querySelector("[data-machine-short-input]")).toBeNull();
    act(() => button("Customize chip letters, color and icon").click());
    expect(document.querySelector("[data-machine-short-input]")).not.toBeNull();
    expect(document.querySelector("[data-machine-color-choices]")).not.toBeNull();
  });
});
