import type { FirstRunResumeMarker } from "@specweave-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  FIRST_RUN_RESUME_MAX_AGE_MS,
  firstRunResumeApplies,
  saveFirstRunResume,
  takeFirstRunResume,
} from "./firstRunResume";

const AT = 1_800_000_000_000;
const marker: FirstRunResumeMarker = {
  step: "access",
  environmentId: "this-mac",
  setupIds: ["this-mac", "studio"],
  at: AT,
};
const context = {
  now: AT + 30_000,
  primaryEnvironmentId: "this-mac",
  listedIds: ["this-mac", "studio", "mini"],
  finished: false,
};

describe("firstRunResumeApplies", () => {
  it("a fresh marker for this machine, with its machines listed, applies", () => {
    expect(firstRunResumeApplies(marker, context)).toBe(true);
  });
  it.each([
    ["no marker", null, {}],
    ["setup finished", marker, { finished: true }],
    ["older than ten minutes", marker, { now: AT + FIRST_RUN_RESUME_MAX_AGE_MS + 1 }],
    ["from the future", marker, { now: AT - 1 }],
    ["another machine's", marker, { primaryEnvironmentId: "studio" }],
    ["primary not known yet", marker, { primaryEnvironmentId: null }],
    ["a machine no longer listed", marker, { listedIds: ["this-mac"] }],
    ["no machines", { ...marker, setupIds: [] }, {}],
  ] as const)("%s does not apply", (_name, given, overrides) => {
    expect(firstRunResumeApplies(given, { ...context, ...overrides })).toBe(false);
  });
});

describe("the desktop bridge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("saves the Access step with the machines being set up", async () => {
    const save = vi.fn(async () => undefined);
    vi.stubGlobal("window", { desktopBridge: { saveFirstRunResume: save } });
    await saveFirstRunResume("this-mac", ["this-mac", "studio"], AT);
    expect(save).toHaveBeenCalledWith(marker);
  });

  it("a build without the calls saves nothing and takes nothing", async () => {
    vi.stubGlobal("window", { desktopBridge: {} });
    await expect(saveFirstRunResume("this-mac", ["this-mac"])).resolves.toBeUndefined();
    await expect(takeFirstRunResume()).resolves.toBeNull();
  });

  it("a take that fails reads as no marker", async () => {
    vi.stubGlobal("window", {
      desktopBridge: { takeFirstRunResume: () => Promise.reject(new Error("gone")) },
    });
    await expect(takeFirstRunResume()).resolves.toBeNull();
  });
});
