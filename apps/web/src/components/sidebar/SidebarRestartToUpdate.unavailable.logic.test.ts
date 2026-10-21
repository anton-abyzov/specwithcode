import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceServiceUpdateProgress,
  isReleaseUnavailableFailure,
  type ServiceUpdateProgress,
  startServiceUpdateProgress,
} from "./SidebarRestartToUpdate.logic";

// The agent ran for a request and found nothing to install: only then does
// the request fail for want of the release.

const requestedAt = 1_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

const serviceWaiting: StudioServiceUpdateState = {
  status: "waiting-for-quiet",
  identity: "m4",
  installedVersion: "0.2.4",
  availableVersion: "0.2.5",
  downloadedVersion: "0.2.5",
  checkedAt: null,
  quietSince: null,
  message: null,
  lastInstall: null,
};

const requested: ServiceUpdateProgress = {
  ...startServiceUpdateProgress(serviceWaiting),
  phase: "requesting",
  requestedAt,
  startedAt: requestedAt,
  holdUntil: requestedAt + 15 * 60_000,
};

/** The agent's answer to the request: no request pending, nothing newer found. */
const foundNothing = (patch: Partial<StudioServiceUpdateState> = {}): StudioServiceUpdateState => ({
  ...serviceWaiting,
  status: "up-to-date",
  availableVersion: null,
  downloadedVersion: null,
  updatedAt: iso(requestedAt + 1_000),
  pendingInstall: null,
  ...patch,
});

describe("the agent's answer to a request it found nothing for", () => {
  it("fails the request for want of the release", () => {
    expect(
      advanceServiceUpdateProgress(requested, foundNothing(), requestedAt + 2_000),
    ).toMatchObject({
      phase: "failed",
      message: "SpecWithCode 0.2.5 is not available to the service on this Mac yet.",
      unavailable: true,
    });
  });

  it("does not fail while the agent has the release on disk", () => {
    const onDisk = foundNothing({ downloadedVersion: "0.2.5" });
    expect(advanceServiceUpdateProgress(requested, onDisk, requestedAt + 2_000)).toBe(requested);
  });

  it("does not fail for an answer to a request this window cannot date", () => {
    const { requestedAt: _unknown, ...followed } = requested;
    const progress: ServiceUpdateProgress = followed;
    expect(advanceServiceUpdateProgress(progress, foundNothing(), requestedAt + 2_000)).toBe(
      progress,
    );
  });

  it("does not fail while the agent says an update is available", () => {
    const available = foundNothing({ status: "available" });
    expect(advanceServiceUpdateProgress(requested, available, requestedAt + 2_000)).toBe(requested);
  });
});

describe("a request that failed for want of the release", () => {
  it("is told apart from a request that still waits, and from other failures", () => {
    const failed = advanceServiceUpdateProgress(requested, foundNothing(), requestedAt + 2_000);
    expect(isReleaseUnavailableFailure(failed)).toBe(true);
    // Asked again: the flag the last answer left is not a failure of this request.
    expect(isReleaseUnavailableFailure({ ...failed, phase: "requesting" })).toBe(false);
    expect(isReleaseUnavailableFailure({ ...requested, phase: "failed", message: "x" })).toBe(
      false,
    );
    expect(isReleaseUnavailableFailure(null)).toBe(false);
  });
});
