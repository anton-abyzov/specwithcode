import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasPendingRequest,
  newerRequestPending,
  newestWritten,
  withdrawnAfterRequest,
} from "./serviceUpdateAgent";
import type { ServiceUpdateProgress } from "./sidebar/SidebarRestartToUpdate.logic";

// How a window reads the update agent's state for the request it waits on:
// withdrawn since it was written, or overtaken by a newer one.

const iso = (ms: number) => new Date(ms).toISOString();
const REQUESTED_AT = Date.parse("2026-10-21T08:00:00.000Z");
const HOLD_MS = 15 * 60_000;

const waiting: StudioServiceUpdateState = {
  status: "waiting-for-quiet",
  identity: "m4",
  installedVersion: "0.2.4",
  availableVersion: "0.2.5",
  downloadedVersion: "0.2.5",
  checkedAt: null,
  quietSince: null,
  message: null,
  lastInstall: null,
  updatedAt: iso(REQUESTED_AT + 500),
};

/** A forced request the desktop reports, written at `requestedAt` with the hold it was given. */
function pending(requestedAt: number, holdUntil = requestedAt + HOLD_MS) {
  return {
    requestedAt: iso(requestedAt),
    mode: "force" as const,
    version: "0.2.5",
    holdUntil: iso(holdUntil),
    handled: false,
  };
}

const waitingOnRequest: ServiceUpdateProgress = {
  phase: "waiting",
  targetVersion: "0.2.5",
  blockers: [],
  message: null,
  requestedAt: REQUESTED_AT,
  holdUntil: REQUESTED_AT + HOLD_MS,
};

describe("hasPendingRequest", () => {
  it("reads a state that names no request as none pending", () => {
    expect(hasPendingRequest({ ...waiting, pendingInstall: pending(REQUESTED_AT) })).toBe(true);
    expect(hasPendingRequest({ ...waiting, pendingInstall: null })).toBe(false);
    // The desktop this renderer ships with names one, or null; no field is none.
    expect(hasPendingRequest(waiting)).toBe(false);
  });
});

describe("withdrawnAfterRequest", () => {
  const now = REQUESTED_AT + 60_000;
  const none = { ...waiting, pendingInstall: null };

  it("says so once a state written since the request reports none pending", () => {
    expect(withdrawnAfterRequest(none, waitingOnRequest, now)).toBe(true);
    expect(withdrawnAfterRequest(waiting, waitingOnRequest, now)).toBe(true);
    const still = { ...waiting, pendingInstall: pending(REQUESTED_AT) };
    expect(withdrawnAfterRequest(still, waitingOnRequest, now)).toBe(false);
  });

  it("takes no state written before the request, or unknown when, for its answer", () => {
    const before = { ...none, updatedAt: iso(REQUESTED_AT - 1_000) };
    expect(withdrawnAfterRequest(before, waitingOnRequest, now)).toBe(false);
    const { updatedAt: _written, ...unknown } = none;
    expect(withdrawnAfterRequest(unknown, waitingOnRequest, now)).toBe(false);
  });

  it("leaves a request whose hold ran out, or one no longer waited on, alone", () => {
    expect(withdrawnAfterRequest(none, waitingOnRequest, REQUESTED_AT + HOLD_MS)).toBe(false);
    const installing = { ...waitingOnRequest, phase: "installing" as const };
    expect(withdrawnAfterRequest(none, installing, now)).toBe(false);
    expect(withdrawnAfterRequest(none, null, now)).toBe(false);
  });

  it("goes by the request the desktop reports, not the agent's own words", () => {
    const cancelled = { ...waiting, status: "downloaded" as const, message: "Update cancelled" };
    const pressedAgain = { ...cancelled, pendingInstall: pending(REQUESTED_AT + 30_000) };
    expect(withdrawnAfterRequest(pressedAgain, waitingOnRequest, now)).toBe(false);
  });
});

describe("newerRequestPending", () => {
  it("does not take the same request, asked again under its hold, for a newer one", () => {
    const askedAgain = {
      ...waiting,
      pendingInstall: pending(REQUESTED_AT + 30_000, REQUESTED_AT + HOLD_MS),
    };
    expect(newerRequestPending(askedAgain, waitingOnRequest)).toBe(false);
  });

  it("takes a later request with a hold of its own for a newer one", () => {
    const pressedAgain = { ...waiting, pendingInstall: pending(REQUESTED_AT + 30_000) };
    expect(newerRequestPending(pressedAgain, waitingOnRequest)).toBe(true);
  });

  it("finds none newer in no request, or in the one waited on", () => {
    expect(newerRequestPending({ ...waiting, pendingInstall: null }, waitingOnRequest)).toBe(false);
    expect(newerRequestPending(waiting, waitingOnRequest)).toBe(false);
    const same = { ...waiting, pendingInstall: pending(REQUESTED_AT) };
    expect(newerRequestPending(same, waitingOnRequest)).toBe(false);
    // One written before the request waited on, whatever its hold.
    const older = { ...waiting, pendingInstall: pending(REQUESTED_AT - 30_000) };
    expect(newerRequestPending(older, waitingOnRequest)).toBe(false);
  });
});

describe("newestWritten", () => {
  it("keeps the first of two states written at the same time", () => {
    const seen = { ...waiting, message: "Waiting for a quiet moment" };
    const read = { ...waiting, message: null };
    expect(newestWritten([seen, read])).toBe(seen);
    expect(newestWritten([read, seen])).toBe(read);
  });
});
