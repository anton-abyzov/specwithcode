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
    expect(button("Save").disabled).toBe(true);
  });

  it("saves M5 in one step with the chip letters following the name", () => {
    state.nicknames = { [live]: { name: "Anton M5MAX", updatedAt: "2026-11-13T00:00:00Z", short: "m5x" } };
    open();
    act(() => button("Use M5").click());
    expect(nameInput().value).toBe("M5");
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

  it("keeps chip letters, color and icon under Customize", () => {
    open();
    expect(document.querySelector("[data-machine-short-input]")).toBeNull();
    act(() => button("Customize chip letters, color and icon").click());
    expect(document.querySelector("[data-machine-short-input]")).not.toBeNull();
    expect(document.querySelector("[data-machine-color-choices]")).not.toBeNull();
  });
});
