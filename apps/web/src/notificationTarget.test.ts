import { EnvironmentId, type BackgroundPolicySnapshot } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./lib/backgroundActivityReporter", () => ({
  appClientId: (clientId: string) => clientId.split(":")[0],
}));

import {
  __setNotificationTargetFetcherForTests,
  cachedNotificationTarget,
  decideNotificationDelivery,
  NOTIFICATION_TARGET_TIMEOUT_MS,
  notificationTargetFromSnapshot,
  readNotificationTarget,
  type NotificationTargetRead,
} from "./notificationTarget";

const SERVING = EnvironmentId.make("env-serving");
const NOW = DateTime.makeUnsafe("2026-11-12T12:00:00.000Z");

function snapshot(overrides: Partial<BackgroundPolicySnapshot> = {}): BackgroundPolicySnapshot {
  return {
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: NOW,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: false,
    updatedAt: NOW,
    ...overrides,
  };
}

afterEach(() => {
  __setNotificationTargetFetcherForTests(null);
  vi.useRealTimers();
});

describe("decideNotificationDelivery", () => {
  const known = (clientId: string): NotificationTargetRead => ({
    status: "known",
    target: { clientId, reason: "foreground" },
    ownerAppConnected: true,
  });
  const base = {
    ownClientId: "me",
    ownEnvironmentId: "env-mine",
    servingEnvironmentId: "env-serving",
    ownerMachineId: "env-serving",
    ownerReachable: true,
  };

  it("posts on the target", () => {
    expect(decideNotificationDelivery({ ...base, read: known("me") })).toBe("post");
    expect(
      decideNotificationDelivery({ ...base, ownClientId: "me:window", read: known("me") }),
    ).toBe("post");
  });

  it("badges on the owner machine's app and keeps every other app quiet", () => {
    expect(
      decideNotificationDelivery({
        ...base,
        ownEnvironmentId: "env-serving",
        read: known("other"),
      }),
    ).toBe("badge");
    expect(decideNotificationDelivery({ ...base, read: known("other") })).toBe("none");
    // An owner this app cannot reach leaves the badge here.
    expect(
      decideNotificationDelivery({ ...base, ownerReachable: false, read: known("other") }),
    ).toBe("badge");
  });

  it("without a target, pops up on the serving machine's app, or everywhere when it has none", () => {
    for (const read of [
      { status: "unknown", ownerAppConnected: true } as const,
      { status: "known", target: null, ownerAppConnected: true } as const,
    ]) {
      expect(decideNotificationDelivery({ ...base, ownEnvironmentId: "env-serving", read })).toBe(
        "post",
      );
      expect(decideNotificationDelivery({ ...base, read })).toBe("badge");
    }
    expect(
      decideNotificationDelivery({
        ...base,
        read: { status: "unknown", ownerAppConnected: false },
      }),
    ).toBe("post");
    expect(decideNotificationDelivery({ ...base, read: undefined })).toBe("post");
  });
});

describe("notificationTargetFromSnapshot", () => {
  it("reads an older server, which names no target, as unknown", () => {
    expect(notificationTargetFromSnapshot(SERVING, snapshot())).toEqual({
      status: "unknown",
      ownerAppConnected: false,
    });
  });

  it("notes whether the serving machine's own app reports to it", () => {
    const lease = {
      sessionId: "s",
      rpcClientId: 1,
      clientId: "c",
      clientKind: "desktop-renderer",
      visible: false,
      focused: false,
      recentlyInteracted: false,
      scopes: [],
      hostEnvironmentId: SERVING,
      updatedAt: NOW,
      expiresAt: NOW,
    } as unknown as BackgroundPolicySnapshot["leases"][number];
    expect(
      notificationTargetFromSnapshot(
        SERVING,
        snapshot({ leases: [lease], notificationTarget: { clientId: "c", reason: "owner" } }),
      ),
    ).toEqual({
      status: "known",
      target: { clientId: "c", reason: "owner" },
      ownerAppConnected: true,
    });
  });
});

describe("readNotificationTarget", () => {
  it("asks once for a burst and again after five seconds", async () => {
    const fetcher = vi.fn(async () => snapshot({ notificationTarget: null }));
    __setNotificationTargetFetcherForTests(fetcher);
    const start = Date.now();
    await Promise.all([
      readNotificationTarget(SERVING, start),
      readNotificationTarget(SERVING, start),
    ]);
    await readNotificationTarget(SERVING, start + 4_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await readNotificationTarget(SERVING, Date.now() + 5_001);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cachedNotificationTarget(SERVING)).toEqual({
      status: "known",
      target: null,
      ownerAppConnected: false,
    });
  });

  it("reads a failure as unknown", async () => {
    __setNotificationTargetFetcherForTests(() => Promise.reject(new Error("offline")));
    expect(await readNotificationTarget(SERVING)).toEqual({
      status: "unknown",
      ownerAppConnected: false,
    });
  });

  it("gives up after a second and a half", async () => {
    vi.useFakeTimers();
    __setNotificationTargetFetcherForTests(() => new Promise(() => undefined));
    const read = readNotificationTarget(SERVING);
    await vi.advanceTimersByTimeAsync(NOTIFICATION_TARGET_TIMEOUT_MS);
    expect(await read).toEqual({ status: "unknown", ownerAppConnected: false });
  });
});
