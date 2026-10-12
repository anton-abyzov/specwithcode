import type { ExternalBrowser } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildLinkTargetOptions,
  externalBrowserChoices,
  OPEN_IN_DEFAULT_BROWSER_LABEL,
  openOutsideAppLabel,
} from "./externalBrowserOptions";

const browsers: ReadonlyArray<ExternalBrowser> = [
  {
    id: "chrome",
    name: "Chrome",
    profiles: [
      { directory: "Default", name: "Personal" },
      { directory: "Profile 2", name: "Work", account: "ads@work.example" },
    ],
  },
  { id: "brave", name: "Brave", profiles: [] },
];

describe("externalBrowserChoices", () => {
  it("lists one choice per profile and one per profile-less browser", () => {
    expect(externalBrowserChoices(browsers)).toEqual([
      {
        key: "external:chrome:Default",
        label: "Chrome — Personal",
        target: { browserId: "chrome", profileDirectory: "Default" },
      },
      {
        key: "external:chrome:Profile 2",
        label: "Chrome — Work",
        detail: "ads@work.example",
        target: { browserId: "chrome", profileDirectory: "Profile 2" },
      },
      { key: "external:brave:", label: "Brave", target: { browserId: "brave" } },
    ]);
  });
});

describe("buildLinkTargetOptions", () => {
  it("offers only the built-in choices without a browser list", () => {
    const { options, selected } = buildLinkTargetOptions({
      browsers: null,
      linkTarget: "system",
      externalTarget: { browserId: "chrome", profileDirectory: "Profile 2" },
    });
    expect(options.map((option) => option.value)).toEqual(["system", "app"]);
    expect(selected.value).toBe("system");
  });

  it("selects the saved profile", () => {
    const { options, selected } = buildLinkTargetOptions({
      browsers,
      linkTarget: "system",
      externalTarget: { browserId: "chrome", profileDirectory: "Profile 2" },
    });
    expect(options).toHaveLength(5);
    expect(selected.label).toBe("Chrome — Work");
    expect(selected.linkTarget).toBe("system");
  });

  it("selects SpecWithCode when links open in the app", () => {
    expect(
      buildLinkTargetOptions({ browsers, linkTarget: "app", externalTarget: null }).selected.value,
    ).toBe("app");
  });

  it("keeps a saved profile that is no longer installed visible", () => {
    const { options, selected } = buildLinkTargetOptions({
      browsers,
      linkTarget: "system",
      externalTarget: { browserId: "edge", profileDirectory: "Profile 1" },
    });
    expect(selected.label).toBe("Microsoft Edge — Profile 1 (not found)");
    expect(options.at(-1)).toBe(selected);
  });

  it("shows a browser saved without a profile as its last-used profile, not missing", () => {
    const { options, selected } = buildLinkTargetOptions({
      browsers,
      linkTarget: "system",
      externalTarget: { browserId: "chrome" },
    });
    expect(selected.label).toBe("Chrome (last used profile)");
    expect(selected.externalTarget).toEqual({ browserId: "chrome" });
    expect(options.filter((option) => option.label.includes("not found"))).toEqual([]);
  });

  it("marks a browser saved without a profile as not found once it is uninstalled", () => {
    expect(
      buildLinkTargetOptions({
        browsers,
        linkTarget: "system",
        externalTarget: { browserId: "edge" },
      }).selected.label,
    ).toBe("Microsoft Edge (not found)");
  });

  it("keeps showing the saved profile while the browser list loads", () => {
    const { options, selected } = buildLinkTargetOptions({
      browsers: null,
      linkTarget: "system",
      externalTarget: { browserId: "chrome", profileDirectory: "Profile 2" },
      loading: true,
    });
    expect(selected.value).toBe("external:chrome:Profile 2");
    expect(selected.label).toBe("Chrome — Profile 2");
    expect(options.map((option) => option.value)).toEqual([
      "system",
      "app",
      "external:chrome:Profile 2",
    ]);
  });
});

describe("openOutsideAppLabel", () => {
  it("names the saved profile", () => {
    expect(
      openOutsideAppLabel({
        browsers,
        linkTarget: "system",
        externalTarget: { browserId: "chrome", profileDirectory: "Profile 2" },
      }),
    ).toBe("Open in Chrome — Work");
  });

  it("says default browser without a saved profile or when links open in the app", () => {
    expect(openOutsideAppLabel({ browsers, linkTarget: "system", externalTarget: null })).toBe(
      OPEN_IN_DEFAULT_BROWSER_LABEL,
    );
    expect(
      openOutsideAppLabel({
        browsers,
        linkTarget: "app",
        externalTarget: { browserId: "chrome", profileDirectory: "Profile 2" },
      }),
    ).toBe(OPEN_IN_DEFAULT_BROWSER_LABEL);
  });
});
