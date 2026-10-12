import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import {
  makeThreadNotificationCenter,
  type NativeThreadNotification,
} from "./threadNotifications.ts";

function harness({
  supported = true,
  delivered = 7 as number | null,
  answer = "show" as "show" | "fail" | "none",
} = {}) {
  const created: Array<
    NativeThreadNotification & {
      title: string;
      body: string;
      click: () => void;
      dismiss: () => void;
      shown: boolean;
      closed: boolean;
      id: string;
    }
  > = [];
  const deliver = vi.fn((_sender: number, _exclude?: number): number | null => delivered);
  let clock = 1_000;
  const revealFallback = vi.fn();
  const onRefused = vi.fn();
  const center = makeThreadNotificationCenter({
    isSupported: () => supported,
    create: ({ id, title, body }) => {
      let onClick = () => {};
      let onClose = () => {};
      let onShow = () => {};
      let onFailed = (_error: string) => {};
      const notification = {
        id,
        title,
        body,
        shown: false,
        closed: false,
        show: () => {
          notification.shown = true;
          if (answer === "show") onShow();
          if (answer === "fail") onFailed("Notifications are not allowed for this application");
        },
        close: () => {
          notification.closed = true;
          onClose();
        },
        onClick: (listener: () => void) => {
          onClick = listener;
        },
        onClose: (listener: () => void) => {
          onClose = listener;
        },
        onShow: (listener: () => void) => {
          onShow = listener;
        },
        onFailed: (listener: (error: string) => void) => {
          onFailed = listener;
        },
        click: () => onClick(),
        dismiss: () => onClose(),
      };
      created.push(notification);
      return notification;
    },
    deliver,
    revealFallback,
    onRefused,
    answerTimeoutMs: 10,
    now: () => clock,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { center, created, deliver, revealFallback, onRefused, advance };
}

const target = { environmentId: "env-1", threadId: "thread-1" };
const input = { tag: "env-1:thread-1", title: "Input needed", body: "Fix the login form", target };

describe("thread notification center", () => {
  it("shows a native notification and opens its thread in the window that raised it", async () => {
    const { center, created, deliver, revealFallback } = harness();
    await expect(center.show(7, input)).resolves.toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: "Input needed", body: "Fix the login form" });
    expect(created[0]?.shown).toBe(true);

    created[0]?.click();
    expect(deliver).toHaveBeenCalledWith(7);
    expect(revealFallback).not.toHaveBeenCalled();
    expect(center.shownTags()).toEqual([]);
    // Another live window does not take a click meant for window 7.
    expect(center.takePendingOpen(9, () => true)).toBeNull();
    expect(center.takePendingOpen(7, () => true)).toEqual(target);
    expect(center.takePendingOpen(7, () => true)).toBeNull();
  });

  it("gives each post a short native id of its own", async () => {
    const { center, created } = harness();
    const long = { ...input, tag: `${"e".repeat(36)}:${"t".repeat(36)}` };
    await center.show(7, long);
    await center.show(7, long);
    const [first, second] = created.map((notification) => notification.id);
    expect(first).not.toEqual(second);
    for (const id of [first, second]) expect(id?.length).toBeLessThanOrEqual(64);
  });

  it("replaces the older notification for the same thread", () => {
    const { center, created } = harness();
    void center.show(7, input);
    void center.show(7, { ...input, title: "Approval needed" });
    expect(created).toHaveLength(2);
    expect(created[0]?.closed).toBe(true);
    expect(created[1]?.closed).toBe(false);
    expect(center.shownTags()).toEqual(["env-1:thread-1"]);
  });

  it("keeps a click for the first window to load when there is none", () => {
    const { center, created, revealFallback } = harness({ delivered: null });
    void center.show(7, input);
    created[0]?.click();
    expect(revealFallback).toHaveBeenCalledTimes(1);
    expect(center.takePendingOpen(12, () => true)).toEqual(target);
    expect(center.takePendingOpen(12, () => true)).toBeNull();
  });

  it("lets another window take a click when the chosen one is gone", () => {
    const { center, created } = harness();
    void center.show(7, input);
    created[0]?.click();
    expect(center.takePendingOpen(9, (id) => id !== 7)).toEqual(target);
  });

  it("moves a waiting click to another window when the chosen one goes away", () => {
    const { center, created, deliver, revealFallback } = harness();
    void center.show(7, input);
    created[0]?.click();
    deliver.mockReturnValueOnce(9);
    center.windowGone(3);
    expect(deliver).toHaveBeenCalledTimes(1);
    center.windowGone(7);
    expect(deliver).toHaveBeenLastCalledWith(-1, 7);
    expect(revealFallback).not.toHaveBeenCalled();
    expect(center.takePendingOpen(7, () => true)).toBeNull();
    expect(center.takePendingOpen(9, () => true)).toEqual(target);
  });

  it("opens a window when the chosen one goes away and no other is left", () => {
    const { center, created, deliver, revealFallback } = harness();
    void center.show(7, input);
    created[0]?.click();
    deliver.mockReturnValueOnce(null);
    center.windowGone(7);
    expect(revealFallback).toHaveBeenCalledTimes(1);
    expect(center.takePendingOpen(12, () => true)).toEqual(target);
  });

  it("drops a click nobody took within a minute", () => {
    const { center, created, advance } = harness();
    void center.show(7, input);
    created[0]?.click();
    advance(61_000);
    expect(center.takePendingOpen(7, () => true)).toBeNull();
  });

  it("withdraws notifications by tag and forgets ones the user dismissed", () => {
    const { center, created } = harness();
    void center.show(7, input);
    void center.show(7, { ...input, tag: "env-1:thread-2" });
    center.close("env-1:thread-1");
    expect(created[0]?.closed).toBe(true);
    created[1]?.dismiss();
    expect(center.shownTags()).toEqual([]);
    void center.show(7, input);
    center.closeAll();
    expect(created[2]?.closed).toBe(true);
  });

  it("reports false where the system cannot show notifications", async () => {
    const { center, created } = harness({ supported: false });
    await expect(center.show(7, input)).resolves.toBe(false);
    expect(created).toHaveLength(0);
  });

  it("reports false and forgets a notification the system refused", async () => {
    const { center, onRefused } = harness({ answer: "fail" });
    await expect(center.show(7, input)).resolves.toBe(false);
    expect(onRefused).toHaveBeenCalledWith("Notifications are not allowed for this application");
    expect(center.shownTags()).toEqual([]);
  });

  it("counts a notification as shown when the system never answers", async () => {
    const { center } = harness({ answer: "none" });
    await expect(center.show(7, input)).resolves.toBe(true);
    expect(center.shownTags()).toEqual(["env-1:thread-1"]);
  });
});
