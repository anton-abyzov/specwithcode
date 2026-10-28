// @vitest-environment jsdom
import type { EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { destinationOptions, MachineOptionRows } from "./MachineOptionRows";

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
});

const id = (value: string) => value as EnvironmentId;

it("maps machines to rows: offline ones disabled with a reason, updates flagged but choosable", () => {
  expect(
    destinationOptions([
      { environmentId: id("minis"), label: "Minis", state: "reachable" },
      { environmentId: id("m3"), label: "M3", state: "reachable", reason: "Needs an update" },
      { environmentId: id("m1"), label: "M1", state: "offline", reason: "Not connected" },
      { environmentId: id("old"), label: "Old", state: "offline" },
    ]),
  ).toEqual([
    { value: "minis", label: "Minis", tone: "ready", reason: null },
    { value: "m3", label: "M3", tone: "attention", reason: "Needs an update" },
    { value: "m1", label: "M1", tone: "off", reason: "Not connected", disabled: true },
    { value: "old", label: "Old", tone: "off", reason: "Offline", disabled: true },
  ]);
});

it("renders a radio per machine with its reason and reports the pick", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <MachineOptionRows
        aria-label="Machine"
        value="minis"
        onChange={onChange}
        options={destinationOptions([
          { environmentId: id("minis"), label: "Minis", state: "reachable" },
          { environmentId: id("m3"), label: "M3", state: "reachable" },
          { environmentId: id("m1"), label: "M1", state: "offline" },
        ])}
      />,
    ),
  );
  const rows = [...container.querySelectorAll('[data-slot="machine-option"]')];
  expect(rows.map((row) => row.textContent)).toEqual(["Minis", "M3", "M1Offline"]);
  expect(rows.map((row) => row.getAttribute("data-tone"))).toEqual(["ready", "ready", "off"]);
  const radios = [...container.querySelectorAll('[role="radio"]')];
  expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
    "true",
    "false",
    "false",
  ]);
  expect(radios[2]!.hasAttribute("data-disabled")).toBe(true);
  await act(async () => (radios[1] as HTMLElement).click());
  expect(onChange).toHaveBeenCalledWith("m3");
  onChange.mockClear();
  await act(async () => (radios[2] as HTMLElement).click());
  expect(onChange).not.toHaveBeenCalled();
});
