// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off -- drives the plain relay hub with a fake extension.
import { describe, expect, it, vi } from "vite-plus/test";

import { newReceivingKey } from "../fleet/fileTransfer/seal.ts";
import { connectFake, setup } from "./fakeChrome.testkit.ts";
import { signInError } from "./BrowserExtension.ts";
import { signInRequestId, SignInRequests } from "./signInRequests.ts";

function start(options: { startMs?: number } = {}) {
  const { extension, token } = setup();
  const fake = connectFake(extension, token);
  const requests = new SignInRequests(extension.hub, options);
  return { fake, requests, viewer: newReceivingKey() };
}

const ask = (requests: SignInRequests, clientRequestId = "square-1") =>
  requests.ask({
    threadId: "thread-a",
    clientRequestId,
    url: "https://app.squareup.com/login",
  });

describe("sign-in requests (1488)", () => {
  it("keys a request by thread and id, and refuses the same id for another page", () => {
    const { requests } = start();
    const first = ask(requests);
    expect(first).toEqual({
      requestId: signInRequestId("thread-a", "square-1"),
      origin: "https://app.squareup.com",
      allowed: false,
      outcome: null,
    });
    expect(ask(requests).requestId).toBe(first.requestId);
    expect(signInRequestId("thread-b", "square-1")).not.toBe(first.requestId);
    expect(() =>
      requests.ask({
        threadId: "thread-a",
        clientRequestId: "square-1",
        url: "https://evil.test/",
      }),
    ).toThrow(/another page/);
    expect(() =>
      requests.ask({ threadId: "thread-a", clientRequestId: "x", url: "http://app.squareup.com" }),
    ).toThrow(/https/);
    requests.allow(first.requestId);
    expect(ask(requests).allowed).toBe(true);
  });

  it("opens one view per request, on one device, at the page the agent asked for", async () => {
    const { requests, viewer, fake } = start();
    const { requestId } = ask(requests);
    const opening = requests.start(requestId, viewer.publicKey);
    await expect(requests.start(requestId, newReceivingKey().publicKey)).rejects.toThrow(
      /already open on another device/,
    );
    const started = await opening;
    expect(started.origin).toBe("https://app.squareup.com");
    const navigate = fake.calls.find(
      (call) => call.method === "chrome.debugger.sendCommand" && call.params[1] === "Page.navigate",
    );
    expect(navigate?.params[2]).toEqual({ url: "https://app.squareup.com/login" });
    await expect(requests.start("sign-in-unknown", viewer.publicKey)).rejects.toThrow(
      /does not exist/,
    );
    expect((await requests.frame(started.viewId)).sealed).toEqual(expect.any(String));
  });

  it("tells the waiting agent how the view ended, and the viewer too", async () => {
    const { requests, viewer } = start();
    const { requestId } = ask(requests);
    expect(await requests.waitForEnd(requestId, 5)).toBeNull();
    const started = await requests.start(requestId, viewer.publicKey);
    const waiting = requests.waitForEnd(requestId, 60_000);
    await requests.end(started.viewId, "done");
    expect(await waiting).toBe("done");
    expect(await requests.frame(started.viewId)).toEqual({ ended: "done" });
    expect(ask(requests).outcome).toBe("done");
    await expect(requests.start(requestId, viewer.publicKey)).rejects.toThrow(/has ended/);
  });

  it("ends as declined when the person says Not now, and cancels an open view", async () => {
    const { requests, viewer } = start();
    const declined = ask(requests, "a");
    requests.decline(declined.requestId, "declined");
    expect(await requests.waitForEnd(declined.requestId, 5)).toBe("declined");

    const open = ask(requests, "b");
    await requests.start(open.requestId, viewer.publicKey);
    const waiting = requests.waitForEnd(open.requestId, 60_000);
    requests.decline(open.requestId, "declined");
    expect(await waiting).toBe("cancelled");
  });

  it("expires a request nobody opened", async () => {
    vi.useFakeTimers();
    try {
      const { requests } = start({ startMs: 1_000 });
      const { requestId } = ask(requests);
      const waiting = requests.waitForEnd(requestId, 60_000);
      vi.advanceTimersByTime(1_001);
      expect(await waiting).toBe("expired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a view that finished opening after its request ended", async () => {
    const { requests, viewer, fake } = start();
    const { requestId } = ask(requests);
    const opening = requests.start(requestId, viewer.publicKey);
    requests.decline(requestId, "declined");
    await expect(opening).rejects.toThrow(/has ended/);
    const removed = fake.calls.filter((call) => call.method === "chrome.tabs.remove");
    expect(removed.length).toBe(1);
  });

  it("maps errors to fixed reasons, never the text the person typed", () => {
    expect(signInError(new Error("secret hunter2")).reason).toBe(
      "Chrome did not answer. Try again.",
    );
  });
});
