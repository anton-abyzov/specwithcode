import { describe, expect, it } from "vite-plus/test";

import { MODEL_CHIP_FITS, chooseModelChipFit, modelChipShows } from "./modelChipFit";

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
