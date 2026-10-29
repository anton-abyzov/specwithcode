// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  machineUnavailable,
  machinesSettling,
  moveBlockedReason,
  useMachinesSettling,
} from "./handoffMachineList";

describe("machine list while it loads", () => {
  it("is settling until the catalog answers and while a machine makes its first connection", () => {
    expect(machinesSettling({ catalogReady: false, phases: [] })).toBe(true);
    expect(machinesSettling({ catalogReady: true, phases: ["connected", "connecting"] })).toBe(
      true,
    );
    expect(machinesSettling({ catalogReady: true, phases: ["connected", "disconnected"] })).toBe(
      false,
    );
  });

  it("never calls a connecting machine Connect first", () => {
    expect(machineUnavailable("connected", true)).toBeNull();
    expect(machineUnavailable("connected", false)).toBe("Permission required");
    expect(machineUnavailable("connecting", true)).toBe("Connecting…");
    expect(machineUnavailable("reconnecting", true)).toBe("Connecting…");
    expect(machineUnavailable("disconnected", true)).toBe("Connect first");
    expect(machineUnavailable(undefined, true)).toBe("Connect first");
  });
});

describe("why Move project is off", () => {
  it("names the first thing to fix", () => {
    expect(moveBlockedReason({ connected: false, coordinator: false, permitted: false })).toBe(
      "Connect this machine to hand off this project.",
    );
    expect(moveBlockedReason({ connected: true, coordinator: false, permitted: true })).toBe(
      "Send this project its first message, then you can hand it off.",
    );
    expect(moveBlockedReason({ connected: true, coordinator: true, permitted: false })).toBe(
      "This connection needs permission to hand off projects.",
    );
    expect(moveBlockedReason({ connected: true, coordinator: true, permitted: true })).toBeNull();
  });
});

describe("useMachinesSettling", () => {
  let root: Root;
  let container: HTMLDivElement;
  let seen: boolean[];
  function Probe(props: { open: boolean; settling: boolean }) {
    seen.push(useMachinesSettling(props.open, props.settling, 1000));
    return null;
  }
  const show = (open: boolean, settling: boolean) =>
    act(async () => root.render(<Probe open={open} settling={settling} />));

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    seen = [];
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
  });

  it("shows loading while open and settling, stops at the deadline, and restarts per opening", async () => {
    await show(false, true);
    expect(seen.at(-1)).toBe(false);
    await show(true, true);
    expect(seen.at(-1)).toBe(true);
    await act(async () => vi.advanceTimersByTime(1000));
    expect(seen.at(-1)).toBe(false);
    // A new opening gets its own wait.
    await show(false, true);
    await show(true, true);
    expect(seen.at(-1)).toBe(true);
    // Settled before the deadline: loading ends at once.
    await show(true, false);
    expect(seen.at(-1)).toBe(false);
  });
});
