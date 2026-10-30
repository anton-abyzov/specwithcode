import type { DesktopUpdateState } from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  BUSY_RETRY_MS,
  ensureLatestAppUpdate,
  FRESH_FEED_CHECK_MS,
  feedCheckedRecently,
  installWhenUpdaterFree,
} from "./latestAppUpdate";

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

describe("a press after a recent feed check", () => {
  const NOW = Date.parse("2026-10-30T12:00:00.000Z");
  const checked = (agoMs: number, state: DesktopUpdateState = downloaded("1.0.31")) => ({
    ...state,
    checkedAt: new Date(NOW - agoMs).toISOString(),
    feedCheckedAt: new Date(NOW - agoMs).toISOString(),
  });

  it("uses the desktop's answer from under a minute ago instead of asking the feed again", async () => {
    vi.useFakeTimers({ now: NOW });
    try {
      const bridge = {
        checkForUpdate: vi.fn(async () => ({ checked: true, state: downloaded("1.0.32") })),
        downloadUpdate: vi.fn(),
        getUpdateState: vi.fn(async () => checked(20_000)),
      };
      await expect(ensureLatestAppUpdate(bridge)).resolves.toMatchObject({
        kind: "ready",
        version: "1.0.31",
      });
      expect(bridge.checkForUpdate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the feed when a check just failed with a download on disk", async () => {
    // What reduceDesktopUpdateStateOnCheckFailure leaves (updateMachine.ts):
    // status back to "downloaded" and a new checkedAt, which reads like
    // "nothing newer"; only feedCheckedAt still dates the last feed answer.
    const afterFailedCheck: DesktopUpdateState = {
      ...checked(5 * FRESH_FEED_CHECK_MS),
      checkedAt: new Date(NOW - 1_000).toISOString(),
    };
    expect(feedCheckedRecently(afterFailedCheck, NOW)).toBe(false);
    vi.useFakeTimers({ now: NOW });
    try {
      const bridge = {
        checkForUpdate: vi.fn(async () => ({ checked: true, state: downloaded("1.0.32") })),
        downloadUpdate: vi.fn(),
        getUpdateState: vi.fn(async () => afterFailedCheck),
      };
      await expect(ensureLatestAppUpdate(bridge)).resolves.toMatchObject({
        kind: "ready",
        version: "1.0.32",
      });
      expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the feed when the last check is a minute old, or failed, or still running", async () => {
    expect(feedCheckedRecently(checked(FRESH_FEED_CHECK_MS - 1), NOW)).toBe(true);
    expect(feedCheckedRecently(checked(FRESH_FEED_CHECK_MS), NOW)).toBe(false);
    expect(
      feedCheckedRecently(checked(1_000, { ...downloaded("1.0.31"), status: "checking" }), NOW),
    ).toBe(false);
    expect(
      feedCheckedRecently(checked(1_000, { ...downloaded("1.0.31"), status: "error" }), NOW),
    ).toBe(false);
    expect(feedCheckedRecently(downloaded("1.0.31"), NOW)).toBe(false);
    expect(feedCheckedRecently(null, NOW)).toBe(false);
    // An older desktop that does not report feedCheckedAt is always asked.
    const { feedCheckedAt: _omitted, ...olderDesktop } = checked(1_000);
    expect(feedCheckedRecently(olderDesktop, NOW)).toBe(false);
    vi.useFakeTimers({ now: NOW });
    try {
      const bridge = {
        checkForUpdate: vi.fn(async () => ({ checked: true, state: downloaded("1.0.32") })),
        downloadUpdate: vi.fn(),
        getUpdateState: vi.fn(async () => checked(FRESH_FEED_CHECK_MS + 5_000)),
      };
      await expect(ensureLatestAppUpdate(bridge)).resolves.toMatchObject({
        kind: "ready",
        version: "1.0.32",
      });
      expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("installWhenUpdaterFree", () => {
  it("asks a busy updater again a quarter second later", async () => {
    vi.useFakeTimers();
    try {
      expect(BUSY_RETRY_MS).toBe(250);
      const busy = {
        accepted: false,
        completed: false,
        reason: "busy" as const,
        state: downloaded("1.0.33"),
      };
      const installUpdate = vi
        .fn()
        .mockResolvedValueOnce(busy)
        .mockResolvedValueOnce({ accepted: true, completed: false, state: downloaded("1.0.33") });
      const done = installWhenUpdaterFree(
        { installUpdate, getUpdateState: vi.fn(async () => downloaded("1.0.33")) },
        "1.0.33",
      );
      await vi.advanceTimersByTimeAsync(BUSY_RETRY_MS - 1);
      expect(installUpdate).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect((await done).accepted).toBe(true);
      expect(installUpdate).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

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
