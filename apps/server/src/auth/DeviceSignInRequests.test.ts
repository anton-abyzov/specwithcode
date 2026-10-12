import { describe, expect, it } from "vite-plus/test";

import {
  DEVICE_SIGN_IN_APPROVED_TTL_MS,
  DeviceSignInRequests,
  normalizeDeviceSignInCode,
} from "./DeviceSignInRequests.ts";

const phone = {
  deviceType: "mobile",
  browser: "Safari",
  os: "iOS",
  ipAddress: "127.0.0.1",
  origin: "https://m4.example.ts.net",
  source: "100.64.0.7",
};

function store(options: { maxPending?: number; maxPendingPerSource?: number } = {}) {
  let now = 1_000_000;
  const requests = new DeviceSignInRequests({ now: () => now, ttlMs: 60_000, ...options });
  return { requests, advance: (ms: number) => (now += ms) };
}

function started(requests: DeviceSignInRequests, source = phone.source) {
  const outcome = requests.start({ ...phone, source });
  if (!outcome.ok) throw new Error("expected a request");
  return outcome;
}

describe("DeviceSignInRequests", () => {
  it("finds a request only by its typed code and gives the credential once, to the poll token holder", () => {
    const { requests } = store();
    const request = started(requests);
    expect(request.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(requests.poll(request.requestId, request.pollToken)).toEqual({ status: "pending" });

    const typed = `${request.code.slice(0, 3).toLowerCase()}-${request.code.slice(3)}`;
    expect(requests.pendingByCode(typed)).toEqual(
      expect.objectContaining({ requestId: request.requestId, browser: "Safari" }),
    );
    expect(requests.pendingByCode("222222" === request.code ? "333333" : "222222")).toBeNull();

    expect(requests.approve(request.requestId, { id: "link-1", credential: "ONE-TIME" })).toBe(
      true,
    );
    expect(requests.pendingByCode(request.code)).toBeNull();
    expect(requests.approve(request.requestId, { id: "link-2", credential: "AGAIN" })).toBe(false);
    expect(requests.poll(request.requestId, "x".repeat(43))).toEqual({ status: "expired" });
    expect(requests.poll(request.requestId, request.pollToken)).toEqual({
      status: "approved",
      credential: "ONE-TIME",
    });
    expect(requests.poll(request.requestId, request.pollToken)).toEqual({ status: "expired" });
  });

  it("expires unanswered requests and uncollected approvals", () => {
    const { requests, advance } = store();
    const unanswered = started(requests);
    advance(60_000);
    expect(requests.poll(unanswered.requestId, unanswered.pollToken)).toEqual({
      status: "expired",
    });
    expect(requests.pendingByCode(unanswered.code)).toBeNull();
    expect(requests.approve(unanswered.requestId, { id: "l", credential: "C" })).toBe(false);

    const approved = started(requests);
    requests.approve(approved.requestId, { id: "l", credential: "C" });
    advance(DEVICE_SIGN_IN_APPROVED_TTL_MS);
    expect(requests.poll(approved.requestId, approved.pollToken)).toEqual({ status: "expired" });
  });

  it("caps pending requests per source, so one address cannot lock others out", () => {
    const { requests, advance } = store({ maxPending: 5, maxPendingPerSource: 2 });
    started(requests, "100.64.0.9");
    const second = started(requests, "100.64.0.9");
    expect(requests.start({ ...phone, source: "100.64.0.9" })).toEqual({
      ok: false,
      reason: "too-many-pending",
    });
    expect(requests.start({ ...phone, source: "100.64.0.7" }).ok).toBe(true);
    requests.approve(second.requestId, { id: "l", credential: "C" });
    expect(requests.start({ ...phone, source: "100.64.0.9" }).ok).toBe(true);
    advance(60_000);
    expect(requests.start({ ...phone, source: "100.64.0.9" }).ok).toBe(true);
  });

  it("caps pending requests overall", () => {
    const { requests } = store({ maxPending: 2, maxPendingPerSource: 5 });
    started(requests, "a");
    started(requests, "b");
    expect(requests.start({ ...phone, source: "c" })).toEqual({
      ok: false,
      reason: "too-many-pending",
    });
  });

  it("gives pending requests distinct codes", () => {
    const { requests } = store({ maxPending: 50, maxPendingPerSource: 50 });
    const codes = new Set(Array.from({ length: 50 }, () => started(requests).code));
    expect(codes.size).toBe(50);
  });

  it("reads a typed code the way people write it", () => {
    expect(normalizeDeviceSignInCode("abc-def")).toBe("ABCDEF");
    expect(normalizeDeviceSignInCode(" ABC DEF ")).toBe("ABCDEF");
  });
});
