import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentConnectionPresentation } from "@specweave-studio/client-runtime/connection";

import { THIS_MACHINE_BUSY_DESCRIPTION } from "../components/ChatView.logic";
import {
  environmentConnectionStatusText,
  environmentConnectionStatusTitle,
  environmentUnavailableSendToast,
  lastSeenLabel,
  machineDetail,
  machineStatus,
  machineUnavailableTitle,
  reasonNeedsPairing,
  savedMachineStatus,
} from "./machineStatus";

describe("machineStatus", () => {
  it("calls a machine unreachable once an attempt has failed, with the reason", () => {
    expect(machineStatus({ phase: "connected", error: null }, true)).toEqual({
      text: "Connected",
      reason: null,
      retryable: false,
    });
    expect(machineStatus({ phase: "connecting", error: null }, true).text).toBe("Connecting…");
    expect(
      machineStatus(
        { phase: "reconnecting", error: "M1 could not establish a WebSocket connection." },
        true,
      ),
    ).toEqual({
      text: "Can't reach. Retrying automatically",
      reason: "M1 could not establish a WebSocket connection.",
      retryable: true,
    });
    expect(machineStatus({ phase: "error", error: "Sign in again." }, true)).toEqual({
      text: "Connection failed",
      reason: "Sign in again.",
      retryable: true,
    });
    expect(machineStatus({ phase: "available", error: null }, true).retryable).toBe(false);
    expect(machineStatus({ phase: "connected", error: null }, false).text).toMatch(/Permission/);
  });
});

describe("machineStatus for this machine", () => {
  const STALL =
    "Environment endpoint http://127.0.0.1:8319/.well-known/studio/environment timed out after 10000ms.";

  it("says it is catching up, without a reason or a failure retry, while its server is busy", () => {
    for (const phase of ["connecting", "reconnecting", "offline"] as const) {
      expect(machineStatus({ phase, error: STALL }, true, true)).toEqual({
        text: "Catching up…",
        reason: null,
        retryable: false,
      });
    }
  });

  it("keeps Connection failed only for a stopped connection", () => {
    expect(machineStatus({ phase: "error", error: "Sign in again." }, true, true)).toEqual({
      text: "Connection failed",
      reason: "Sign in again.",
      retryable: true,
    });
    expect(machineStatus({ phase: "connected", error: null }, true, true).text).toBe("Connected");
  });

  it("still calls another machine unreachable", () => {
    expect(machineStatus({ phase: "reconnecting", error: STALL }, true, false).text).toBe(
      "Can't reach. Retrying automatically",
    );
  });
});

describe("machineUnavailableTitle", () => {
  it("never says this machine can't be reached or is offline", () => {
    for (const phase of ["connecting", "reconnecting", "offline", "available"] as const) {
      const title = machineUnavailableTitle("Anton's MacBook M4MAX", { phase, error: "x" }, true);
      expect(title).toBe("SpecWithCode on this Mac is busy");
    }
    const failed = machineUnavailableTitle("M4", { phase: "error", error: null }, true);
    expect(failed).toMatch(/failed/);
    expect(failed).not.toMatch(/Can't reach|offline/);
  });

  it("keeps today's titles for another machine", () => {
    expect(machineUnavailableTitle("M1", { phase: "reconnecting", error: "x" })).toBe(
      "Can't reach M1",
    );
    expect(machineUnavailableTitle("M1", { phase: "offline", error: null })).toBe(
      "This device is offline",
    );
  });
});

describe("savedMachineStatus", () => {
  it("reads Catching up for this machine and Can't reach for another", () => {
    const connection = { phase: "reconnecting", error: "timed out" } as const;
    expect(savedMachineStatus(connection, true, true)).toEqual({
      text: "Catching up",
      tone: "muted",
      reason: null,
      retryable: false,
    });
    expect(savedMachineStatus(connection, true, false)).toEqual({
      text: "Can't reach",
      tone: "error",
      reason: "timed out",
      retryable: true,
    });
    expect(savedMachineStatus({ phase: "offline", error: null }, true, true).text).toBe(
      "Catching up",
    );
    expect(savedMachineStatus({ phase: "error", error: null }, true, true)).toEqual({
      text: "Connection failed",
      tone: "error",
      reason: null,
      retryable: true,
    });
    expect(savedMachineStatus(connection, false, true).text).toBe("Off");
  });
  it("keeps the status short and returns the reason apart", () => {
    const reason =
      "Approve this device again in SpecWithCode. Create a new pairing code on the receiving machine and sign in again.";
    const status = savedMachineStatus({ phase: "error", error: reason }, true, false);
    expect(status.text).toBe("Connection failed");
    expect(status.reason).toBe(reason);
  });
});

describe("reasonNeedsPairing", () => {
  it("is true only when the machine wants this device paired again", () => {
    expect(
      reasonNeedsPairing(
        "Approve this device again in SpecWithCode. Create a new pairing code on the receiving machine and sign in again.",
      ),
    ).toBe(true);
    expect(reasonNeedsPairing("Failed to fetch environment endpoint")).toBe(false);
    expect(reasonNeedsPairing(null)).toBe(false);
  });
});

describe("lastSeenLabel", () => {
  it("says how long ago a machine was last connected", () => {
    const now = Date.parse("2026-10-17T18:00:00Z");
    expect(lastSeenLabel(null, now)).toBeNull();
    expect(lastSeenLabel(now - 20_000, now)).toBe("last seen just now");
    expect(lastSeenLabel(now - 2 * 3_600_000, now)).toBe("last seen 2h ago");
  });
});

describe("machineDetail", () => {
  it("puts last seen before a long reason so truncation keeps it", () => {
    expect(machineDetail("last seen 1m ago", "Failed to fetch environment endpoint")).toBe(
      "last seen 1m ago · Failed to fetch environment endpoint",
    );
    expect(machineDetail(null, "Sign in again.")).toBe("Sign in again.");
    expect(machineDetail("last seen 2h ago", null)).toBe("last seen 2h ago");
    expect(machineDetail(null, null)).toBe("");
  });
});

describe("this Mac in pickers and settings panels", () => {
  const reconnecting = {
    phase: "reconnecting",
    error: "Test environment stopped responding.",
  } as EnvironmentConnectionPresentation;

  it("reads Catching up instead of a failure while its server is busy", () => {
    expect(environmentConnectionStatusText(reconnecting, true)).toBe("Catching up…");
    expect(environmentConnectionStatusTitle(reconnecting, true)).toBe("Catching up…");
    expect(machineStatus(reconnecting, true, true).text).toBe("Catching up…");
  });

  it("keeps the failure text for another machine", () => {
    expect(environmentConnectionStatusText(reconnecting, false)).toBe(
      "Failed to connect. Reconnecting... Reason: Test environment stopped responding.",
    );
    expect(environmentConnectionStatusTitle(reconnecting, false)).toBe(
      "Failed to connect. Reconnecting...",
    );
  });
});

describe("a send refused while the machine is not connected", () => {
  it("tells this Mac's user the draft is kept, without promising a queue", () => {
    const toast = environmentUnavailableSendToast({
      label: "Anton's MacBook",
      isThisMachineCatchingUp: true,
      continueOn: null,
    });
    expect(toast.title).toBe("SpecWithCode on this Mac is busy: not sent yet");
    expect(toast.description).toBe(
      "Your message stays in the composer. Send it once it catches up.",
    );
    // Nothing queues a refused send, and this Mac is never "back" from anywhere.
    for (const text of [toast.description, THIS_MACHINE_BUSY_DESCRIPTION]) {
      expect(text).not.toMatch(/messages send|is back/i);
    }
  });

  it("keeps the waiting text for another machine", () => {
    expect(
      environmentUnavailableSendToast({
        label: "M1",
        isThisMachineCatchingUp: false,
        continueOn: "M3",
      }),
    ).toEqual({
      title: "Waiting for M1: not sent yet",
      description:
        "Your message stays in the composer. Send it once M1 is back, or continue on M3.",
    });
  });
});
