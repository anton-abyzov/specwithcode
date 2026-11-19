import type {
  DesktopAppSwapGate,
  DesktopUpdateState,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveServiceUpdateAction } from "../settings/UpdatePreferencesSection.logic";
import {
  describeInstallOutcome,
  getRestartToUpdateView,
  isFailedInstallHeld,
  isServiceErrorWithRelease,
  serviceInstallTarget,
} from "./SidebarRestartToUpdate.logic";

// M4, November 18, 2026: the agent failed an automatic install of 1.0.344 and
// then held every newer release until a person asked. Nothing offered to ask:
// the sidebar's only button installed the app alone, which main refused
// because the service was behind ("installs after the service updates").

const HELD = "SpecWithCode 1.0.356 did not install automatically; choose Install now to retry.";
const FIRST_FAILURE =
  "SpecWithCode 1.0.344 did not install; SpecWithCode stayed on 1.0.338. See the update receipt.";

const appDownloaded: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "1.0.338",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "1.0.356",
  downloadedVersion: "1.0.356",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: true,
  productionBuild: true,
};

// m4's updates/state.json, as the desktop reads it.
const held: StudioServiceUpdateState = {
  status: "error",
  identity: "m4",
  installedVersion: "1.0.338",
  availableVersion: "1.0.356",
  downloadedVersion: "1.0.356",
  checkedAt: "2026-11-18T15:09:43.305Z",
  quietSince: null,
  message: HELD,
  lastInstall: { version: "1.0.344", at: "2026-11-18T03:52:48.947Z", result: "failed" },
  updatedAt: "2026-11-18T15:22:57.419Z",
  pendingInstall: null,
};

describe("a service whose agent holds a failed install", () => {
  it("knows the agent's two failure messages and nothing else", () => {
    expect(isFailedInstallHeld(HELD)).toBe(true);
    expect(isFailedInstallHeld(FIRST_FAILURE)).toBe(true);
    for (const other of [
      null,
      "",
      "Could not reach the release feed",
      "SpecWithCode 1.0.356 failed verification",
      "SpecWithCode 1.0.356 did not install automatically; choose Install now to retry",
      `${HELD} Extra`,
      "Installing SpecWithCode 1.0.344 is taking longer than 40 minutes; it was left to finish. See the update receipt.",
      "SpecWithCode 1.0.344 was kept after a restart check failed. The update was not confirmed. See the update receipt.",
    ]) {
      expect(isFailedInstallHeld(other)).toBe(false);
    }
  });

  it("offers Update now for the service, then the app, instead of the app alone", () => {
    expect(isServiceErrorWithRelease(held)).toBe(true);
    const view = getRestartToUpdateView(appDownloaded, held);
    expect(view).toMatchObject({
      app: true,
      appVersion: "1.0.356",
      service: true,
      serviceVersion: "1.0.356",
      label: "Update now",
    });
    expect(view?.description).toContain("SpecWithCode 1.0.356 did not install automatically.");
    // The agent's "choose Install now" names Settings' button, not this one.
    expect(view?.description).not.toContain("Install now");
    expect(view?.description).toContain(
      "The service updates first, then the app restarts on its own.",
    );
    expect(serviceInstallTarget(held, "1.0.356")).toBe("1.0.356");
  });

  it("offers it for the pass that just failed too", () => {
    const failed = { ...held, message: FIRST_FAILURE };
    expect(getRestartToUpdateView(appDownloaded, failed)).toMatchObject({
      service: true,
      label: "Update now",
    });
    expect(getRestartToUpdateView(appDownloaded, failed)?.description).toContain(FIRST_FAILURE);
  });

  it("offers Install now in Settings", () => {
    expect(resolveServiceUpdateAction(held)).toBe("install");
    expect(resolveServiceUpdateAction({ ...held, message: FIRST_FAILURE })).toBe("install");
  });

  it("still offers only a check when nothing newer is on disk or the desktop could not start the agent", () => {
    const nothingOnDisk = { ...held, downloadedVersion: null };
    expect(isServiceErrorWithRelease(nothingOnDisk)).toBe(false);
    expect(resolveServiceUpdateAction(nothingOnDisk)).toBe("check");
    const startFailed = { ...held, agentStartFailed: true };
    expect(isServiceErrorWithRelease(startFailed)).toBe(false);
    expect(getRestartToUpdateView(appDownloaded, startFailed)).toMatchObject({
      service: false,
      label: "Restart to update",
    });
    const feedFailed = { ...held, message: "Could not reach the release feed" };
    expect(resolveServiceUpdateAction(feedFailed)).toBe("check");
  });
});

describe("an app install refused because the service is behind", () => {
  const gate = (patch: Partial<DesktopAppSwapGate>): DesktopAppSwapGate => ({
    gate: "closed",
    reason: "service-behind",
    targetVersion: "1.0.356",
    serviceVersion: "1.0.338",
    serviceStatus: null,
    serviceMessage: null,
    ...patch,
  });
  const refused = (swapGate?: DesktopAppSwapGate) =>
    describeInstallOutcome({
      accepted: false,
      reason: "service-behind",
      state: { ...appDownloaded, ...(swapGate ? { swapGate } : {}) },
    }) ?? "";

  it("says why the service cannot update instead of promising it will", () => {
    const text = refused(gate({ serviceStatus: "error", serviceMessage: HELD }));
    expect(text).toContain(
      "SpecWithCode 1.0.356 installs after the SpecWithCode service on this machine updates to it. It runs 1.0.338 now.",
    );
    expect(text).toContain(
      "It cannot update yet: SpecWithCode 1.0.356 did not install automatically. Settings > General shows what it needs.",
    );
    expect(text).toContain("You can keep working on the current version.");
  });

  it("says when a waiting service installs", () => {
    expect(refused(gate({ serviceStatus: "waiting-for-quiet" }))).toContain(
      "It installs once running work finishes.",
    );
    expect(refused(gate({ serviceStatus: "installing" }))).toContain("It is installing now.");
    expect(refused(gate({ serviceStatus: "downloading" }))).toContain(
      "It is downloading the update.",
    );
  });

  it("keeps the plain sentence when main sent no gate", () => {
    expect(refused()).toBe(
      "SpecWithCode 1.0.356 installs after the SpecWithCode service on this machine updates to it. You can keep working on the current version.",
    );
  });
});
