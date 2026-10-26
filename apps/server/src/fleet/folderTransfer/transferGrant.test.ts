import { describe, expect, it } from "vite-plus/test";

import {
  bearerToken,
  mintTransferGrant,
  revokeTransferGrant,
  TRANSFER_GRANT_IDLE_MS,
  TRANSFER_GRANT_MAX_MS,
  transferGrantExpiresAt,
  verifyTransferGrant,
} from "./transferGrant.ts";

const operationId = "019a0000-0000-7000-8000-000000000001";
const minted = () =>
  mintTransferGrant({
    operationId,
    root: "/Users/test/Projects/umbrella",
    projectId: "project-1",
    destinationEnvironmentId: "env-destination",
    now: 1_000,
  });

describe("transfer grant", () => {
  it("stores only a hash and accepts the exact token for its operation", () => {
    const { token, record } = minted();
    expect(token).toMatch(/^swcft_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(record)).not.toContain(token.slice(6));
    const ok = verifyTransferGrant(record, { operationId, token, now: 2_000 });
    expect(ok).toEqual({ ok: true, record: { ...record, lastUsedAt: 2_000 } });
  });

  it("refuses a missing, wrong, other-operation, revoked or expired bearer", () => {
    const { token, record } = minted();
    expect(verifyTransferGrant(record, { operationId, token: null, now: 2_000 })).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(verifyTransferGrant(record, { operationId, token: `${token}x`, now: 2_000 })).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(verifyTransferGrant(null, { operationId, token, now: 2_000 })).toEqual({
      ok: false,
      reason: "operation",
    });
    expect(
      verifyTransferGrant(record, {
        operationId: "019a0000-0000-7000-8000-000000000002",
        token,
        now: 2_000,
      }),
    ).toEqual({ ok: false, reason: "operation" });
    const revoked = revokeTransferGrant(record, "copy committed", 3_000);
    expect(verifyTransferGrant(revoked, { operationId, token, now: 3_001 })).toEqual({
      ok: false,
      reason: "revoked",
    });
    expect(
      verifyTransferGrant(record, { operationId, token, now: 1_000 + TRANSFER_GRANT_IDLE_MS }),
    ).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("accepts a grant revoked by its commit only for a repeated commit", () => {
    const { token, record } = minted();
    const committed = revokeTransferGrant(record, "committed", 3_000);
    expect(
      verifyTransferGrant(committed, { operationId, token, now: 3_001, revokedFor: "committed" }),
    ).toMatchObject({ ok: true });
    expect(verifyTransferGrant(committed, { operationId, token, now: 3_001 })).toEqual({
      ok: false,
      reason: "revoked",
    });
    const released = revokeTransferGrant(record, "released", 3_000);
    expect(
      verifyTransferGrant(released, { operationId, token, now: 3_001, revokedFor: "committed" }),
    ).toEqual({ ok: false, reason: "revoked" });
    expect(
      verifyTransferGrant(committed, {
        operationId,
        token: `${token}x`,
        now: 3_001,
        revokedFor: "committed",
      }),
    ).toEqual({ ok: false, reason: "invalid" });
    // Undo may ask weeks later, past the idle and lifetime limits.
    expect(
      verifyTransferGrant(committed, {
        operationId,
        token,
        now: 3_000 + TRANSFER_GRANT_MAX_MS * 3,
        revokedFor: "committed",
      }),
    ).toMatchObject({ ok: true });
  });

  it("slides with use but never past the hard limit", () => {
    const { record } = minted();
    let current = record;
    for (let day = 1; day <= 8; day += 1)
      current = { ...current, lastUsedAt: 1_000 + day * (TRANSFER_GRANT_IDLE_MS - 1) };
    expect(transferGrantExpiresAt(current)).toBe(1_000 + TRANSFER_GRANT_MAX_MS);
  });

  it("parses only bearer authorization", () => {
    expect(bearerToken("Bearer swcft_abc")).toBe("swcft_abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});
