import type {
  DesktopUpdateState,
  ServiceUpdateBlocker,
  StudioServiceUpdateState,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceServiceUpdateProgress,
  canRetryServiceUpdate,
  INSTALL_TIMEOUT_MS,
  describeServiceUpdateBlockers,
  describeAppRestartWarning,
  describeServiceUpdateStop,
  isStaleServiceAnswer,
  retryServiceUpdateProgress,
  SERVICE_UPDATE_NOW_DESCRIPTION,
  serviceFailureKey,
  serviceUpdateButtonLabel,
  STALE_FAILURE_MS,
  serviceUpdateToast,
  startServiceUpdateProgress,
  describeInstallOutcome,
  getRestartToUpdateView,
  isAppUpdateReady,
  isServiceUpdateReady,
  canPressUpdateAgain,
  formatElapsed,
  isForcedRequestLive,
  isOlderRelease,
  isServiceBehindApp,
  pendingHoldUntil,
  serviceInstallTarget,
} from "./SidebarRestartToUpdate.logic";

const appIdle: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.2.4",
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
};

const appDownloaded: DesktopUpdateState = {
  ...appIdle,
  status: "downloaded",
  availableVersion: "0.2.5",
  downloadedVersion: "0.2.5",
};

const serviceUpToDate: StudioServiceUpdateState = {
  status: "up-to-date",
  identity: "m4",
  installedVersion: "0.2.4",
  availableVersion: null,
  downloadedVersion: null,
  checkedAt: null,
  quietSince: null,
  message: null,
  lastInstall: null,
};

const serviceWaiting: StudioServiceUpdateState = {
  ...serviceUpToDate,
  status: "waiting-for-quiet",
  availableVersion: "0.2.5",
  downloadedVersion: "0.2.5",
};

describe("restart to update", () => {
  it("stays hidden until an update has downloaded", () => {
    expect(getRestartToUpdateView(null, null)).toBeNull();
    expect(getRestartToUpdateView(appIdle, serviceUpToDate)).toBeNull();
    expect(
      getRestartToUpdateView({ ...appIdle, status: "available", availableVersion: "0.2.5" }, null),
    ).toBeNull();
    expect(
      getRestartToUpdateView(
        { ...appIdle, status: "downloading", availableVersion: "0.2.5", downloadPercent: 40 },
        { ...serviceUpToDate, status: "downloading", availableVersion: "0.2.5" },
      ),
    ).toBeNull();
  });

  it("restarts the app for a downloaded app update", () => {
    // The service already runs the release the app installs, or no agent reports on it.
    for (const service of [{ ...serviceUpToDate, installedVersion: "0.2.5" }, null]) {
      const view = getRestartToUpdateView(appDownloaded, service);
      expect(view).toMatchObject({
        app: true,
        service: false,
        serviceVersion: null,
        label: "Restart to update",
      });
      expect(view?.description).toContain("SpecWithCode 0.2.5 is downloaded.");
      expect(view?.description).toContain("Restarts the app to install it.");
    }
  });

  it("updates a service that runs an older release together with the app", () => {
    // The agent has not looked for 0.2.5 yet: one press still updates both.
    for (const status of ["up-to-date", "available", "downloading", "disabled"] as const) {
      const view = getRestartToUpdateView(appDownloaded, { ...serviceUpToDate, status });
      expect(view).toMatchObject({
        app: true,
        service: true,
        serviceVersion: "0.2.5",
        label: "Update now",
      });
      expect(view?.description).toContain(
        "The service updates first, then the app restarts on its own.",
      );
    }
    // Busy or failed agents and unmanaged services are left to the app restart.
    for (const status of ["installing", "error", "manual-required", "not-managed"] as const) {
      expect(getRestartToUpdateView(appDownloaded, { ...serviceUpToDate, status })).toMatchObject({
        service: false,
      });
    }
    // A dev build of the service is never replaced by a release.
    expect(
      getRestartToUpdateView(appDownloaded, {
        ...serviceUpToDate,
        installedVersion: "0.2.4-dev.3",
      }),
    ).toMatchObject({ service: false });
  });

  it("offers to update a waiting service now", () => {
    const view = getRestartToUpdateView(appIdle, serviceWaiting);
    expect(view).toMatchObject({ app: false, service: true, label: "Update now" });
    expect(view?.description).toContain(SERVICE_UPDATE_NOW_DESCRIPTION);
    expect(SERVICE_UPDATE_NOW_DESCRIPTION).toBe(
      "Stops running work, closes terminals and restarts SpecWithCode. You can continue interrupted tasks afterwards.",
    );
    expect(
      getRestartToUpdateView(appIdle, { ...serviceWaiting, status: "downloaded" })?.label,
    ).toBe("Update now");
  });

  it("does both when the app and the service each have an update", () => {
    const view = getRestartToUpdateView(appDownloaded, {
      ...serviceWaiting,
      status: "downloaded",
    });
    expect(view).toMatchObject({
      app: true,
      appVersion: "0.2.5",
      service: true,
      serviceVersion: "0.2.5",
      label: "Update now",
    });
    expect(view?.description).toContain(SERVICE_UPDATE_NOW_DESCRIPTION);
    expect(view?.description).toContain(
      "The service updates first, then the app restarts on its own.",
    );
  });

  it("lets the service catch up with the version the app already runs", () => {
    // The app updated on its own (as on quit); the service still runs 0.2.4.
    const appUpdated = { ...appIdle, currentVersion: "0.2.5" };
    const view = getRestartToUpdateView(appUpdated, serviceUpToDate);
    expect(view).toMatchObject({
      app: false,
      appVersion: null,
      service: true,
      serviceVersion: "0.2.5",
      label: "Update now",
    });
    expect(view?.description).toContain(
      "The SpecWithCode service on this Mac still runs 0.2.4; this installs 0.2.5.",
    );
    expect(view?.description).not.toContain("is downloaded");
    // The same release on both: nothing to offer.
    expect(
      getRestartToUpdateView(appUpdated, { ...serviceUpToDate, installedVersion: "0.2.5" }),
    ).toBeNull();
    // A newer app download wins over the running version.
    expect(
      getRestartToUpdateView(
        {
          ...appDownloaded,
          currentVersion: "0.2.5",
          availableVersion: "0.2.6",
          downloadedVersion: "0.2.6",
        },
        serviceUpToDate,
      ),
    ).toMatchObject({ app: true, service: true, serviceVersion: "0.2.6" });
    expect(serviceInstallTarget(serviceUpToDate, null, "0.2.5", undefined)).toBe("0.2.5");
  });

  it("installs the newer of the agent's release and the app's on the service", () => {
    // The agent found 0.2.6 while the app still has 0.2.5 on disk.
    const newerAgent = { ...serviceWaiting, availableVersion: "0.2.6", downloadedVersion: "0.2.6" };
    expect(serviceInstallTarget(newerAgent, "0.2.5")).toBe("0.2.6");
    // The agent still offers 0.2.5 while the app has 0.2.6.
    expect(serviceInstallTarget(serviceWaiting, "0.2.6")).toBe("0.2.6");
    // Only the agent has a release: the app has nothing downloaded.
    expect(serviceInstallTarget(serviceWaiting, null)).toBe("0.2.5");
    // Nothing for the service: it runs the app's release and the agent offers nothing.
    expect(serviceInstallTarget({ ...serviceUpToDate, installedVersion: "0.2.5" }, "0.2.5")).toBe(
      null,
    );
    expect(serviceInstallTarget(null, "0.2.5")).toBe(null);
  });

  it("compares releases only, never dev builds", () => {
    expect(isOlderRelease("0.2.4", "0.2.5")).toBe(true);
    expect(isOlderRelease("0.2.10", "0.2.9")).toBe(false);
    expect(isOlderRelease("0.2.5", "0.2.5")).toBe(false);
    expect(isOlderRelease("0.2.4-dev.1", "0.2.5")).toBe(false);
    expect(isOlderRelease("0.2.4", "0.2.5-beta.1")).toBe(false);
    expect(isOlderRelease(null, "0.2.5")).toBe(false);
    expect(isOlderRelease("0.2.4", null)).toBe(false);
    expect(isServiceBehindApp(serviceUpToDate, "0.2.5")).toBe(true);
    expect(isServiceBehindApp({ ...serviceUpToDate, status: "installing" }, "0.2.5")).toBe(false);
    expect(isServiceBehindApp(serviceUpToDate, null)).toBe(false);
  });

  it("offers a retry with the reason after a failed install", () => {
    // What recoverFailedInstall leaves behind: still downloaded, install context.
    const view = getRestartToUpdateView(
      {
        ...appDownloaded,
        status: "downloaded",
        errorContext: "install",
        message: "Move SpecWeave Studio to Applications first.",
      },
      null,
    );
    expect(view).toMatchObject({ app: true, label: "Retry update" });
    expect(view?.description).toMatch(
      /^The last install failed: Move SpecWeave Studio to Applications first\./,
    );
  });

  it("stays visible while a background check runs", () => {
    const checking = { ...appDownloaded, status: "checking" as const };
    expect(isAppUpdateReady(checking)).toBe(true);
    expect(getRestartToUpdateView(checking, null)).toMatchObject({
      app: true,
      appVersion: "0.2.5",
    });
    expect(isAppUpdateReady({ ...appIdle, status: "checking" })).toBe(false);
  });

  it("mentions install on quit only when it is on", () => {
    expect(
      getRestartToUpdateView(appDownloaded, null, { installOnQuit: true })?.description,
    ).toContain("it installs the next time you quit");
    expect(getRestartToUpdateView(appDownloaded, null)?.description).not.toContain("quit");
    expect(
      getRestartToUpdateView(appIdle, serviceWaiting, { installOnQuit: true })?.description,
    ).not.toContain("quit");
  });

  it("stops offering a service update this window already started", () => {
    const requested = { serviceRequestedVersion: "0.2.5" };
    expect(getRestartToUpdateView(appIdle, serviceWaiting, requested)).toBeNull();
    expect(getRestartToUpdateView(appDownloaded, serviceWaiting, requested)).toMatchObject({
      app: true,
      service: false,
    });
    expect(
      getRestartToUpdateView(appIdle, { ...serviceWaiting, downloadedVersion: "0.2.6" }, requested),
    ).toMatchObject({ service: true });
  });

  it("explains install outcomes", () => {
    const base = { state: appDownloaded };
    expect(describeInstallOutcome({ ...base, accepted: true, failed: false })).toBeNull();
    expect(describeInstallOutcome({ ...base, accepted: false, reason: "quitting" })).toContain(
      "quit and reopen",
    );
    expect(
      describeInstallOutcome({
        accepted: true,
        failed: true,
        state: { ...appDownloaded, message: "swap failed" },
      }),
    ).toBe("swap failed");
    expect(describeInstallOutcome({ ...base, accepted: false, reason: "no-download" })).toContain(
      "Download it from Settings",
    );
    expect(
      describeInstallOutcome(
        { ...base, accepted: false, reason: "no-download" },
        { downloadsInBackground: true },
      ),
    ).toContain("fetching it now");
    expect(
      describeInstallOutcome({
        accepted: false,
        reason: "no-download",
        state: { ...appDownloaded, status: "downloading" },
      }),
    ).toContain("fetching it now");
    expect(describeInstallOutcome({ ...base, accepted: false, reason: "disabled" })).toContain(
      "off in this build",
    );
    // A busy updater is named, never "try again".
    expect(describeInstallOutcome({ ...base, accepted: false, reason: "busy" })).toContain(
      "stayed busy",
    );
    expect(
      describeInstallOutcome({
        accepted: false,
        reason: "busy",
        state: {
          ...appDownloaded,
          status: "downloading",
          availableVersion: "1.0.33",
          downloadPercent: 41,
        },
      }),
    ).toBe("SpecWithCode is still downloading 1.0.33 (41%). Restart to update once it finishes.");
  });

  it("treats only on-disk service releases as ready", () => {
    expect(isServiceUpdateReady(serviceWaiting)).toBe(true);
    expect(isServiceUpdateReady({ ...serviceWaiting, status: "downloaded" })).toBe(true);
    expect(isServiceUpdateReady({ ...serviceWaiting, status: "available" })).toBe(false);
    expect(isServiceUpdateReady({ ...serviceWaiting, status: "installing" })).toBe(false);
    expect(isServiceUpdateReady(null)).toBe(false);
  });

  it("offers Update now while the agent restarts a service that lost its database locks", () => {
    // M4, 2026-10-19: the agent reported an error forever and only an app restart was offered.
    const recovering: StudioServiceUpdateState = {
      ...serviceWaiting,
      message: "Restarting SpecWithCode to recover its database",
    };
    expect(isServiceUpdateReady(recovering)).toBe(true);
    expect(getRestartToUpdateView(appIdle, recovering)).toMatchObject({
      app: false,
      service: true,
      label: "Update now",
    });
    const waiting = advanceServiceUpdateProgress(
      { ...startServiceUpdateProgress(recovering), phase: "requesting" },
      recovering,
    );
    expect(serviceUpdateToast(waiting, false).description).toBe(
      `The SpecWithCode service on this Mac still runs ${recovering.installedVersion}. Restarting SpecWithCode to recover its database`,
    );
  });

  it("offers nothing when the service already runs the downloaded version", () => {
    const same: StudioServiceUpdateState = { ...serviceWaiting, installedVersion: "0.2.5" };
    expect(isServiceUpdateReady(same)).toBe(false);
    expect(getRestartToUpdateView(appIdle, same)).toBeNull();
    expect(isServiceUpdateReady({ ...same, status: "downloaded" })).toBe(false);
  });
});

describe("service update skew (M4, October 19, 2026: About said 1.0.58 while the toast waited)", () => {
  const skewed: StudioServiceUpdateState = {
    ...serviceWaiting,
    installedVersion: "0.2.1",
    message: "Waiting for running tasks, queued messages and open questions to finish (attempt 1)",
  };

  it("names the version the service still runs while it waits for a newer one", () => {
    const start = startServiceUpdateProgress(skewed);
    expect(start).toMatchObject({ targetVersion: "0.2.5", fromVersion: "0.2.1" });
    const waiting = advanceServiceUpdateProgress({ ...start, phase: "requesting" }, skewed);
    const toast = serviceUpdateToast(waiting, true);
    expect(toast.title).toBe("Waiting to install SpecWithCode 0.2.5");
    expect(toast.description).toBe(
      `The SpecWithCode service on this Mac still runs 0.2.1. ${skewed.message}`,
    );
    expect(toast.action).toBe("update-now");
  });

  it("ends the wait when the service reports the target even without an installed status", () => {
    const waiting = advanceServiceUpdateProgress(
      { ...startServiceUpdateProgress(skewed), phase: "requesting" },
      skewed,
    );
    for (const status of ["waiting-for-quiet", "downloaded", "available"] as const) {
      const late = advanceServiceUpdateProgress(waiting, {
        ...skewed,
        status,
        installedVersion: "0.2.5",
      });
      expect(late.phase).toBe("restarting");
      expect(serviceUpdateToast(late, false).type).toBe("success");
    }
  });

  it("keeps installing until the agent finishes, even if the version already changed", () => {
    const installing = advanceServiceUpdateProgress(
      { ...startServiceUpdateProgress(skewed), phase: "requesting" },
      { ...skewed, status: "installing", installedVersion: "0.2.5" },
    );
    expect(installing.phase).toBe("installing");
  });

  it("follows the running version when a newer release is found during the wait", () => {
    const waiting = advanceServiceUpdateProgress(
      { ...startServiceUpdateProgress(skewed), phase: "requesting" },
      skewed,
    );
    const moved = advanceServiceUpdateProgress(waiting, { ...skewed, installedVersion: "0.2.3" });
    expect(moved).toMatchObject({ phase: "waiting", fromVersion: "0.2.3", targetVersion: "0.2.5" });
    expect(serviceUpdateToast(moved, false).description).toContain("still runs 0.2.3");
  });

  it("does not name a running version that equals the target", () => {
    const progress = {
      ...startServiceUpdateProgress(serviceWaiting),
      phase: "waiting" as const,
      fromVersion: "0.2.5",
      message: "Waiting",
    };
    expect(serviceUpdateToast(progress, false).description).toBe("Waiting");
  });
});

describe("service update progress", () => {
  const requested = { ...startServiceUpdateProgress(serviceWaiting), phase: "requesting" as const };

  it("targets the downloaded version and starts by stopping work", () => {
    expect(startServiceUpdateProgress(serviceWaiting)).toMatchObject({
      phase: "stopping",
      targetVersion: serviceWaiting.downloadedVersion,
    });
  });

  it("retries a failed request for the version the agent offers now", () => {
    const failed = { ...requested, phase: "failed" as const, message: "0.2.5 was asked for" };
    const newer = {
      ...serviceWaiting,
      status: "error" as const,
      availableVersion: "0.2.6",
      downloadedVersion: null,
    };
    expect(retryServiceUpdateProgress(failed, newer)).toMatchObject({
      phase: "stopping",
      targetVersion: "0.2.6",
      message: null,
      blockers: [],
    });
    expect(retryServiceUpdateProgress(failed, null).targetVersion).toBe("0.2.5");
    // Asking again while waiting keeps the version this request named.
    const waiting = { ...requested, phase: "waiting" as const };
    expect(retryServiceUpdateProgress(waiting, newer).targetVersion).toBe("0.2.5");
  });

  it("follows the agent from waiting to installing to the new version", () => {
    const waiting = advanceServiceUpdateProgress(requested, {
      ...serviceWaiting,
      message: "Waiting",
    });
    expect(waiting).toMatchObject({ phase: "waiting", message: "Waiting" });
    const installing = advanceServiceUpdateProgress(waiting, {
      ...serviceWaiting,
      status: "installing",
    });
    expect(installing.phase).toBe("installing");
    const done = advanceServiceUpdateProgress(installing, {
      ...serviceWaiting,
      status: "installed",
      installedVersion: requested.targetVersion,
    });
    expect(done.phase).toBe("restarting");
    // Once restarting, a later read cannot move it back.
    expect(advanceServiceUpdateProgress(done, serviceWaiting)).toBe(done);
  });

  it.each(["error", "manual-required"] as const)(
    "keeps a verified installation successful when the next check reports %s",
    (status) => {
      const progress = { ...requested, requestedAt: 1_000 };
      const completed = {
        ...serviceWaiting,
        status,
        installedVersion: progress.targetVersion,
        availableVersion: null,
        downloadedVersion: null,
        updatedAt: new Date(3_000).toISOString(),
        message: "Release discovery failed",
        lastInstall: {
          version: "0.2.5",
          result: "updated" as const,
          at: new Date(2_000).toISOString(),
        },
      };
      const done = advanceServiceUpdateProgress(progress, completed, 3_000);
      expect(done).toMatchObject({ phase: "restarting", message: completed.message });
      expect(serviceUpdateToast(done, false)).toMatchObject({
        type: "success",
        title: "Updated to SpecWithCode 0.2.5",
        action: null,
      });
      expect(serviceUpdateToast(done, false).description).toContain(completed.message);
      expect(canRetryServiceUpdate(done)).toBe(false);
      expect(advanceServiceUpdateProgress(done, completed, 4_000)).toBe(done);
    },
  );

  it("does not turn missing, stale, invalid, future, failed or mismatched receipts into success", () => {
    const completed = {
      ...serviceWaiting,
      status: "error" as const,
      installedVersion: "0.2.5",
      updatedAt: new Date(3_000).toISOString(),
      message: "Verification failed",
      lastInstall: {
        version: "0.2.5",
        result: "updated" as const,
        at: new Date(2_000).toISOString(),
      },
    };
    const progress = { ...requested, requestedAt: 1_000 };
    const invalid = [
      { ...completed, lastInstall: null },
      { ...completed, installedVersion: "0.2.4" },
      { ...completed, lastInstall: { ...completed.lastInstall, result: "failed" as const } },
      { ...completed, lastInstall: { ...completed.lastInstall, version: "0.2.6" } },
      ...["invalid", new Date(999).toISOString(), new Date(4_000).toISOString()].map((at) => ({
        ...completed,
        lastInstall: { ...completed.lastInstall, at },
      })),
      { ...completed, updatedAt: new Date(1_500).toISOString() },
    ];
    for (const state of invalid) {
      expect(advanceServiceUpdateProgress(progress, state, 3_000).phase).toBe("failed");
    }
  });

  it("requires a new successful receipt when following an update started in another window", () => {
    const prior = { version: "0.2.5", result: "updated" as const, at: new Date(500).toISOString() };
    const adopted = {
      ...startServiceUpdateProgress({ ...serviceWaiting, lastInstall: prior }),
      phase: "requesting" as const,
    };
    const state = {
      ...serviceWaiting,
      installedVersion: "0.2.5",
      status: "error" as const,
      updatedAt: new Date(3_000).toISOString(),
      lastInstall: prior,
    };
    expect(advanceServiceUpdateProgress(adopted, state, 3_000).phase).toBe("failed");
    expect(
      advanceServiceUpdateProgress(
        adopted,
        { ...state, lastInstall: { ...prior, at: new Date(2_000).toISOString() } },
        3_000,
      ).phase,
    ).toBe("restarting");
  });

  it("reports an install that was rolled back or never finishes", () => {
    const installing = advanceServiceUpdateProgress(
      requested,
      { ...serviceWaiting, status: "installing" },
      1_000,
    );
    expect(installing).toMatchObject({ phase: "installing", installingSince: 1_000 });
    // Back to the old version without an error of its own: rolled back.
    expect(
      advanceServiceUpdateProgress(installing, {
        ...serviceWaiting,
        status: "up-to-date",
        installedVersion: "0.2.1",
      }),
    ).toMatchObject({
      phase: "failed",
      message: "The update was rolled back; SpecWithCode stayed on 0.2.1.",
    });
    // Before installing, the same state is only the agent not having run yet.
    expect(
      advanceServiceUpdateProgress(requested, { ...serviceWaiting, status: "up-to-date" }),
    ).toBe(requested);
    const still = { ...serviceWaiting, status: "installing" as const };
    expect(advanceServiceUpdateProgress(installing, still, 1_000 + 60_000).phase).toBe(
      "installing",
    );
    const stuck = advanceServiceUpdateProgress(installing, still, 1_000 + INSTALL_TIMEOUT_MS);
    expect(stuck.phase).toBe("failed");
    expect(canRetryServiceUpdate(stuck)).toBe(true);
  });

  it("keeps waiting for the agent to pick the request up", () => {
    expect(
      advanceServiceUpdateProgress(requested, { ...serviceWaiting, status: "downloaded" }),
    ).toBe(requested);
    expect(advanceServiceUpdateProgress(requested, null)).toBe(requested);
  });

  it("fails with the agent's message, or when it installed another version", () => {
    expect(
      advanceServiceUpdateProgress(requested, {
        ...serviceWaiting,
        status: "error",
        message: "No disk",
      }),
    ).toMatchObject({ phase: "failed", message: "No disk" });
    expect(
      advanceServiceUpdateProgress(requested, {
        ...serviceWaiting,
        status: "installed",
        installedVersion: "0.0.1",
      }),
    ).toMatchObject({ phase: "failed", message: "SpecWithCode stayed on 0.0.1." });
  });

  it("names what still runs, most important first, and always offers to update now", () => {
    const blockers = [
      {
        kind: "run",
        count: 1,
        threadId: "t1",
        threadTitle: "Fix login",
        projectId: "p",
        projectTitle: "EasyChamp",
      },
      {
        kind: "queued",
        count: 2,
        threadId: "t1",
        threadTitle: "Fix login",
        projectId: "p",
        projectTitle: null,
      },
      {
        kind: "session",
        count: 1,
        threadId: null,
        threadTitle: null,
        projectId: null,
        projectTitle: null,
      },
      {
        kind: "effect",
        count: 3,
        threadId: null,
        threadTitle: null,
        projectId: null,
        projectTitle: null,
      },
    ] as unknown as ReadonlyArray<ServiceUpdateBlocker>;
    expect(describeServiceUpdateBlockers(blockers)).toBe(
      "Still running: 1 running task in “Fix login” (EasyChamp); 2 queued messages in “Fix login”; " +
        "1 agent process still working; and 1 more.",
    );
    const waiting = { ...requested, phase: "waiting" as const, blockers };
    expect(serviceUpdateToast(waiting, false)).toMatchObject({
      type: "loading",
      description: expect.stringContaining("Still running: 1 running task"),
      action: "update-now",
      cancel: true,
    });
    // Waiting long only changes the tone.
    expect(serviceUpdateToast(waiting, true)).toMatchObject({
      type: "warning",
      action: "update-now",
      cancel: true,
    });
  });

  it("offers Update now and Cancel while waiting with nothing the server knows of", () => {
    const waiting = {
      ...requested,
      phase: "waiting" as const,
      message: "Waiting for open SpecWithCode terminals and agent processes to close",
    };
    expect(serviceUpdateToast(waiting, false)).toEqual({
      type: "loading",
      title: "Preparing to install SpecWithCode 0.2.5",
      description:
        "The SpecWithCode service on this Mac still runs 0.2.4. Waiting for open SpecWithCode terminals and agent processes to close",
      action: "update-now",
      cancel: true,
    });
    expect(serviceUpdateToast({ ...waiting, message: null }, false).description).toBe(
      "The SpecWithCode service on this Mac still runs 0.2.4. Waiting for the last work to finish…",
    );
    expect(serviceUpdateToast(requested, false)).toMatchObject({
      description:
        "The SpecWithCode service on this Mac still runs 0.2.4. Asking the update agent to install it…",
      action: "update-now",
      cancel: true,
    });
    expect(serviceUpdateToast({ ...requested, phase: "stopping" }, true)).toMatchObject({
      description: "Stopping running tasks and cancelling queued messages…",
      action: null,
      cancel: false,
    });
    expect(serviceUpdateToast({ ...requested, phase: "failed" }, false)).toMatchObject({
      action: "retry",
      cancel: false,
    });
  });

  it("lets every phase but installing and restarting be clicked again", () => {
    const phases = ["stopping", "requesting", "waiting", "installing", "restarting", "failed"];
    expect(
      phases.map((phase) =>
        canRetryServiceUpdate({ ...requested, phase: phase as typeof requested.phase }),
      ),
    ).toEqual([false, true, true, false, false, true]);
    expect(serviceUpdateButtonLabel(requested)).toBe("Update now");
    expect(serviceUpdateButtonLabel({ ...requested, phase: "waiting" })).toBe("Update now");
    expect(serviceUpdateButtonLabel({ ...requested, phase: "stopping" })).toBe("Stopping tasks…");
  });

  it("does not stop the work again while a forced request is live", () => {
    const at = 1_000_000;
    const forced = { ...requested, startedAt: at, holdUntil: at + 15 * 60_000 };
    for (const phase of ["requesting", "waiting"] as const) {
      expect(isForcedRequestLive({ ...forced, phase }, at + 60_000)).toBe(true);
      expect(canPressUpdateAgain({ ...forced, phase }, at + 60_000)).toBe(false);
      expect(serviceUpdateButtonLabel({ ...forced, phase }, at + 60_000)).toBe("Updating…");
      // Once the hold ends the agent stops retrying, so pressing again asks again.
      expect(canPressUpdateAgain({ ...forced, phase }, at + 15 * 60_000)).toBe(true);
      expect(serviceUpdateButtonLabel({ ...forced, phase }, at + 15 * 60_000)).toBe("Update now");
    }
    // A failed attempt is always retried; installing and restarting never are.
    expect(canPressUpdateAgain({ ...forced, phase: "failed" }, at)).toBe(true);
    expect(canPressUpdateAgain({ ...forced, phase: "installing" }, at)).toBe(false);
    // Without a hold (an older desktop or an adopted request) it can be pressed again.
    expect(canPressUpdateAgain(requested, at)).toBe(true);
  });

  it("offers only Cancel while a forced request is live, and names the time", () => {
    const at = 1_000_000;
    const forced = { ...requested, startedAt: at, holdUntil: at + 15 * 60_000 };
    expect(serviceUpdateToast(forced, false, { now: at + 67_000 })).toEqual({
      type: "loading",
      title: "Updating to SpecWithCode 0.2.5 · 1:07",
      description:
        "The SpecWithCode service on this Mac still runs 0.2.4. Checking that nothing is running, then installing…",
      action: null,
      cancel: true,
    });
    // The agent's own check is not a wait, however long it takes.
    expect(serviceUpdateToast(forced, true, { now: at + 67_000 })).toMatchObject({
      type: "loading",
      title: "Updating to SpecWithCode 0.2.5 · 1:07",
    });
    // Work that keeps running is.
    expect(
      serviceUpdateToast({ ...forced, phase: "waiting" }, true, { now: at + 67_000 }),
    ).toMatchObject({
      type: "warning",
      title: "Waiting to install SpecWithCode 0.2.5 · 1:07",
      action: null,
      cancel: true,
    });
    // After the hold the agent stops retrying: Update now comes back.
    expect(serviceUpdateToast(forced, false, { now: at + 15 * 60_000 })).toMatchObject({
      title: "Preparing to install SpecWithCode 0.2.5 · 15:00",
      action: "update-now",
      cancel: true,
    });
  });

  it("counts the time through stopping and installing, and reports it when done", () => {
    const at = 1_000_000;
    const started = { ...requested, startedAt: at };
    expect(
      serviceUpdateToast({ ...started, phase: "stopping" }, false, { now: at + 4_000 }),
    ).toMatchObject({
      title: "Updating to SpecWithCode 0.2.5 · 0:04",
    });
    expect(
      serviceUpdateToast({ ...started, phase: "installing" }, false, { now: at + 125_000 }),
    ).toMatchObject({ title: "Installing SpecWithCode 0.2.5 · 2:05" });
    expect(
      serviceUpdateToast({ ...started, phase: "restarting" }, false, { now: at + 150_000 }),
    ).toMatchObject({
      type: "success",
      title: "Updated to SpecWithCode 0.2.5 in 2:30",
      description: "Reloading this window…",
    });
    // When the app installs its own update next, the window does not reload.
    expect(
      serviceUpdateToast({ ...started, phase: "restarting" }, false, {
        now: at + 150_000,
        appFollows: true,
      }),
    ).toMatchObject({
      type: "success",
      title: "Updated the service to SpecWithCode 0.2.5 in 2:30",
      description: "Restarting the app to finish the update…",
    });
    // No press time (an adopted update): no clock.
    expect(
      serviceUpdateToast({ ...requested, phase: "installing" }, false, { now: at }),
    ).toMatchObject({
      title: "Installing SpecWithCode 0.2.5",
    });
  });

  it("formats the elapsed time as minutes and seconds", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(-5_000)).toBe("0:00");
    expect(formatElapsed(59_999)).toBe("0:59");
    expect(formatElapsed(61_000)).toBe("1:01");
    expect(formatElapsed(3_599_000)).toBe("59:59");
    expect(formatElapsed(3_723_000)).toBe("1:02:03");
  });

  it("reads the hold of a pending forced request", () => {
    const pending = {
      requestedAt: "2026-10-20T04:00:00.000Z",
      mode: "force" as const,
      version: "0.2.5",
      holdUntil: "2026-10-20T04:15:00.000Z",
      handled: false,
    };
    expect(pendingHoldUntil({ ...serviceWaiting, pendingInstall: pending })).toBe(
      Date.parse("2026-10-20T04:15:00.000Z"),
    );
    expect(
      pendingHoldUntil({
        ...serviceWaiting,
        pendingInstall: { ...pending, mode: "normal", holdUntil: null },
      }),
    ).toBeUndefined();
    expect(
      pendingHoldUntil({ ...serviceWaiting, pendingInstall: { ...pending, holdUntil: "soon" } }),
    ).toBeUndefined();
    expect(pendingHoldUntil({ ...serviceWaiting, pendingInstall: null })).toBeUndefined();
    expect(pendingHoldUntil(serviceWaiting)).toBeUndefined();
    expect(pendingHoldUntil(null)).toBeUndefined();
  });

  it("times each install attempt on its own when the agent goes back to waiting", () => {
    const at = 1_000_000;
    const installing = advanceServiceUpdateProgress(
      requested,
      { ...serviceWaiting, status: "installing" },
      at,
    );
    expect(installing).toMatchObject({ phase: "installing", installingSince: at });
    // New work started: the agent waits again, then installs on a fresh clock.
    const waiting = advanceServiceUpdateProgress(installing, serviceWaiting, at + 8 * 60_000);
    expect(waiting.phase).toBe("waiting");
    expect(waiting.installingSince).toBeUndefined();
    const again = advanceServiceUpdateProgress(
      waiting,
      { ...serviceWaiting, status: "installing" },
      at + 9 * 60_000,
    );
    expect(again).toMatchObject({ phase: "installing", installingSince: at + 9 * 60_000 });
    expect(
      advanceServiceUpdateProgress(
        again,
        { ...serviceWaiting, status: "installing" },
        at + 18 * 60_000,
      ).phase,
    ).toBe("installing");
  });

  it("targets the version the press installs, not only the agent's", () => {
    expect(startServiceUpdateProgress(serviceUpToDate, "0.2.5")).toMatchObject({
      phase: "stopping",
      targetVersion: "0.2.5",
      fromVersion: "0.2.4",
    });
    expect(startServiceUpdateProgress(serviceWaiting, null).targetVersion).toBe("0.2.5");
  });

  it("asks before stopping work, naming what ends", () => {
    const blocker = (kind: ServiceUpdateBlocker["kind"], count: number) =>
      ({
        kind,
        count,
        threadId: null,
        threadTitle: null,
        projectId: null,
        projectTitle: null,
      }) as unknown as ServiceUpdateBlocker;
    expect(describeServiceUpdateStop({ blockers: [] })).toBeNull();
    expect(describeServiceUpdateStop({ blockers: [], openTerminals: 0 })).toBeNull();
    expect(
      describeServiceUpdateStop({
        blockers: [
          blocker("run", 2),
          blocker("run", 1),
          blocker("queued", 1),
          blocker("request", 2),
          blocker("effect", 1),
        ],
        openTerminals: 1,
      }),
    ).toBe(
      [
        "Stop running work and update now?",
        "3 tasks will be interrupted. You can continue them after the update.",
        "1 queued message will be cancelled.",
        "2 open questions or approvals will be closed.",
        "1 terminal will close.",
        "1 agent step will be stopped.",
      ].join("\n"),
    );
    expect(describeServiceUpdateStop({ blockers: [], openTerminals: 2 })).toBe(
      "Stop running work and update now?\n2 terminals will close.",
    );
    // A project that continues threads after restarts keeps its work.
    const continuing = (kind: ServiceUpdateBlocker["kind"], count: number) =>
      ({ ...blocker(kind, count), continuesAfterRestart: true }) as ServiceUpdateBlocker;
    expect(
      describeServiceUpdateStop({ blockers: [continuing("run", 2), continuing("queued", 3)] }),
    ).toBe(
      [
        "Stop running work and update now?",
        "2 tasks will be interrupted and continue after the update.",
        "3 queued messages will wait and send after the update.",
      ].join("\n"),
    );
  });

  it("does not take the previous attempt's failure as this attempt's answer", () => {
    const failed = { ...serviceWaiting, status: "error" as const, message: "Did not install" };
    const retry = { ...requested, staleFailure: serviceFailureKey(failed), requestedAt: 1_000 };
    expect(advanceServiceUpdateProgress(retry, failed, 2_000)).toBe(retry);
    // A new failure (another message or install time) is this attempt's.
    expect(
      advanceServiceUpdateProgress(retry, { ...failed, message: "Disk full" }, 2_000).phase,
    ).toBe("failed");
    // The agent never ran again: after a while the old failure stands.
    expect(advanceServiceUpdateProgress(retry, failed, 1_000 + STALE_FAILURE_MS).phase).toBe(
      "failed",
    );
    expect(serviceFailureKey(serviceUpToDate)).toBeNull();
  });

  it("ignores a waiting or failed state the agent wrote before this request", () => {
    const requestedAt = Date.parse("2026-10-12T20:08:31.000Z");
    const retry = { ...requested, requestedAt };
    const oldWaiting = {
      ...serviceWaiting,
      message: "Waiting for running tasks, queued messages and open questions to finish",
      updatedAt: "2026-10-12T20:08:30.123456+00:00",
    };
    expect(isStaleServiceAnswer(retry, oldWaiting, requestedAt + 1_000)).toBe(true);
    expect(advanceServiceUpdateProgress(retry, oldWaiting, requestedAt + 1_000)).toBe(retry);
    // An old "waiting" never ends this attempt, however long the agent takes.
    expect(advanceServiceUpdateProgress(retry, oldWaiting, requestedAt + 10 * 60_000)).toBe(retry);
    // Written after the request: the agent's answer.
    const fresh = { ...oldWaiting, updatedAt: "2026-10-12T20:08:40+00:00" };
    expect(advanceServiceUpdateProgress(retry, fresh, requestedAt + 10_000)).toMatchObject({
      phase: "waiting",
      message: oldWaiting.message,
    });
    // An old failure never ends this attempt either: the agent may still be in
    // its first snapshot, and believing it would withdraw the live request.
    const oldError = { ...oldWaiting, status: "error" as const, message: "Did not install" };
    expect(advanceServiceUpdateProgress(retry, oldError, requestedAt + 1_000)).toBe(retry);
    expect(advanceServiceUpdateProgress(retry, oldError, requestedAt + STALE_FAILURE_MS)).toBe(
      retry,
    );
    const oldManual = { ...oldError, status: "manual-required" as const };
    expect(isStaleServiceAnswer(retry, oldManual, requestedAt + 10 * 60_000)).toBe(true);
    expect(advanceServiceUpdateProgress(retry, oldManual, requestedAt + 10 * 60_000)).toBe(retry);
    // A failure written after the request is this attempt's.
    expect(
      advanceServiceUpdateProgress(
        retry,
        { ...oldError, updatedAt: "2026-10-12T20:08:40+00:00" },
        requestedAt + 10_000,
      ).phase,
    ).toBe("failed");
    // Installing is always news.
    expect(
      advanceServiceUpdateProgress(retry, { ...oldWaiting, status: "installing" }, requestedAt)
        .phase,
    ).toBe("installing");
  });

  it("without the agent's write time, compares with the state seen before the request", () => {
    const before = { ...serviceWaiting, message: "Waiting for open SpecWithCode terminals" };
    const retry = { ...requested, staleFailure: serviceFailureKey(before), requestedAt: 1_000 };
    expect(advanceServiceUpdateProgress(retry, before, 2_000)).toBe(retry);
    expect(advanceServiceUpdateProgress(retry, before, 1_000 + STALE_FAILURE_MS).phase).toBe(
      "waiting",
    );
    expect(
      advanceServiceUpdateProgress(retry, { ...before, message: "Waiting for tasks" }, 2_000).phase,
    ).toBe("waiting");
  });
});

describe("describeAppRestartWarning", () => {
  const blocker = (kind: ServiceUpdateBlocker["kind"], count: number, title: string | null) =>
    ({
      kind,
      count,
      threadId: title,
      threadTitle: title,
      projectId: null,
      projectTitle: null,
    }) as unknown as ServiceUpdateBlocker;

  it("asks nothing when no work runs", () => {
    expect(describeAppRestartWarning({ blockers: [] })).toBeNull();
  });

  it("names how many jobs run, where, and the way to let them finish", () => {
    expect(
      describeAppRestartWarning(
        { blockers: [blocker("run", 1, "Fix login"), blocker("run", 2, "Docs")] },
        { version: "1.0.21" },
      ),
    ).toBe(
      [
        "Restart to install SpecWithCode 1.0.21?",
        "3 running in 2 threads. Restarting interrupts this work.",
        "Still running: 1 running task in “Fix login”; 2 running tasks in “Docs”.",
        "Restart when idle lets it finish first: SpecWithCode restarts once nothing runs, or after the wait set in Settings, and the stopped work continues after the restart.",
      ].join("\n"),
    );
  });

  it("only summarizes when the dialog lists the work itself", () => {
    expect(
      describeAppRestartWarning(
        { blockers: [blocker("run", 1, "Fix login"), blocker("queued", 2, "Docs")] },
        { version: "1.0.30", listed: true },
      ),
    ).toBe(
      [
        "Restart to install SpecWithCode 1.0.30?",
        "1 running, 2 queued in 2 threads. Restarting interrupts this work.",
      ].join("\n"),
    );
  });
});
