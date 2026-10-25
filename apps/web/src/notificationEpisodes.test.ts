import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import {
  observeNotificationEpisode,
  __resetNotificationEpisodesForTests,
} from "./notificationEpisodes";
import { deliverNotificationOnce, __resetNotificationHistoryForTests } from "./notificationHistory";
beforeEach(() => {
  __resetNotificationEpisodesForTests();
  __resetNotificationHistoryForTests();
  const storage = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  let tail = Promise.resolve<unknown>(undefined);
  vi.stubGlobal("navigator", {
    locks: {
      request: (_key: string, run: () => unknown) => {
        const next = tail.then(run);
        tail = next;
        return next;
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
it("shares one episode across separate client memories and deduplicates delivery", async () => {
  const deliver = vi.fn().mockResolvedValue(true);
  const first = await observeNotificationEpisode(
    "env:project:thread:run:plan",
    true,
    "2026-10-23T10:00:00Z",
    true,
  );
  await deliverNotificationOnce(first!, deliver);
  __resetNotificationEpisodesForTests();
  __resetNotificationHistoryForTests();
  const second = await observeNotificationEpisode(
    "env:project:thread:run:plan",
    true,
    "2026-10-23T10:01:00Z",
    true,
  );
  expect(second).toBe(first);
  await deliverNotificationOnce(second!, deliver);
  expect(deliver).toHaveBeenCalledTimes(1);
});
it("does not replay initial activity and starts a new episode only after resolution", async () => {
  expect(await observeNotificationEpisode("scope", true, "2026-10-23T10:00:00Z", false)).toBeNull();
  await observeNotificationEpisode("scope", false, "2026-10-23T10:01:00Z", false);
  const first = await observeNotificationEpisode("scope", true, "2026-10-23T10:02:00Z", true);
  expect(first).toBeTruthy();
  expect(
    await observeNotificationEpisode("scope", false, "2026-10-23T10:01:00Z", false),
  ).toBeNull();
  expect(await observeNotificationEpisode("scope", true, "2026-10-23T10:03:00Z", false)).toBe(
    first,
  );
  await observeNotificationEpisode("scope", false, "2026-10-23T10:04:00Z", false);
  expect(await observeNotificationEpisode("scope", true, "2026-10-23T10:05:00Z", true)).not.toBe(
    first,
  );
});
