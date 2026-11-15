import { describe, expect, it } from "@effect/vitest";

import { ConnectionBlockedError, ConnectionTransientError } from "./model.ts";
import type { EnvironmentConnectionPresentation } from "./presentation.ts";
import {
  connectionLossCause,
  isMachineReachDown,
  machineReach,
  RECONNECT_GRACE_MS,
  type MachineReachState,
} from "./reach.ts";

const LOST_AT = 1_000_000;
const INSIDE = LOST_AT + RECONNECT_GRACE_MS - 1;
const AFTER = LOST_AT + RECONNECT_GRACE_MS;

function connection(
  overrides: Partial<EnvironmentConnectionPresentation>,
): EnvironmentConnectionPresentation {
  return { phase: "reconnecting", error: null, traceId: null, ...overrides };
}

const state = (overrides: Partial<EnvironmentConnectionPresentation>, now: number) =>
  machineReach(connection(overrides), now).state;

describe("connectionLossCause", () => {
  const transient = (
    reason: ConnectionTransientError["reason"],
    extra: { readonly machineOffline?: boolean; readonly relayUnreachable?: boolean } = {},
  ) => new ConnectionTransientError({ reason, detail: "failed", ...extra });

  it("reads a silent service, a dropped session and a failed health check as not answering", () => {
    for (const reason of ["timeout", "transport", "network", "remote-unavailable"] as const) {
      expect(connectionLossCause(transient(reason), "online")).toBe("not-answering");
    }
    // The relay answered with a failure of its own: it was reached.
    expect(connectionLossCause(transient("relay-unavailable"), "online")).toBe("not-answering");
  });

  it("reads an address with no service behind it as no service", () => {
    expect(connectionLossCause(transient("endpoint-unavailable"), "online")).toBe("no-service");
    expect(
      connectionLossCause(transient("endpoint-unavailable", { machineOffline: true }), "online"),
    ).toBe("no-service");
  });

  it("reads a relay that gave no answer as relay unreachable, whatever the reason", () => {
    for (const reason of ["timeout", "relay-unavailable"] as const) {
      expect(connectionLossCause(transient(reason, { relayUnreachable: true }), "online")).toBe(
        "relay-unreachable",
      );
    }
  });

  it("puts a device with no network before any failure", () => {
    expect(connectionLossCause(transient("timeout"), "offline")).toBe("no-network");
    expect(connectionLossCause(null, "offline")).toBe("no-network");
  });

  it("reads a refusal as stopped, and no failure as no cause", () => {
    expect(
      connectionLossCause(
        new ConnectionBlockedError({ reason: "authentication", detail: "Sign in again." }),
        "online",
      ),
    ).toBe("stopped");
    expect(connectionLossCause(null, "online")).toBeUndefined();
    expect(connectionLossCause(null, "unknown")).toBeUndefined();
  });
});

describe("machineReach", () => {
  it("reads reconnecting for the whole grace, whatever the cause", () => {
    for (const cause of ["not-answering", "no-service", "relay-unreachable"] as const) {
      const lost = { lostAt: LOST_AT, lastConnectedAt: LOST_AT, cause };
      expect(state(lost, LOST_AT)).toBe("reconnecting");
      expect(state(lost, INSIDE)).toBe("reconnecting");
      expect(machineReach(connection(lost), INSIDE).graceEndsAt).toBe(AFTER);
    }
    // A device with no network is not called offline either while it may be a blip.
    expect(
      state(
        { phase: "offline", lostAt: LOST_AT, lastConnectedAt: LOST_AT, cause: "no-network" },
        INSIDE,
      ),
    ).toBe("reconnecting");
  });

  it("words the outage by its cause once the grace is over", () => {
    const after = (cause: EnvironmentConnectionPresentation["cause"]) =>
      state({ lostAt: LOST_AT, lastConnectedAt: LOST_AT, ...(cause ? { cause } : {}) }, AFTER);
    expect(after("not-answering")).toBe("not-answering");
    expect(after("no-service")).toBe("offline");
    expect(after("relay-unreachable")).toBe("cant-reach");
    expect(after("no-network")).toBe("no-network");
    // No attempt has failed yet: all that is known is the silence.
    expect(after(undefined)).toBe("not-answering");
    expect(machineReach(connection({ lostAt: LOST_AT }), AFTER).graceEndsAt).toBeNull();
  });

  it("does not change with the attempt that is running", () => {
    // An explicit retry starts over as a first attempt with no error; a
    // backoff and a running attempt differ only in phase and error.
    const variants: ReadonlyArray<Partial<EnvironmentConnectionPresentation>> = [
      { phase: "reconnecting", error: "No answer.", retryAt: AFTER + 30_000 },
      { phase: "reconnecting", error: "No answer." },
      { phase: "connecting", error: null },
    ];
    for (const now of [INSIDE, AFTER, AFTER + 600_000]) {
      const states = variants.map((variant) =>
        state(
          { lostAt: LOST_AT, lastConnectedAt: LOST_AT, cause: "not-answering", ...variant },
          now,
        ),
      );
      expect(new Set(states).size).toBe(1);
    }
  });

  it("reads a machine with no session yet in this run as connecting inside the grace", () => {
    expect(state({ phase: "connecting", lostAt: LOST_AT }, INSIDE)).toBe("connecting");
    // Its first attempt failed: still inside the grace, still no outage.
    expect(state({ phase: "reconnecting", lostAt: LOST_AT, cause: "no-service" }, INSIDE)).toBe(
      "connecting",
    );
    expect(state({ phase: "reconnecting", lostAt: LOST_AT, cause: "no-service" }, AFTER)).toBe(
      "offline",
    );
  });

  it("reads a connected machine as connected, or catching up while its list resyncs", () => {
    expect(state({ phase: "connected" }, AFTER)).toBe("connected");
    expect(
      machineReach(connection({ phase: "connected" }), AFTER, { listSyncing: true }).state,
    ).toBe("catching-up");
    // A resync says nothing about a machine without a session.
    expect(
      machineReach(connection({ lostAt: LOST_AT, cause: "no-service" }), AFTER, {
        listSyncing: true,
      }).state,
    ).toBe("offline");
  });

  it("reads a refused or unsupported connection as stopped at once", () => {
    expect(state({ phase: "error", lostAt: LOST_AT, cause: "stopped" }, LOST_AT)).toBe("stopped");
    expect(state({ phase: "unsupported", lostAt: LOST_AT, cause: "stopped" }, LOST_AT)).toBe(
      "stopped",
    );
    // A person asked to try the refused connection again: it is being tried.
    expect(
      state(
        { phase: "connecting", lostAt: LOST_AT, lastConnectedAt: LOST_AT, cause: "stopped" },
        AFTER,
      ),
    ).toBe("reconnecting");
  });

  it("reads a machine nobody asked to connect as not connected", () => {
    expect(state({ phase: "available" }, AFTER)).toBe("not-connected");
  });

  it("judges a connection with no loss time by its phase alone", () => {
    expect(state({ phase: "connecting" }, AFTER)).toBe("connecting");
    expect(state({ phase: "reconnecting", cause: "no-service" }, 0)).toBe("offline");
    expect(state({ phase: "reconnecting" }, 0)).toBe("not-answering");
    expect(state({ phase: "offline" }, 0)).toBe("no-network");
  });
});

describe("isMachineReachDown", () => {
  it("keeps threads in their groups while the machine is connected, catching up or reconnecting", () => {
    const expected: Record<MachineReachState, boolean> = {
      connected: false,
      "catching-up": false,
      connecting: false,
      reconnecting: false,
      "not-answering": true,
      offline: true,
      "cant-reach": true,
      "no-network": true,
      stopped: true,
      "not-connected": true,
    };
    for (const [reach, down] of Object.entries(expected)) {
      expect(isMachineReachDown(reach as MachineReachState)).toBe(down);
    }
  });
});
