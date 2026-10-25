import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { deliverNotificationOnce, __resetNotificationHistoryForTests } from "./notificationHistory";
beforeEach(() => {
  __resetNotificationHistoryForTests();
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  vi.stubGlobal("navigator", {});
});
afterEach(() => vi.unstubAllGlobals());
it("deduplicates a pending event and persists across renderer restart", async () => {
  const deliver = vi.fn().mockResolvedValue(true);
  await Promise.all([
    deliverNotificationOnce("env-a:thread:request-1", deliver),
    deliverNotificationOnce("env-a:thread:request-1", deliver),
  ]);
  __resetNotificationHistoryForTests();
  await deliverNotificationOnce("env-a:thread:request-1", deliver);
  expect(deliver).toHaveBeenCalledTimes(1);
});
it("keeps machine identities and distinct requests separate", async () => {
  const deliver = vi.fn().mockResolvedValue(true);
  for (const key of ["a:t:r1", "b:t:r1", "a:t:r2"]) await deliverNotificationOnce(key, deliver);
  expect(deliver).toHaveBeenCalledTimes(3);
});
it("refusals and exceptions can retry", async () => {
  const deliver = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockRejectedValueOnce(new Error("permission"))
    .mockResolvedValue(true);
  for (let i = 0; i < 4; i++) await deliverNotificationOnce("event", deliver);
  expect(deliver).toHaveBeenCalledTimes(3);
});
it("serializes browser tabs with the origin lock", async () => {
  const request = vi.fn(async (_key: string, action: () => Promise<void>) => action());
  vi.stubGlobal("navigator", { locks: { request } });
  await deliverNotificationOnce("event", async () => true);
  expect(request).toHaveBeenCalledWith("specwithcode:notification-delivery", expect.any(Function));
});
