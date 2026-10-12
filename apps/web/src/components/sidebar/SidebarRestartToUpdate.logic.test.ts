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
  serviceFailureKey,
  STALE_FAILURE_MS,
  serviceUpdateToast,
  startServiceUpdateProgress,
  describeInstallOutcome,
  getRestartToUpdateView,
  isAppUpdateReady,
  isServiceUpdateReady,
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
    const view = getRestartToUpdateView(appDownloaded, serviceUpToDate);
    expect(view).toMatchObject({ app: true, service: false, label: "Restart to update" });
    expect(view?.description).toContain("SpecWithCode 0.2.5 is downloaded.");
    expect(view?.description).toContain("Restarts the app to install it.");
  });

  it("installs a waiting service update on its own", () => {
    const view = getRestartToUpdateView(appIdle, serviceWaiting);
    expect(view).toMatchObject({ app: false, service: true, label: "Restart to update" });
    expect(view?.description).toContain("Restarts the SpecWithCode service to install it.");
  });

  it("does both when the app and the service each have an update", () => {
    const view = getRestartToUpdateView(appDownloaded, {
      ...serviceWaiting,
      status: "downloaded",
    });
    expect(view).toMatchObject({ app: true, service: true });
    expect(view?.description).toContain("Restarts the app and the SpecWithCode service");
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
    expect(describeInstallOutcome({ ...base, accepted: false, reason: "busy" })).toContain(
      "Try again",
    );
  });

  it("treats only on-disk service releases as ready", () => {
    expect(isServiceUpdateReady(serviceWaiting)).toBe(true);
    expect(isServiceUpdateReady({ ...serviceWaiting, status: "downloaded" })).toBe(true);
    expect(isServiceUpdateReady({ ...serviceWaiting, status: "available" })).toBe(false);
    expect(isServiceUpdateReady({ ...serviceWaiting, status: "installing" })).toBe(false);
    expect(isServiceUpdateReady(null)).toBe(false);
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

  it("names what still runs, most important first, and offers to stop it after a while", () => {
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
    expect(serviceUpdateToast(waiting, false)).toMatchObject({ type: "loading", action: null });
    expect(serviceUpdateToast(waiting, true)).toMatchObject({ type: "warning", action: "stop" });
    expect(serviceUpdateToast({ ...waiting, blockers: [] }, true)).toMatchObject({
      action: "retry",
    });
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
    expect(serviceFailureKey(serviceWaiting)).toBeNull();
  });
});
