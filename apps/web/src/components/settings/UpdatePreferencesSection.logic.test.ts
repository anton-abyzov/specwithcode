import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { SERVICE_REQUEST_EXPIRED } from "../sidebar/SidebarRestartToUpdate.logic";
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

// A refusal Update now gets past: update.py restarts the service for a held request.
const LOG_DELETED =
  "SpecWithCode cannot be updated right now: The SpecWithCode service is using a database log that was deleted from disk. Restart SpecWithCode, then update";

describe("UpdatePreferencesSection.logic", () => {
  it("describes each service update stage", () => {
    expect(describeServiceUpdate(state({}))).toBe("Version 0.1.4. Up to date.");
    expect(
      describeServiceUpdate(state({ status: "waiting-for-quiet", downloadedVersion: "0.2.0" })),
    ).toBe("Version 0.1.4. Version 0.2.0 installs once no session has worked for a while.");
    expect(
      describeServiceUpdate(
        state({ status: "manual-required", message: "SpecWithCode 0.2.0 needs a manual upgrade." }),
      ),
    ).toBe("SpecWithCode 0.2.0 needs a manual upgrade.");
  });

  it("offers install when a release is waiting and check otherwise", () => {
    expect(resolveServiceUpdateAction(state({ status: "available" }))).toBe("install");
    expect(resolveServiceUpdateAction(state({ status: "waiting-for-quiet" }))).toBe("install");
    expect(resolveServiceUpdateAction(state({ status: "error" }))).toBe("check");
    expect(resolveServiceUpdateAction(state({ status: "installing" }))).toBe("none");
    expect(resolveServiceUpdateAction(state({ status: "not-managed" }))).toBe("none");
  });

  it("does not offer install for the version the service already runs", () => {
    const stale = state({ status: "waiting-for-quiet", downloadedVersion: "0.1.4" });
    expect(resolveServiceUpdateAction(stale)).toBe("check");
    expect(describeServiceUpdate(stale)).toBe("Version 0.1.4. Up to date.");
    expect(
      resolveServiceUpdateAction(state({ status: "available", availableVersion: "0.1.4" })),
    ).toBe("check");
    expect(
      resolveServiceUpdateAction(state({ status: "downloaded", downloadedVersion: "0.1.5" })),
    ).toBe("install");
  });

  it("offers install beside a refusal Update now gets past, with a newer release on disk", () => {
    // The real case: the service lost its database log, with 1.0.63 on disk.
    const failed = state({
      status: "error",
      installedVersion: "1.0.62",
      downloadedVersion: "1.0.63",
      availableVersion: "1.0.63",
      checkedAt: "2026-10-19T10:05:00.000Z",
      lastInstall: { version: "1.0.62", result: "updated", at: "2026-10-19T10:00:00.000Z" },
      message: LOG_DELETED,
    });
    expect(resolveServiceUpdateAction(failed)).toBe("install");
    // The failure stays shown next to the action.
    expect(describeServiceUpdate(failed)).toBe(failed.message);
    // Offered by its feed, not yet on disk, is not enough.
    expect(
      resolveServiceUpdateAction({
        ...failed,
        downloadedVersion: null,
        availableVersion: "1.0.64",
      }),
    ).toBe("check");
    // Nothing newer than what runs: only a check.
    expect(
      resolveServiceUpdateAction({
        ...failed,
        downloadedVersion: "1.0.62",
        availableVersion: null,
      }),
    ).toBe("check");
    expect(
      resolveServiceUpdateAction({ ...failed, downloadedVersion: null, availableVersion: null }),
    ).toBe("check");
  });

  it("offers only a check beside a failure a forced request cannot get past", () => {
    const failed = state({
      status: "error",
      installedVersion: "0.2.4",
      downloadedVersion: "0.2.5",
      availableVersion: "0.2.5",
      checkedAt: "2026-10-19T10:05:00.000Z",
      message: LOG_DELETED,
    });
    expect(resolveServiceUpdateAction(failed)).toBe("install");
    // The agent's check keeps failing: every pass checks again and fails first.
    expect(
      resolveServiceUpdateAction({
        ...failed,
        checkedAt: null,
        message: "GitHub release lookup failed (HTTP 403)",
      }),
    ).toBe("check");
    // The agent rejected its download: it does not fetch it again before its next check.
    expect(
      resolveServiceUpdateAction({
        ...failed,
        downloadedVersion: null,
        message: "Runtime archive checksum does not match the release",
      }),
    ).toBe("check");
    // The desktop could not start the agent at all.
    expect(
      resolveServiceUpdateAction({
        ...failed,
        agentStartFailed: true,
        message:
          "Update agent is turned off in launchd. Choose Repair in Settings to turn it back on.",
      }),
    ).toBe("check");
  });

  it("offers install again beside a request that lapsed, with the release on disk", () => {
    const lapsed = state({
      status: "error",
      installedVersion: "0.2.4",
      downloadedVersion: "0.2.5",
      availableVersion: "0.2.5",
      checkedAt: "2026-10-19T10:05:00.000Z",
      message: SERVICE_REQUEST_EXPIRED,
    });
    expect(resolveServiceUpdateAction(lapsed)).toBe("install");
    expect(describeServiceUpdate(lapsed)).toBe(SERVICE_REQUEST_EXPIRED);
    // Nothing on disk to install, or a desktop that could not start the agent: a check.
    expect(resolveServiceUpdateAction({ ...lapsed, downloadedVersion: null })).toBe("check");
    expect(resolveServiceUpdateAction({ ...lapsed, agentStartFailed: true })).toBe("check");
  });
});
