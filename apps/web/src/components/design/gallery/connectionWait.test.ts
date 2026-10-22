import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { connectionMessage, waitForConnected } from "./connectionWait";

/** A connection whose phase the test moves by hand. */
function source(initial: string | null) {
  let current = initial === null ? null : { phase: initial, error: null as string | null };
  const listeners = new Set<() => void>();
  return {
    read: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(phase: string, error: string | null = null) {
      current = { phase, error };
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("waitForConnected", () => {
  it("resolves at once when the machine is already connected", async () => {
    const machine = source("connected");
    await expect(waitForConnected(machine, 1000)).resolves.toEqual({ ok: true });
    expect(machine.listeners.size).toBe(0);
  });

  it("waits through connecting, then resolves when the session is up", async () => {
    // The race: the dialog renders from the cached shell before the socket connects.
    const machine = source("connecting");
    let settled: unknown = null;
    void waitForConnected(machine, 15_000).then((result) => (settled = result));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBeNull();
    machine.set("reconnecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBeNull();
    machine.set("connected");
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual({ ok: true });
    expect(machine.listeners.size).toBe(0);
  });

  it("gives up after the timeout with a message that says nothing was created", async () => {
    const machine = source("connecting");
    const result = waitForConnected(machine, 15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    const wait = await result;
    expect(wait).toEqual({ ok: false, reason: "timeout", detail: null });
    if (!wait.ok)
      expect(connectionMessage(wait)).toBe(
        "This machine did not connect within 15 seconds. Nothing was created. Try again once it shows as connected.",
      );
  });

  it("stops waiting when the connection fails for good", async () => {
    const machine = source("connecting");
    const result = waitForConnected(machine, 15_000);
    machine.set("error", "The server refused this client");
    const wait = await result;
    expect(wait).toEqual({ ok: false, reason: "failed", detail: "The server refused this client" });
    if (!wait.ok) expect(connectionMessage(wait)).toContain("The server refused this client.");
  });
});
