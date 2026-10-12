import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ExternalBrowserTarget,
  OpenInExternalBrowserInput,
  externalBrowserTargetLabel,
} from "./externalBrowser.ts";

const decodeOpenInput = Schema.decodeUnknownSync(OpenInExternalBrowserInput);
const decodeTarget = Schema.decodeUnknownSync(ExternalBrowserTarget);

const browsers = [
  {
    id: "chrome",
    name: "Chrome",
    profiles: [
      { directory: "Default", name: "Personal" },
      { directory: "Profile 2", name: "Work", account: "me@work.example" },
      { directory: "Profile 3", name: "Profile 3" },
    ],
  },
];

describe("externalBrowserTargetLabel", () => {
  it("names the browser and profile", () => {
    expect(externalBrowserTargetLabel(browsers, { browserId: "chrome" })).toBe("Chrome");
    expect(
      externalBrowserTargetLabel(browsers, { browserId: "chrome", profileDirectory: "Profile 2" }),
    ).toBe("Chrome — Work");
    expect(
      externalBrowserTargetLabel(browsers, { browserId: "chrome", profileDirectory: "Profile 3" }),
    ).toBe("Chrome — Profile 3");
  });

  it("adds the folder only to tell same-named profiles apart", () => {
    const twoWork = [
      {
        ...browsers[0]!,
        profiles: [...browsers[0]!.profiles, { directory: "Profile 4", name: "Work" }],
      },
    ];
    expect(
      externalBrowserTargetLabel(twoWork, { browserId: "chrome", profileDirectory: "Profile 2" }),
    ).toBe("Chrome — Work (Profile 2)");
    expect(
      externalBrowserTargetLabel(twoWork, { browserId: "chrome", profileDirectory: "Default" }),
    ).toBe("Chrome — Personal");
  });

  it("still labels a target that is no longer installed", () => {
    expect(
      externalBrowserTargetLabel([], { browserId: "brave", profileDirectory: "Profile 1" }),
    ).toBe("Brave — Profile 1");
    expect(externalBrowserTargetLabel([], { browserId: "netscape" })).toBe("netscape");
  });
});

describe("OpenInExternalBrowserInput", () => {
  it("rejects empty ids", () => {
    expect(() =>
      decodeOpenInput({ url: "https://ads.google.com", target: { browserId: "" } }),
    ).toThrow();
    expect(
      decodeOpenInput({ url: "https://ads.google.com", target: { browserId: "chrome" } }),
    ).toEqual({
      url: "https://ads.google.com",
      target: { browserId: "chrome" },
    });
    expect(decodeTarget({ browserId: "chrome" })).toEqual({
      browserId: "chrome",
    });
  });
});
