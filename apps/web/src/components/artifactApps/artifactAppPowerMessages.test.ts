import type {
  DesktopArtifactAppPermissions,
  DesktopArtifactAppPowerInput,
  DesktopArtifactAppPowerReply,
} from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  artifactAppPowerNotification,
  forwardArtifactAppPowerMessage,
  isOwnFrameMessage,
  makeArtifactAppPermissionsCaller,
  readArtifactAppPowerMessage,
} from "./artifactAppPowerMessages";

const frameWindow = { name: "page frame" };
const otherWindow = { name: "another frame" };
const request = (overrides: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "app/notify",
  params: { title: "Break", body: "Stand up" },
  ...overrides,
});

const flush = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

type Power = (input: DesktopArtifactAppPowerInput) => Promise<DesktopArtifactAppPowerReply>;
const allowing = (): Power => vi.fn(async () => ({ ok: true }) as const);

// `power` and `frame` are passed as they are, undefined and null included.
function forward(
  event: { data: unknown; source: unknown; origin: string },
  power: Power | undefined,
  frame: unknown = frameWindow,
) {
  const replies: Array<unknown> = [];
  const handled = forwardArtifactAppPowerMessage({
    event,
    frameWindow: frame,
    attachmentId: "version-1",
    power,
    reply: (message) => replies.push(message),
  });
  return { handled, replies, power };
}

describe("isOwnFrameMessage", () => {
  it("accepts only the frame's own window posting from the opaque origin", () => {
    expect(isOwnFrameMessage({ source: frameWindow, origin: "null" }, frameWindow)).toBe(true);
    for (const [source, origin, frame] of [
      [otherWindow, "null", frameWindow],
      [null, "null", frameWindow],
      [undefined, "null", frameWindow],
      [frameWindow, "https://example.com", frameWindow],
      [frameWindow, "studio://app", frameWindow],
      [frameWindow, "", frameWindow],
      // No frame yet: nothing is trusted, not even a message with no source.
      [null, "null", null],
      [undefined, "null", undefined],
      [frameWindow, "null", null],
    ] as const) {
      expect(isOwnFrameMessage({ source, origin }, frame)).toBe(false);
    }
  });
});

describe("readArtifactAppPowerMessage", () => {
  it("reads app requests and nothing else", () => {
    expect(readArtifactAppPowerMessage(request())).toEqual({
      id: 1,
      method: "app/notify",
      params: { title: "Break", body: "Stand up" },
    });
    expect(readArtifactAppPowerMessage(request({ id: "a", method: "app/tray/set" }))?.id).toBe("a");
    for (const data of [
      null,
      "app/notify",
      request({ jsonrpc: "1.0" }),
      request({ method: "ui/open-link" }),
      request({ method: "specwithcode/open-file" }),
      request({ method: "app/" }),
      request({ method: "app/Notify" }),
      request({ method: "xapp/notify" }),
      request({ method: 5 }),
      request({ id: undefined }),
      request({ id: null }),
      request({ id: 1.5 }),
      request({ id: "" }),
      request({ id: "x".repeat(129) }),
      request({ id: {} }),
    ]) {
      expect(readArtifactAppPowerMessage(data)).toBeUndefined();
    }
  });
});

describe("forwardArtifactAppPowerMessage", () => {
  it("forwards its own frame's request with the mounted version and posts the result", async () => {
    const { handled, replies, power } = forward(
      { data: request(), source: frameWindow, origin: "null" },
      allowing(),
    );
    expect(handled).toBe(true);
    expect(power).toHaveBeenCalledWith({
      attachmentId: "version-1",
      method: "app/notify",
      params: { title: "Break", body: "Stand up" },
    });
    await flush();
    expect(replies).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });

  it("does nothing for a message that is not from its own frame", async () => {
    for (const event of [
      { data: request(), source: otherWindow, origin: "null" },
      { data: request(), source: null, origin: "null" },
      { data: request(), source: frameWindow, origin: "https://example.com" },
      // The app's own window posting to itself is not the page.
      { data: request(), source: globalThis, origin: "studio://app" },
    ]) {
      const { handled, replies, power } = forward(event, allowing());
      expect(handled).toBe(false);
      await flush();
      expect(power).not.toHaveBeenCalled();
      expect(replies).toEqual([]);
    }
    // Before the frame exists nothing is forwarded either.
    const early = forward({ data: request(), source: null, origin: "null" }, allowing(), null);
    expect(early.power).not.toHaveBeenCalled();
    expect(early.handled).toBe(false);
    expect(early.replies).toEqual([]);
  });

  it("leaves other requests on the frame's channel alone", async () => {
    const { handled, replies, power } = forward(
      {
        data: { jsonrpc: "2.0", id: 2, method: "ui/open-link", params: { url: "https://x.test" } },
        source: frameWindow,
        origin: "null",
      },
      allowing(),
    );
    expect(handled).toBe(false);
    await flush();
    expect(power).not.toHaveBeenCalled();
    expect(replies).toEqual([]);
  });

  it("answers with the shell's refusal, and with a refusal when the shell is missing or fails", async () => {
    const event = { data: request({ id: "r" }), source: frameWindow, origin: "null" };
    const refused = { jsonrpc: "2.0", id: "r", error: { code: -32000, message: "not-allowed" } };

    const limited = forward(
      event,
      vi.fn(async () => ({ ok: false, error: "rate-limited" }) as const),
    );
    await flush();
    expect(limited.replies).toEqual([
      { jsonrpc: "2.0", id: "r", error: { code: -32000, message: "rate-limited" } },
    ]);

    for (const power of [
      undefined,
      vi.fn(() => Promise.reject(new Error("ipc failed"))),
      vi.fn(() => {
        throw new Error("no bridge");
      }),
      // Anything that is not a clear yes is a no.
      vi.fn(async () => undefined as unknown as DesktopArtifactAppPowerReply),
      vi.fn(async () => ({}) as unknown as DesktopArtifactAppPowerReply),
      vi.fn(async () => ({ ok: "true" }) as unknown as DesktopArtifactAppPowerReply),
      vi.fn(async () => ({ ok: 1 }) as unknown as DesktopArtifactAppPowerReply),
    ]) {
      const result = forward(event, power);
      expect(result.handled).toBe(true);
      await flush();
      expect(result.replies).toEqual([refused]);
    }
  });
});

describe("artifactAppPowerNotification", () => {
  it("passes an event on only to the version it is for", () => {
    const event = {
      attachmentId: "version-1",
      method: "app/tray/clicked",
      params: { id: "start" },
    } as const;
    expect(artifactAppPowerNotification(event, "version-1")).toEqual({
      jsonrpc: "2.0",
      method: "app/tray/clicked",
      params: { id: "start" },
    });
    expect(artifactAppPowerNotification(event, "version-2")).toBeUndefined();
  });
});

describe("makeArtifactAppPermissionsCaller", () => {
  const state = (attachmentId: string | null): DesktopArtifactAppPermissions => ({
    attachmentId,
    declared: [],
    granted: [],
  });

  it("sends one action at a time, in the order asked", async () => {
    const log: Array<string> = [];
    let finishFirst: (() => void) | undefined;
    const call = makeArtifactAppPermissionsCaller(() => async (input) => {
      log.push(`start ${input.action}`);
      if (input.action === "close") await new Promise<void>((resolve) => (finishFirst = resolve));
      log.push(`end ${input.action}`);
      return state(input.action === "open" ? input.attachmentId : null);
    });
    const closed = call({ action: "close" });
    const opened = call({ action: "open", attachmentId: "version-2", url: "http://127.0.0.1/a" });
    await flush();
    // The open has not reached the shell while the close is still running.
    expect(log).toEqual(["start close"]);
    finishFirst?.();
    expect(await closed).toEqual(state(null));
    expect(await opened).toEqual(state("version-2"));
    expect(log).toEqual(["start close", "end close", "start open", "end open"]);
  });

  it("answers null when the shell has no such method or fails, and keeps going", async () => {
    expect(await makeArtifactAppPermissionsCaller(() => undefined)({ action: "get" })).toBeNull();
    let fail = true;
    const call = makeArtifactAppPermissionsCaller(() => async () => {
      if (fail) throw new Error("ipc failed");
      return state("version-1");
    });
    expect(await call({ action: "get" })).toBeNull();
    fail = false;
    expect(await call({ action: "get" })).toEqual(state("version-1"));
  });
});
