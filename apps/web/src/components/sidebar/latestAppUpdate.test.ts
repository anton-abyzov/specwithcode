import type { DesktopUpdateState } from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { ensureLatestAppUpdate, installWhenUpdaterFree } from "./latestAppUpdate";

const base = {
  enabled: true,
  channel: "latest",
  currentVersion: "1.0.28",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  releaseNotes: [],
  omittedReleaseCount: 0,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: true,
} as const;
const downloaded = (version: string): DesktopUpdateState => ({
  ...base,
  status: "downloaded",
  availableVersion: version,
  downloadedVersion: version,
  downloadPercent: 100,
});

describe("ensureLatestAppUpdate", () => {
  it("replaces a waiting 1.0.29 download with the newest 1.0.31, skipping 1.0.30", async () => {
    const available: DesktopUpdateState = {
      ...base,
      status: "available",
      availableVersion: "1.0.31",
      downloadedVersion: null,
      downloadPercent: null,
    };
    const bridge = {
      checkForUpdate: vi.fn(async () => ({ checked: true, state: available })),
      downloadUpdate: vi.fn(async () => ({
        accepted: true,
        completed: true,
        state: downloaded("1.0.31"),
      })),
      getUpdateState: vi.fn(async () => downloaded("1.0.31")),
    };
    const progress = vi.fn();
    await expect(ensureLatestAppUpdate(bridge, progress)).resolves.toMatchObject({
      kind: "ready",
      version: "1.0.31",
    });
    expect(progress).toHaveBeenCalledWith({
      phase: "downloading",
      version: "1.0.31",
      percent: null,
    });
  });

  it("follows a background download already under way", async () => {
    const downloading: DesktopUpdateState = {
      ...base,
      status: "downloading",
      availableVersion: "1.0.30",
      downloadedVersion: null,
      downloadPercent: 40,
    };
    const states = [downloading, downloaded("1.0.30")];
    const bridge = {
      checkForUpdate: vi.fn(async () => ({ checked: false, state: downloading })),
      downloadUpdate: vi.fn(),
      getUpdateState: vi.fn(async () => states.shift() ?? downloaded("1.0.30")),
    };
    vi.useFakeTimers();
    const result = ensureLatestAppUpdate(bridge);
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    await expect(result).resolves.toMatchObject({ kind: "ready", version: "1.0.30" });
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();
  });

  it("keeps the existing download when the feed cannot be reached", async () => {
    const bridge = {
      checkForUpdate: vi.fn(async () => {
        throw new Error("offline");
      }),
      downloadUpdate: vi.fn(),
      getUpdateState: vi.fn(async () => downloaded("1.0.29")),
    };
    await expect(ensureLatestAppUpdate(bridge)).resolves.toMatchObject({
      kind: "ready",
      version: "1.0.29",
    });
  });

  it("reports a newer release that could not be downloaded", async () => {
    const failed: DesktopUpdateState = {
      ...base,
      status: "error",
      availableVersion: "1.0.30",
      downloadedVersion: null,
      downloadPercent: null,
      message: "Network lost",
      errorContext: "download",
    };
    const bridge = {
      checkForUpdate: vi.fn(async () => ({
        checked: true,
        state: { ...failed, status: "available" as const, message: null, errorContext: null },
      })),
      downloadUpdate: vi.fn(async () => ({ accepted: true, completed: false, state: failed })),
      getUpdateState: vi.fn(async () => failed),
    };
    await expect(ensureLatestAppUpdate(bridge)).resolves.toMatchObject({
      kind: "failed",
      message: "Network lost",
    });
  });
});

describe("installWhenUpdaterFree", () => {
  it("waits while the updater finishes another step, then installs", async () => {
    vi.useFakeTimers();
    try {
      const busy = {
        accepted: false,
        completed: false,
        reason: "busy" as const,
        state: downloaded("1.0.33"),
      };
      const installUpdate = vi
        .fn()
        .mockResolvedValueOnce(busy)
        .mockResolvedValueOnce(busy)
        .mockResolvedValueOnce({ accepted: true, completed: false, state: downloaded("1.0.33") });
      const progress = vi.fn();
      const done = installWhenUpdaterFree(
        { installUpdate, getUpdateState: vi.fn(async () => downloaded("1.0.33")) },
        "1.0.33",
        progress,
      );
      await vi.advanceTimersByTimeAsync(2_500);
      const result = await done;
      expect(result.accepted).toBe(true);
      expect(installUpdate).toHaveBeenCalledTimes(3);
      expect(installUpdate).toHaveBeenCalledWith({ expectedVersion: "1.0.33" });
      expect(progress).toHaveBeenCalledWith({ phase: "waiting", version: "1.0.33", percent: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after the wait and returns the busy refusal", async () => {
    vi.useFakeTimers();
    try {
      const busy = {
        accepted: false,
        completed: false,
        reason: "busy" as const,
        state: downloaded("1.0.33"),
      };
      const installUpdate = vi.fn(async () => busy);
      const done = installWhenUpdaterFree(
        { installUpdate, getUpdateState: vi.fn(async () => downloaded("1.0.33")) },
        "1.0.33",
        undefined,
        3_000,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await done).reason).toBe("busy");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a refusal that waiting cannot fix", async () => {
    const installUpdate = vi.fn(async () => ({
      accepted: false,
      completed: false,
      reason: "no-download" as const,
      state: downloaded("1.0.33"),
    }));
    const result = await installWhenUpdaterFree(
      { installUpdate, getUpdateState: vi.fn(async () => downloaded("1.0.33")) },
      "1.0.33",
    );
    expect(result.reason).toBe("no-download");
    expect(installUpdate).toHaveBeenCalledTimes(1);
  });
  it("tells main the agent lacks the release on an app-only press", async () => {
    const installUpdate = vi.fn(async (_options?: unknown) => ({
      accepted: true,
      completed: false,
      state: downloaded("1.0.33"),
    }));
    await installWhenUpdaterFree(
      { installUpdate, getUpdateState: vi.fn(async () => downloaded("1.0.33")) },
      "1.0.33",
      undefined,
      undefined,
      true,
    );
    expect(installUpdate).toHaveBeenCalledWith({
      expectedVersion: "1.0.33",
      serviceLacksRelease: true,
    });
  });
});
