// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  custom: null as string | null,
  lock: null as null | "unsupported" | "no-access",
  saveIdentity: vi.fn(() => true),
}));

vi.mock("../../studio/machineIdentity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../studio/machineIdentity")>();
  const m5 = {
    environmentId: "env-m5",
    name: "M5",
    color: "violet",
    icon: "laptop",
    short: "M5",
    derivedShort: "M5",
  } as const;
  const m1 = { ...m5, environmentId: "env-m1", name: "Mac mini", color: "teal", short: "M1" };
  return {
    ...actual,
    useMachineIdentity: (id: string | null) => (id === "env-m5" ? m5 : null),
    useMachineColorWearers: () =>
      new Map([
        ["violet", [m5]],
        ["teal", [m1]],
      ]),
  };
});
vi.mock("../../studio/machineNickname", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../studio/machineNickname")>()),
  useCustomMachineNickname: () => state.custom,
}));
vi.mock("../../studio/useRenameMachine", () => ({
  useRenameMachine: () => ({ lock: state.lock, rename: vi.fn(), saveIdentity: state.saveIdentity }),
}));

import { MachineColorButton } from "./MachineColor";

const m5 = EnvironmentId.make("env-m5");
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  state.custom = null;
  state.lock = null;
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

const render = () => act(() => root.render(<MachineColorButton environmentId={m5} />));
const trigger = () => document.querySelector<HTMLElement>("[data-machine-color-button]")!;
const choice = (color: string) =>
  document.querySelector<HTMLButtonElement>(`[data-machine-color-choice="${color}"]`)!;
const openPicker = () => act(() => trigger().click());

describe("MachineColorButton", () => {
  it("wears the machine's color and says which one it is", () => {
    render();
    expect(trigger().tagName).toBe("BUTTON");
    expect(trigger().getAttribute("data-machine-color")).toBe("violet");
    expect(trigger().getAttribute("aria-label")).toBe("Change the color of M5, now Violet");
  });

  it("opens the eight colors, the current one checked, the taken ones named", () => {
    render();
    openPicker();
    expect(document.querySelectorAll("[data-machine-color-choice]")).toHaveLength(8);
    expect(choice("violet").getAttribute("aria-checked")).toBe("true");
    expect(choice("teal").getAttribute("aria-label")).toBe("Teal, also on Mac mini");
    expect(choice("teal").textContent).toContain("M1");
    // The machine itself is not listed as wearing its own color.
    expect(choice("violet").getAttribute("aria-label")).toBe("Violet");
  });

  it("saves a pick at once, keeping the name, icon and chip letters", () => {
    state.custom = "M5";
    render();
    openPicker();
    act(() => choice("amber").click());
    expect(state.saveIdentity).toHaveBeenCalledWith(m5, {
      name: "M5",
      color: "amber",
      icon: "laptop",
    });
    expect(document.querySelector("[data-machine-color-choice]")).toBeNull();
  });

  it("keeps the computer name when none was chosen", () => {
    render();
    openPicker();
    act(() => choice("blue").click());
    expect(state.saveIdentity).toHaveBeenCalledWith(m5, expect.objectContaining({ name: "" }));
  });

  it("saves nothing when the same color is picked again", () => {
    render();
    openPicker();
    act(() => choice("violet").click());
    expect(state.saveIdentity).not.toHaveBeenCalled();
  });

  it("shows the color without offering a change where renaming is locked", () => {
    state.lock = "no-access";
    render();
    expect(trigger().tagName).toBe("SPAN");
    expect(trigger().getAttribute("data-machine-color")).toBe("violet");
  });
});
