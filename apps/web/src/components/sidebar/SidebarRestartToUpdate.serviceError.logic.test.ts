import type { DesktopUpdateState, StudioServiceUpdateState } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentOffersRelease,
  getRestartToUpdateView,
  isAgentStartFailure,
  isRestartRefusalWithRelease,
  isServiceErrorWithRelease,
  SERVICE_REQUEST_EXPIRED,
  SERVICE_UPDATE_NOW_DESCRIPTION,
  serviceInstallTarget,
} from "./SidebarRestartToUpdate.logic";

// The agent's last pass was refused for a fault Update now gets past, while it
// already has a newer release on disk: "Update now" installs that release,
// with the refusal still shown.

const LOG_DELETED =
  "SpecWithCode cannot be updated right now: The SpecWithCode service is using a database log that was deleted from disk. Restart SpecWithCode, then update";
const LOCKS_LOST =
  "SpecWithCode cannot be updated right now: The SpecWithCode service lost its SQLite locks on its database. Restart SpecWithCode, then update";

// The app already runs the release the service lacks (it updated on quit).
const appCurrent: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.63",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  productionBuild: true,
};

// The real case seen on M4.
const failed: StudioServiceUpdateState = {
  status: "error",
  identity: "m4",
  installedVersion: "1.0.62",
  availableVersion: "1.0.63",
  downloadedVersion: "1.0.63",
  // The pass checked its feed, then failed to install.
  checkedAt: "2026-10-19T10:05:00.000Z",
  quietSince: null,
  message: LOG_DELETED,
  lastInstall: { version: "1.0.62", at: "2026-10-19T10:00:00.000Z", result: "updated" },
};

const nothingNewer: StudioServiceUpdateState = {
  ...failed,
  availableVersion: null,
  downloadedVersion: null,
  message: "Could not reach the release feed",
};

describe("a service whose last update pass failed", () => {
  it("offers Update now for the release its agent has, with the failure beside it", () => {
    expect(isServiceErrorWithRelease(failed)).toBe(true);
    const view = getRestartToUpdateView(appCurrent, failed);
    expect(view).toEqual({
      app: false,
      appVersion: null,
      service: true,
      serviceVersion: "1.0.63",
      label: "Update now",
      description: [
        `${LOG_DELETED}.`,
        "The SpecWithCode service on this Mac still runs 1.0.62; this installs 1.0.63.",
        SERVICE_UPDATE_NOW_DESCRIPTION,
      ].join(" "),
    });
  });

  it("offers it whatever the app runs", () => {
    const devApp = { ...appCurrent, currentVersion: "1.0.64-dev.2", productionBuild: false };
    for (const app of [null, devApp]) {
      expect(getRestartToUpdateView(app, failed)).toMatchObject({
        service: true,
        serviceVersion: "1.0.63",
      });
    }
  });

  it("offers it for both refusals a held request gets past, whatever the agent's check time", () => {
    // update.py restarts the service for a held forced request when it lost
    // its SQLite locks too, and the refusal says nothing of the last check.
    for (const message of [LOG_DELETED, LOCKS_LOST]) {
      for (const checkedAt of [failed.checkedAt, null]) {
        const refused = { ...failed, message, checkedAt };
        expect(isServiceErrorWithRelease(refused)).toBe(true);
        expect(getRestartToUpdateView(appCurrent, refused)?.description).toBe(
          [
            `${message}.`,
            "The SpecWithCode service on this Mac still runs 1.0.62; this installs 1.0.63.",
            SERVICE_UPDATE_NOW_DESCRIPTION,
          ].join(" "),
        );
      }
    }
  });

  it("installs the newest of the agent's release and the app's versions", () => {
    expect(serviceInstallTarget(failed)).toBe("1.0.63");
    expect(serviceInstallTarget(failed, "1.0.64")).toBe("1.0.64");
    expect(serviceInstallTarget(failed, "1.0.62", "1.0.61")).toBe("1.0.63");
    const appNewer = { ...appCurrent, currentVersion: "1.0.62", downloadedVersion: "1.0.64" };
    expect(
      getRestartToUpdateView(
        { ...appNewer, status: "downloaded", availableVersion: "1.0.64" },
        failed,
      ),
    ).toMatchObject({
      app: true,
      appVersion: "1.0.64",
      service: true,
      serviceVersion: "1.0.64",
      label: "Update now",
    });
  });

  it("is not offered again for the version this window already asked for", () => {
    expect(
      getRestartToUpdateView(appCurrent, failed, { serviceRequestedVersion: "1.0.63" }),
    ).toBeNull();
  });

  it("offers nothing for the service when its agent has nothing newer", () => {
    expect(isServiceErrorWithRelease(nothingNewer)).toBe(false);
    expect(
      isServiceErrorWithRelease({ ...failed, downloadedVersion: "1.0.62", availableVersion: null }),
    ).toBe(false);
    expect(getRestartToUpdateView(appCurrent, nothingNewer)).toBeNull();
    expect(serviceInstallTarget(nothingNewer, "1.0.63")).toBeNull();
    // The app's own downloaded update still restarts the app alone.
    const appDownloaded: DesktopUpdateState = {
      ...appCurrent,
      currentVersion: "1.0.62",
      status: "downloaded",
      availableVersion: "1.0.63",
      downloadedVersion: "1.0.63",
    };
    expect(getRestartToUpdateView(appDownloaded, nothingNewer)).toMatchObject({
      app: true,
      service: false,
      label: "Restart to update",
    });
  });

  // Failures a forced request cannot get past, and one with nothing on disk.
  const cannotGetPast: Array<[string, StudioServiceUpdateState]> = [
    // The pass failed its check: the agent checks on every pass and fails
    // again before it takes a request.
    [
      "a failed check",
      { ...failed, checkedAt: null, message: "GitHub release lookup failed (HTTP 403)" },
    ],
    // The agent rejected its download: until its next check every pass, a
    // forced one too, fails at once without fetching it again.
    [
      "a rejected download",
      {
        ...failed,
        availableVersion: "1.0.63",
        downloadedVersion: null,
        message: "Runtime archive checksum does not match the release",
      },
    ],
    // A refusal Update now gets past, but nothing is on disk to install.
    [
      "a release only its feed offers",
      { ...failed, availableVersion: "1.0.63", downloadedVersion: null },
    ],
    // Another refusal, with the release on disk: no restart gets past it.
    [
      "a service that does not match its installation",
      {
        ...failed,
        message:
          "SpecWithCode cannot be updated right now: the service does not match its installation",
      },
    ],
    // The desktop could not start the agent at all, and flags it whatever the words.
    ["a flagged failure to start the agent", { ...failed, agentStartFailed: true }],
  ];

  it.each(cannotGetPast)("offers only the app's own restart beside %s", (_name, serviceState) => {
    const appDownloaded: DesktopUpdateState = {
      ...appCurrent,
      currentVersion: "1.0.62",
      status: "downloaded",
      availableVersion: "1.0.63",
      downloadedVersion: "1.0.63",
    };
    expect(isServiceErrorWithRelease(serviceState)).toBe(false);
    expect(agentOffersRelease(serviceState, "1.0.63")).toBe(false);
    expect(serviceInstallTarget(serviceState, "1.0.63")).toBeNull();
    expect(getRestartToUpdateView(appCurrent, serviceState)).toBeNull();
    expect(getRestartToUpdateView(appDownloaded, serviceState)).toMatchObject({
      app: true,
      service: false,
      label: "Restart to update",
    });
  });

  it("offers it once the desktop says the failure is not its own", () => {
    expect(isServiceErrorWithRelease({ ...failed, agentStartFailed: false })).toBe(true);
  });

  it("tells the desktop's own failure to start the agent from the agent's by its flag", () => {
    // The desktop this renderer ships with flags every state it reports: its
    // words without the flag are no failure of its own.
    const words =
      "launchctl could not start the update agent: exit 5 (refreshing it failed too: no python3)";
    expect(isAgentStartFailure({ ...failed, message: words, agentStartFailed: true })).toBe(true);
    expect(isAgentStartFailure({ ...failed, message: words, agentStartFailed: false })).toBe(false);
    expect(isAgentStartFailure({ ...failed, message: words })).toBe(false);
    expect(isAgentStartFailure(failed)).toBe(false);
    expect(isAgentStartFailure({ ...failed, agentStartFailed: true })).toBe(true);
  });

  it("is told apart from other failures and statuses", () => {
    expect(isServiceErrorWithRelease(null)).toBe(false);
    expect(isServiceErrorWithRelease({ ...failed, status: "manual-required" })).toBe(false);
    expect(isServiceErrorWithRelease({ ...failed, status: "installing" })).toBe(false);
    // A service on a dev build is never older than a release.
    expect(isServiceErrorWithRelease({ ...failed, installedVersion: "1.0.63-dev.1" })).toBe(false);
  });
});

describe("a service whose install request lapsed before it could start", () => {
  const lapsed: StudioServiceUpdateState = { ...failed, message: SERVICE_REQUEST_EXPIRED };

  it("offers Update now again for the release its agent has, with the agent's words beside it", () => {
    expect(isServiceErrorWithRelease(lapsed)).toBe(true);
    const view = getRestartToUpdateView(appCurrent, lapsed);
    expect(view).toMatchObject({ service: true, serviceVersion: "1.0.63", label: "Update now" });
    // Its words already end in a period: shown with one.
    expect(view?.description).toBe(
      [
        SERVICE_REQUEST_EXPIRED,
        "The SpecWithCode service on this Mac still runs 1.0.62; this installs 1.0.63.",
        SERVICE_UPDATE_NOW_DESCRIPTION,
      ].join(" "),
    );
    expect(serviceInstallTarget(lapsed, "1.0.63")).toBe("1.0.63");
  });

  it("offers only a check with nothing on disk, or when the desktop could not start the agent", () => {
    expect(isServiceErrorWithRelease({ ...lapsed, downloadedVersion: null })).toBe(false);
    expect(isServiceErrorWithRelease({ ...lapsed, agentStartFailed: true })).toBe(false);
    expect(getRestartToUpdateView(appCurrent, { ...lapsed, downloadedVersion: null })).toBeNull();
  });

  it("is no refusal that only a held request gets past", () => {
    expect(isRestartRefusalWithRelease(lapsed)).toBe(false);
    expect(isRestartRefusalWithRelease(failed)).toBe(true);
    expect(isRestartRefusalWithRelease({ ...failed, message: LOCKS_LOST })).toBe(true);
    expect(isRestartRefusalWithRelease({ ...failed, downloadedVersion: null })).toBe(false);
    expect(isRestartRefusalWithRelease(null)).toBe(false);
  });
});
