import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  MODEL_CHIP_FITS,
  chooseModelChipFit,
  measureModelChipFitWidths,
  modelChipShows,
} from "./modelChipFit";

const widths = { full: 300, model: 190, short: 160, name: 140, icon: 70 } as const;

describe("chooseModelChipFit", () => {
  it("picks the richest fit that the room holds", () => {
    expect(chooseModelChipFit(widths, 1000)).toBe("full");
    expect(chooseModelChipFit(widths, 300)).toBe("full");
    expect(chooseModelChipFit(widths, 299)).toBe("model");
    expect(chooseModelChipFit(widths, 160)).toBe("short");
    expect(chooseModelChipFit(widths, 159)).toBe("name");
    expect(chooseModelChipFit(widths, 139)).toBe("icon");
  });

  it("stays on the icon when even the icon does not fit", () => {
    expect(chooseModelChipFit(widths, 10)).toBe("icon");
  });

  it("needs a pixel of slack to grow back, but shrinks at once", () => {
    expect(chooseModelChipFit(widths, 300, "model")).toBe("model");
    expect(chooseModelChipFit(widths, 301, "model")).toBe("full");
    expect(chooseModelChipFit(widths, 299, "full")).toBe("model");
    expect(chooseModelChipFit(widths, 300, "full")).toBe("full");
  });
});

describe("modelChipShows", () => {
  it("gives up the provider, the state words, the usage, then the model name", () => {
    const shown = (part: Parameters<typeof modelChipShows>[1]) =>
      MODEL_CHIP_FITS.filter((fit) => modelChipShows(fit, part));
    expect(shown("provider")).toEqual(["full"]);
    expect(shown("state-full")).toEqual(["full"]);
    expect(shown("usage-value")).toEqual(["full", "model"]);
    expect(shown("usage-detail")).toEqual(["full"]);
    expect(shown("state-short")).toEqual(["model"]);
    // At `icon` the ring wraps the mark instead (ModelUsageMarkRing), out of flow.
    expect(shown("usage-ring")).toEqual(["full", "model", "short"]);
    expect(shown("model")).toEqual(["full", "model", "short", "name"]);
  });

  it("gives up the provider mark before the model name is cut short", () => {
    const shown = MODEL_CHIP_FITS.filter((fit) => modelChipShows(fit, "mark"));
    // `name` names the model alone; `icon` brings the mark back in its place.
    expect(shown).toEqual(["full", "model", "short", "icon"]);
  });
});

describe("measureModelChipFitWidths with a usage button", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("counts a number inside the usage button once, and the button's own room with the ring", () => {
    vi.stubGlobal(
      "getComputedStyle",
      (element: { style?: Record<string, string> }) =>
        ({
          columnGap: "0px",
          marginInlineStart: "0px",
          marginInlineEnd: "0px",
          position: "static",
          display: "inline",
          fontSize: "14px",
          ...element.style,
        }) as never,
    );
    const chip = { style: { columnGap: "6px" }, parentElement: null };
    const row = { style: { columnGap: "6px" }, parentElement: chip };
    const fake = (name: string, width: number, parent: object) => ({
      dataset: { modelChipPart: name },
      scrollWidth: width,
      getBoundingClientRect: () => ({ width }),
      parentElement: parent,
      style: {},
    });
    const model = fake("model", 60, row);
    // The usage button: 4px start padding, ring 12, gap 4, number 26, 10px end padding.
    const button = { ...fake("usage-ring", 56, chip), style: { columnGap: "4px" } };
    const value = fake("usage-value", 26, button);
    // Chip: 10px padding, mark 16 + 6, model 60, 6 gap, button 56.
    const root = {
      getBoundingClientRect: () => ({ width: 10 + 16 + 6 + 60 + 6 + 56 }),
      querySelectorAll: () => [model, button, value],
    };
    (chip as { parentElement: unknown }).parentElement = root;
    const widths = measureModelChipFitWidths(root as never)!;
    // Everything shows at `model`: the rendered width, nothing counted twice.
    expect(widths.model).toBe(154);
    // `short` drops the number and its gap; the button keeps ring and padding.
    expect(widths.short).toBe(154 - 30);
    // `name` drops the whole button; the name counts only its first characters when long.
    expect(widths.name).toBe(26 + 66);
  });
});
