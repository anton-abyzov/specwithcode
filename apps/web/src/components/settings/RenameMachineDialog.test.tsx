// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  nicknames: {} as Record<string, { name: string; updatedAt: string; short?: string }>,
  labels: new Map<string, string>(),
  saveIdentity: vi.fn(() => true),
}));
vi.mock("../../studio/machineNickname", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../studio/machineNickname")>();
  return {
    ...actual,
    useMachineNameSources: () => ({ nicknames: state.nicknames, labels: state.labels }),
    useCustomMachineNickname: (id: string | null) => state.nicknames[id ?? ""]?.name ?? null,
    // The real hook reads the store inside its own module, past this mock; resolve from state.
    useMachineNameHolder: () => (id: string, name: string) => {
      const names = new Map<string, string>(state.labels);
      for (const [key, entry] of Object.entries(state.nicknames)) names.set(key, entry.name);
      const wanted = name.trim().toLowerCase();
      for (const [key, shown] of names) {
        if (key !== id && shown.trim().toLowerCase() === wanted) return { environmentId: key, name: shown };
      }
      return null;
    },
  };
});
vi.mock("../../studio/machineIdentity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../studio/machineIdentity")>()),
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
    state.nicknames = { [live]: { name: "Studio", updatedAt: "2026-11-13T00:00:00Z", short: "MX" } };
    open();
    type(nameInput(), "Studi");
    type(nameInput(), "Studio");
    expect(document.querySelector("[data-preview-short]")?.textContent).toBe("MX");
    expect(button("Save").disabled).toBe(true);
    type(nameInput(), "Desk");
    expect(document.querySelector("[data-preview-short]")?.textContent).not.toBe("MX");
  });

  it("saves M5 in one step with the chip letters following the name", () => {
    state.nicknames = { [live]: { name: "Anton M5MAX", updatedAt: "2026-11-13T00:00:00Z", short: "m5x" } };
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

  it("warns when another machine already goes by the name", () => {
    state.nicknames = { "stale-m5": { name: "m5", updatedAt: "2026-11-12T00:00:00Z" } };
    open();
    type(nameInput(), "M5");
    expect(document.querySelector("[data-machine-name-clash]")?.textContent).toContain(
      "Another machine is already called m5.",
    );
    expect(button("Save").disabled).toBe(false);
  });

  it("lets the chip letters follow the computer name when going back to it", () => {
    state.nicknames = { [live]: { name: "Studio", updatedAt: "2026-11-13T00:00:00Z", short: "MX" } };
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

  it("keeps chip letters, color and icon under Customize", () => {
    open();
    expect(document.querySelector("[data-machine-short-input]")).toBeNull();
    act(() => button("Customize chip letters, color and icon").click());
    expect(document.querySelector("[data-machine-short-input]")).not.toBeNull();
    expect(document.querySelector("[data-machine-color-choices]")).not.toBeNull();
  });
});
