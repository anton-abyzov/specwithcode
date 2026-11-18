// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CONNECT_SESSION_EXPIRY_SKEW_MS,
  CONNECT_SESSION_RECORD_KEY,
  clearConnectRenewStarted,
  clearConnectSessionRecord,
  keepsConnectMachinesAtSignOut,
  keptConnectMachinesBelongToAnother,
  markConnectRenewStarted,
  readConnectSessionRecord,
  writeConnectSessionRecord,
} from "./connectSessionRecord";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 18, 16, 38);

afterEach(() => clearConnectSessionRecord());

describe("which sign-outs keep the machines reached through Connect (1417, AC-16)", () => {
  it("keeps them once the sign-in ran out", () => {
    const record = { accountId: "user-1", expireAt: NOW - 1 };
    expect(keepsConnectMachinesAtSignOut(record, NOW)).toBe(true);
  });

  it("allows Clerk a minute of clock skew before expireAt", () => {
    const record = { accountId: "user-1", expireAt: NOW + CONNECT_SESSION_EXPIRY_SKEW_MS - 1 };
    expect(keepsConnectMachinesAtSignOut(record, NOW)).toBe(true);
  });

  it("removes them when the session ends early: a person's sign-out or a revoked session", () => {
    const record = { accountId: "user-1", expireAt: NOW + 3 * HOUR };
    expect(keepsConnectMachinesAtSignOut(record, NOW)).toBe(false);
  });

  it("keeps them while the person renews, whenever that happens", () => {
    const record = { accountId: "user-1", expireAt: NOW + 3 * HOUR, renewStartedAt: NOW };
    expect(keepsConnectMachinesAtSignOut(record, NOW)).toBe(true);
  });

  it("removes them when the window has no record", () => {
    expect(keepsConnectMachinesAtSignOut(null, NOW)).toBe(false);
  });

  it("removes kept machines before another account's session starts", () => {
    const record = { accountId: "user-1", expireAt: NOW - 1 };
    expect(keptConnectMachinesBelongToAnother(record, "user-2")).toBe(true);
    expect(keptConnectMachinesBelongToAnother(record, "user-1")).toBe(false);
    expect(keptConnectMachinesBelongToAnother(null, "user-2")).toBe(false);
  });
});

describe("the stored record", () => {
  it("round-trips and marks a renew only for the same account", () => {
    writeConnectSessionRecord({ accountId: "user-1", expireAt: NOW });
    expect(markConnectRenewStarted("user-2", NOW, NOW)).toBe(false);
    expect(readConnectSessionRecord()).toEqual({ accountId: "user-1", expireAt: NOW });
    expect(markConnectRenewStarted("user-1", NOW, NOW + 5)).toBe(true);
    expect(readConnectSessionRecord()).toEqual({
      accountId: "user-1",
      expireAt: NOW,
      renewStartedAt: NOW + 5,
    });
  });

  it("writes the record for a renew when there is none, and refuses without a known end", () => {
    expect(markConnectRenewStarted("user-1", null, NOW)).toBe(false);
    expect(readConnectSessionRecord()).toBeNull();
    expect(markConnectRenewStarted("user-1", NOW + HOUR, NOW)).toBe(true);
    expect(readConnectSessionRecord()).toEqual({
      accountId: "user-1",
      expireAt: NOW + HOUR,
      renewStartedAt: NOW,
    });
  });

  it("undoes a renew whose sign-out failed", () => {
    writeConnectSessionRecord({ accountId: "user-1", expireAt: NOW, renewStartedAt: NOW });
    clearConnectRenewStarted("user-1");
    expect(readConnectSessionRecord()).toEqual({ accountId: "user-1", expireAt: NOW });
  });

  it("reads a damaged record as none", () => {
    window.localStorage.setItem(CONNECT_SESSION_RECORD_KEY, "{not json");
    expect(readConnectSessionRecord()).toBeNull();
    window.localStorage.setItem(CONNECT_SESSION_RECORD_KEY, JSON.stringify({ accountId: "" }));
    expect(readConnectSessionRecord()).toBeNull();
  });
});
