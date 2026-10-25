import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  resolveRestingComposerControlsLayout,
  resolveRestingComposerControlsNaturalWidth,
} from "../composerFooterLayout";
import { chipGroupSiblingsWidth } from "./modelChipFit";
import { measureRestingComposerControls } from "./restingComposerControlsMeasurement";

function measurePicker(input: { clientWidth: number; flexGrow: string; maxWidth?: string }) {
  const label = { clientWidth: input.clientWidth, scrollWidth: 160 };
  const picker = {
    getBoundingClientRect: () => ({ width: 52 }),
    querySelector: () => label,
    // A picker without provider and model parts is not a model chip.
    querySelectorAll: () => [],
  };
  const controls = {
    querySelector: (selector: string) => {
      if (selector === "[data-chat-provider-model-picker]") return picker;
      if (selector === "[data-resting-controls-overflow]") {
        return { getBoundingClientRect: () => ({ width: 24 }) };
      }
      return null;
    },
    querySelectorAll: () => [
      {
        dataset: {},
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ width: 140 }),
      },
    ],
  };
  vi.stubGlobal("getComputedStyle", (element: unknown) => {
    if (element === label) return { flexGrow: input.flexGrow };
    if (element === picker) return { minWidth: "52px", maxWidth: input.maxWidth ?? "none" };
    return { columnGap: "4px" };
  });
  return measureRestingComposerControls(controls as unknown as HTMLElement)!;
}

afterEach(() => vi.unstubAllGlobals());

describe("measureRestingComposerControls", () => {
  it("keeps controls inline when the model label is deliberately collapsed", () => {
    const measurement = measurePicker({ clientWidth: 0, flexGrow: "0" });

    expect(measurement.naturalFixedWidth).toBe(52);
    expect(resolveRestingComposerControlsNaturalWidth(measurement)).toBe(196);
    expect(resolveRestingComposerControlsLayout({ ...measurement, hostWidth: 200 })).toEqual({
      hiddenCount: 0,
      iconOnlyCount: 0,
      visible: true,
    });
  });

  it("recovers truncated text while the model label is flexible", () => {
    const measurement = measurePicker({ clientWidth: 20, flexGrow: "1" });

    expect(measurement.naturalFixedWidth).toBe(192);
    expect(resolveRestingComposerControlsLayout({ ...measurement, hostWidth: 200 })).toEqual({
      hiddenCount: 1,
      iconOnlyCount: 1,
      visible: true,
    });
  });

  it("recovers flexible text squeezed to zero instead of mistaking it for collapsed text", () => {
    const measurement = measurePicker({ clientWidth: 0, flexGrow: "1" });

    expect(measurement.naturalFixedWidth).toBe(212);
    expect(resolveRestingComposerControlsLayout({ ...measurement, hostWidth: 200 })).toEqual({
      hiddenCount: 1,
      iconOnlyCount: 1,
      visible: true,
    });
  });

  it("still caps recovered text at the model picker's maximum width", () => {
    expect(
      measurePicker({ clientWidth: 0, flexGrow: "1", maxWidth: "180px" }).naturalFixedWidth,
    ).toBe(180);
  });
});

/** A stand-in element that passes `instanceof HTMLElement`. */
class FakeElement {}
function element<T extends object>(fields: T): T {
  return Object.assign(Object.create(FakeElement.prototype), fields);
}

/** `matches` for a list of attribute selectors, against the element's own attributes. */
function matchesAttributes(...attributes: string[]) {
  return (selector: string) =>
    selector.split(",").some((part) => attributes.includes(part.trim().slice(1, -1)));
}

// Chip 150 wide at fit "model": mark and chevron 70, model 74 + 6 gap in flow; the
// provider (44) and the full state words (60) are out of flow. `model` sets the model
// name's natural width.
function modelChip(model = 74) {
  const row = { style: { columnGap: "6px", display: "flex" }, parentElement: null };
  const part = (name: string, width: number, inFlow: boolean) => ({
    dataset: { modelChipPart: name },
    scrollWidth: width,
    getBoundingClientRect: () => ({ width }),
    parentElement: row,
    style: { position: inFlow ? "static" : "absolute", display: "inline", fontSize: "14px" },
  });
  const parts = [
    part("provider", 44, false),
    part("model", model, true),
    part("state-full", 60, false),
  ];
  return element({
    style: {
      marginInlineStart: "-10px",
      marginInlineEnd: "0px",
      minWidth: "52px",
      maxWidth: "none",
    } as Record<string, string>,
    parentElement: null as unknown,
    nextElementSibling: null as unknown,
    getBoundingClientRect: () => ({ width: 76 + model }),
    querySelector: () => null,
    querySelectorAll: () => parts,
  });
}

function measureToolbar(picker: object, separatorWidth: number, wire?: (controls: object) => void) {
  const separator = { style: {}, getBoundingClientRect: () => ({ width: separatorWidth }) };
  const controls = {
    style: { columnGap: "4px" },
    querySelector: (selector: string) =>
      selector === "[data-chat-provider-model-picker]"
        ? picker
        : selector === "[data-resting-controls-separator]"
          ? separator
          : null,
    querySelectorAll: () => [],
  };
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal(
    "getComputedStyle",
    (element: { style?: Record<string, string> }) =>
      ({
        columnGap: "0px",
        marginInlineStart: "0px",
        marginInlineEnd: "0px",
        ...element.style,
      }) as never,
  );
  wire?.(controls);
  return measureRestingComposerControls(controls as never)!;
}

describe("measureRestingComposerControls with a model chip", () => {
  it("reports the chip's width at every fit with its margin and the separator", () => {
    const measurement = measureToolbar(modelChip(), 5);
    // Always shown: 150 - (74 + 6) = 70. Margin -10, separator 5 + gap 4. The name is
    // under six ems of its 14px font, so `name` needs all of it.
    expect(measurement.pickerFitWidths).toEqual({
      full: 70 + 50 + 80 + 66 - 1,
      model: 70 + 80 - 1,
      short: 70 + 80 - 1,
      name: 70 + 80 - 1,
      icon: 70 - 1,
    });
    expect(measurement.naturalFixedWidth).toBe(measurement.pickerFitWidths!.full);
    expect(measurement.minimumFixedWidth).toBe(measurement.pickerFitWidths!.icon);
  });

  it("lets only a long model name end in an ellipsis at `name`", () => {
    // 250 is over six ems of 14px: `name` counts three ems (42) and the 6 px gap.
    const long = measureToolbar(modelChip(250), 5).pickerFitWidths!;
    expect(long.short).toBe(70 + 256 - 1);
    expect(long.name).toBe(70 + 48 - 1);
    // 84 is exactly six ems, still short enough to need its whole width.
    expect(measureToolbar(modelChip(84), 5).pickerFitWidths!.name).toBe(70 + 90 - 1);
  });

  it("keeps the room of the controls in the chip's own group at every fit", () => {
    // The coordinator details pane: the toolbar holds a column wrapper around the
    // model group, whose effort is squeezed to 32 of its 71 px.
    const picker = modelChip();
    const block = element({
      matches: matchesAttributes("data-resting-block"),
      querySelector: () => null,
      querySelectorAll: () => [],
      nextElementSibling: null,
      scrollWidth: 90,
      clientWidth: 90,
      getBoundingClientRect: () => ({ width: 90 }),
      style: {},
    });
    const effort = element({
      matches: matchesAttributes("data-composer-effort"),
      querySelector: () => null,
      querySelectorAll: () => [],
      nextElementSibling: block,
      scrollWidth: 71,
      clientWidth: 32,
      getBoundingClientRect: () => ({ width: 32 }),
      style: {},
    });
    const group = {
      style: { display: "inline-flex", flexWrap: "nowrap", columnGap: "1px", paddingLeft: "6px" },
      parentElement: null as unknown,
    };
    const column = { style: { display: "inline-flex" }, parentElement: null as unknown };
    picker.parentElement = group;
    picker.nextElementSibling = effort;
    group.parentElement = column;
    const plain = measureToolbar(modelChip(), 0);
    const grouped = measureToolbar(picker, 0, (controls) => {
      column.parentElement = controls;
    });
    // Effort 71 + gap 1 and the group's 6 px padding; the toolbar's own block is not
    // counted twice.
    for (const fit of ["full", "model", "short", "name", "icon"] as const) {
      expect(grouped.pickerFitWidths![fit]).toBe(plain.pickerFitWidths![fit] + 78);
    }
    expect(grouped.naturalFixedWidth).toBe(plain.naturalFixedWidth + 78);
    expect(grouped.minimumFixedWidth).toBe(plain.minimumFixedWidth + 78);
    // A chip that fits itself, with no toolbar counting the block, leaves room for it too:
    // effort 71 + 1 and block 90 + 1.
    expect(chipGroupSiblingsWidth(picker as never, {} as never)).toBe(163);
    expect(chipGroupSiblingsWidth(picker as never, {} as never, true)).toBe(72);
  });
});
