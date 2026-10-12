import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeServiceUpdate,
  resolveServiceUpdateAction,
} from "./UpdatePreferencesSection.logic";

const state = (overrides: Partial<StudioServiceUpdateState>): StudioServiceUpdateState => ({
  status: "up-to-date",
  identity: "m4",
  installedVersion: "0.1.4",
  availableVersion: null,
  downloadedVersion: null,
  checkedAt: null,
  quietSince: null,
  message: null,
  lastInstall: null,
  ...overrides,
});

describe("UpdatePreferencesSection.logic", () => {
  it("describes each service update stage", () => {
    expect(describeServiceUpdate(state({}))).toBe("Version 0.1.4. Up to date.");
    expect(
      describeServiceUpdate(state({ status: "waiting-for-quiet", downloadedVersion: "0.2.0" })),
    ).toBe("Version 0.1.4. Version 0.2.0 installs once no session has worked for a while.");
    expect(
      describeServiceUpdate(
        state({ status: "manual-required", message: "Studio 0.2.0 needs a manual upgrade." }),
      ),
    ).toBe("Studio 0.2.0 needs a manual upgrade.");
  });

  it("offers install when a release is waiting and check otherwise", () => {
    expect(resolveServiceUpdateAction(state({ status: "available" }))).toBe("install");
    expect(resolveServiceUpdateAction(state({ status: "waiting-for-quiet" }))).toBe("install");
    expect(resolveServiceUpdateAction(state({ status: "error" }))).toBe("check");
    expect(resolveServiceUpdateAction(state({ status: "installing" }))).toBe("none");
    expect(resolveServiceUpdateAction(state({ status: "not-managed" }))).toBe("none");
  });
});
