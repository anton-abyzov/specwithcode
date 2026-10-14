import { describe, expect, it } from "@effect/vitest";
import { AuthSessionId, AuthStandardClientScopes } from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { AuthSessionRecord } from "../persistence/AuthSessions.ts";
import { authorizeManagedUpdate, freshManagedUpdateAuthority } from "./ManagedUpdatesAuthority.ts";

const now = Date.parse("2026-10-14T18:00:00Z");
const connected = { sessionId: AuthSessionId.make("controller"), subject: "client" };
const record = (patch: Partial<AuthSessionRecord> = {}): AuthSessionRecord => ({
  ...connected,
  method: "bearer-access-token",
  scopes: ["access:write", "environment:maintain"],
  issuedAt: DateTime.makeUnsafe(now - 60000),
  expiresAt: DateTime.makeUnsafe(now + 60000),
  revokedAt: null,
  lastConnectedAt: null,
  client: {
    label: "Owner",
    deviceType: "desktop",
    ipAddress: null,
    userAgent: null,
    os: null,
    browser: null,
  },
  ...patch,
});
describe("managed update destination authority", () => {
  it("rejects ordinary pairing and spoofed owner metadata", () => {
    expect(() =>
      authorizeManagedUpdate(
        connected,
        "enroll",
        record({ scopes: [...AuthStandardClientScopes] }),
        now,
      ),
    ).toThrow();
    for (const scopes of [[], ["access:write"], ["environment:maintain"]] as const)
      expect(() => authorizeManagedUpdate(connected, "revoke", record({ scopes }), now)).toThrow();
  });
  it("requires the current persisted identity and unexpired unrevoked grant", () => {
    for (const invalid of [
      null,
      record({ revokedAt: DateTime.makeUnsafe(now) }),
      record({ expiresAt: DateTime.makeUnsafe(now) }),
      record({ subject: "other" }),
      record({ sessionId: AuthSessionId.make("other") }),
    ])
      expect(() => authorizeManagedUpdate(connected, "enroll", invalid, now)).toThrow();
    expect(authorizeManagedUpdate(connected, "enroll", record(), now).sessionId).toBe(
      connected.sessionId,
    );
  });
  it.effect("re-reads authority for each call, so revocation after connection takes effect", () =>
    Effect.gen(function* () {
      let current = record({ expiresAt: DateTime.makeUnsafe("2100-01-01") });
      let reads = 0;
      const read = () =>
        Effect.sync(() => {
          reads++;
          return Option.some(current);
        });
      yield* freshManagedUpdateAuthority(connected, "enroll", read);
      current = { ...current, revokedAt: DateTime.makeUnsafe(now) };
      expect(
        (yield* freshManagedUpdateAuthority(connected, "enroll", read).pipe(Effect.flip)).code,
      ).toBe("unauthorized");
      expect(reads).toBe(2);
    }),
  );
});
