import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@specweave-studio/contracts";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./providerUsageLimits.ts";
import { codexRateLimitsToLimits, codexRateLimitsToUpdate } from "./codexUsageLimits.ts";
import { nativeQuotaDenied } from "../studio/capacitySnapshot.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("credit-only negative observation", () => {
  const deniedAt = "2026-09-03T12:00:01.000Z";
  const laterAt = "2026-09-03T12:00:02.000Z";
  const previous = {
    ...published,
    nativeAllowanceObservedAt: checkedAt,
    ordinaryUsageAllowed: true,
    spendControlReached: false,
    credits: { hasCredits: true, unlimited: false, balance: "5" },
    quotaPoolId: `codex:sha256:${"a".repeat(64)}`,
    quotaPoolObservedAt: checkedAt,
    nativeRouteVerified: true,
    nativeRouteObservedAt: checkedAt,
  };

  it("withdraws credit permission while preserving included usage and all full-read proof", () => {
    const update = codexRateLimitsToUpdate({ credits: { hasCredits: false } })!;
    const denied = applyUsageLimitsUpdate({ previous, checkedAt: deniedAt, update })!;
    expect(denied.nativeCreditDenialObservedAt).toBe(deniedAt);
    expect(denied.nativeDenialObservedAt).toBeUndefined();
    expect(denied.ordinaryUsageAllowed).toBe(true);
    expect(nativeQuotaDenied(denied, Date.parse(deniedAt))).toBe(false);
    expect(denied).toMatchObject({ ...previous, checkedAt: deniedAt });
    const sparsePositive = codexRateLimitsToUpdate({
      credits: { hasCredits: true, unlimited: true },
      primary: { usedPercent: 0 },
    })!;
    const stillDenied = applyUsageLimitsUpdate({
      previous: denied,
      checkedAt: laterAt,
      update: sparsePositive,
    })!;
    expect(stillDenied.nativeCreditDenialObservedAt).toBe(deniedAt);
    expect(stillDenied.nativeAllowanceObservedAt).toBe(checkedAt);
    expect(stillDenied.quotaPoolObservedAt).toBe(checkedAt);
    expect(stillDenied.nativeRouteObservedAt).toBe(checkedAt);
    expect(stillDenied.credits).toEqual(previous.credits);
  });

  it("records credit denial before any complete read without inventing permission or balance", () => {
    const denied = applyUsageLimitsUpdate({
      previous: undefined,
      checkedAt: deniedAt,
      update: { windows: [], nativeCreditDenied: true },
    })!;
    expect(denied).toEqual({
      checkedAt: deniedAt,
      windows: [],
      nativeCreditDenialObservedAt: deniedAt,
    });
  });

  it.each([
    ["older", checkedAt, checkedAt],
    ["tie", deniedAt, deniedAt],
    ["window-only update", laterAt, checkedAt],
    ["missing full native read", laterAt, undefined],
    ["invalid read timestamp", "invalid", laterAt],
    ["invalid native timestamp", laterAt, "invalid"],
  ])("retains credit withdrawal against %s", (_label, probeAt, fullAt) => {
    const denied = { ...previous, nativeCreditDenialObservedAt: deniedAt };
    const probed = { ...previous, checkedAt: probeAt, nativeAllowanceObservedAt: fullAt };
    expect(resolveUsageLimitsAfterProbe({ published: denied, probed })).toBe(denied);
    expect(resolveUsageLimitsAfterProbe({ published: denied, probed: undefined })).toBe(denied);
  });

  it("cannot roll a credit denial back with an older negative notification", () => {
    const denied = { ...previous, nativeCreditDenialObservedAt: laterAt };
    const older = applyUsageLimitsUpdate({
      previous: denied,
      checkedAt: deniedAt,
      update: { windows: [], nativeCreditDenied: true },
    })!;
    expect(older.nativeCreditDenialObservedAt).toBe(laterAt);
    expect(
      resolveUsageLimitsAfterProbe({
        published: older,
        probed: { ...previous, checkedAt: laterAt, nativeAllowanceObservedAt: laterAt },
      }),
    ).toBe(older);
  });

  it("requires an ordered successful complete native read to restore credit eligibility", () => {
    const denied = { ...previous, nativeCreditDenialObservedAt: deniedAt };
    const failed = {
      checkedAt: laterAt,
      windows: [],
      unavailable: { reason: "probeFailed" as const },
    };
    expect(resolveUsageLimitsAfterProbe({ published: denied, probed: failed })).toBe(denied);
    const full = codexRateLimitsToLimits({
      checkedAt: laterAt,
      ordinaryUsageAllowed: true,
      accountId: "synthetic-native-account",
      snapshot: {
        spendControlReached: false,
        credits: { hasCredits: true, unlimited: false, balance: "5" },
      },
    });
    expect(resolveUsageLimitsAfterProbe({ published: denied, probed: full })).toBe(full);
    expect(full.nativeCreditDenialObservedAt).toBeUndefined();
    const malformed = { ...denied, nativeCreditDenialObservedAt: "invalid" };
    expect(resolveUsageLimitsAfterProbe({ published: malformed, probed: full })).toBe(malformed);
    expect(
      resolveUsageLimitsAfterProbe({
        published: denied,
        probed: {
          ...previous,
          checkedAt,
          nativeAllowanceObservedAt: checkedAt,
          nativeRouteVerified: false,
        },
      }),
    ).toMatchObject({ nativeCreditDenialObservedAt: deniedAt, nativeRouteVerified: false });
  });

  it("requires the complete read to supersede both ordinary and credit withdrawals", () => {
    const denied = {
      ...previous,
      ordinaryUsageAllowed: false,
      nativeDenialObservedAt: deniedAt,
      nativeCreditDenialObservedAt: laterAt,
    };
    const between = { ...previous, checkedAt: laterAt, nativeAllowanceObservedAt: laterAt };
    expect(resolveUsageLimitsAfterProbe({ published: denied, probed: between })).toBe(denied);
    const newer = {
      ...between,
      checkedAt: "2026-09-03T12:00:03.000Z",
      nativeAllowanceObservedAt: "2026-09-03T12:00:03.000Z",
    };
    expect(resolveUsageLimitsAfterProbe({ published: denied, probed: newer })).toBe(newer);
  });

  it("keeps malformed denial fail-closed and leaves unsupported accounts unavailable", () => {
    const malformed = { ...previous, nativeCreditDenialObservedAt: "invalid" };
    expect(
      applyUsageLimitsUpdate({
        previous: malformed,
        checkedAt: laterAt,
        update: { windows: [], nativeCreditDenied: true },
      })?.nativeCreditDenialObservedAt,
    ).toBe("invalid");
    const unsupported = { ...previous, unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({
        previous: unsupported,
        checkedAt: laterAt,
        update: { windows: [], nativeCreditDenied: true },
      }),
    ).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: malformed, probed: unsupported })).toBe(
      unsupported,
    );
  });
});

describe("applyUsageLimitsUpdate", () => {
  it("records metadata-only denial without renewing full permission or window proof", () => {
    const previous = {
      ...published,
      nativeAllowanceObservedAt: checkedAt,
      ordinaryUsageAllowed: true,
      spendControlReached: false,
      credits: { hasCredits: true, unlimited: true },
    };
    const deniedAt = "2026-09-03T12:10:00.000Z";
    const next = applyUsageLimitsUpdate({
      previous,
      checkedAt: deniedAt,
      update: {
        windows: [],
        spendControlReached: true,
        rateLimitReachedType: "workspace_owner_usage_limit_reached",
      },
    });
    expect(next?.nativeDenialObservedAt).toBe(deniedAt);
    expect(next?.nativeAllowanceObservedAt).toBe(checkedAt);
    expect(next?.ordinaryUsageAllowed).toBe(true);
    expect(next?.spendControlReached).toBe(true);
    expect(next?.windows).toEqual(previous.windows);
    expect(next?.credits).toEqual(previous.credits);
    const later = applyUsageLimitsUpdate({
      previous: next,
      checkedAt: "2026-09-03T12:11:00.000Z",
      update: { windows: [{ ...session, usedPercent: 10 }] },
    });
    expect(later?.nativeDenialObservedAt).toBe(deniedAt);
    expect(later?.spendControlReached).toBe(true);
    expect(later?.nativeAllowanceObservedAt).toBe(checkedAt);
  });
  it("publishes an explicit ordinary denial even when all window numbers are unchanged", () => {
    const previous = {
      ...published,
      nativeAllowanceObservedAt: checkedAt,
      ordinaryUsageAllowed: true,
    };
    const next = applyUsageLimitsUpdate({
      previous,
      checkedAt,
      update: { windows: [session], ordinaryUsageAllowed: false },
    });
    expect(next).not.toBe(previous);
    expect(next?.ordinaryUsageAllowed).toBe(false);
    expect(next?.nativeDenialObservedAt).toBe(checkedAt);
    expect(
      applyUsageLimitsUpdate({
        previous: undefined,
        checkedAt,
        update: { windows: [], ordinaryUsageAllowed: false },
      })?.nativeDenialObservedAt,
    ).toBe(checkedAt);
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt,
        update: { windows: [], rateLimitReachedType: "workspace_member_usage_limit_reached" },
      }),
    ).toBe(previous);
  });
  it("does not lift notification denial through a failed full probe, but a later successful full read replaces it", () => {
    const denied = applyUsageLimitsUpdate({
      previous: { ...published, nativeAllowanceObservedAt: checkedAt, ordinaryUsageAllowed: true },
      checkedAt,
      update: { windows: [], ordinaryUsageAllowed: false },
    });
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    expect(resolveUsageLimitsAfterProbe({ published: denied, probed: failed })).toBe(denied);
    const fresh = {
      ...published,
      checkedAt: "2026-09-03T12:11:00.000Z",
      nativeAllowanceObservedAt: "2026-09-03T12:11:00.000Z",
      ordinaryUsageAllowed: true,
    };
    const result = resolveUsageLimitsAfterProbe({ published: denied, probed: fresh });
    expect(result).toBe(fresh);
    expect(result?.nativeDenialObservedAt).toBeUndefined();
  });
  it("preserves independent native pool identity time while quota observations advance", () => {
    const quotaPoolId = `codex:sha256:${"a".repeat(64)}`;
    const quotaPoolObservedAt = "2026-09-03T11:00:00.000Z";
    const next = applyUsageLimitsUpdate({
      previous: { ...published, quotaPoolId, quotaPoolObservedAt },
      checkedAt: "2026-09-03T12:10:00.000Z",
      update: { windows: [{ ...session, usedPercent: 66 }] },
    });
    expect(next?.checkedAt).toBe("2026-09-03T12:10:00.000Z");
    expect(next?.quotaPoolId).toBe(quotaPoolId);
    expect(next?.quotaPoolObservedAt).toBe(quotaPoolObservedAt);
  });
  it("does not renew route proof through quota notifications", () => {
    const nativeRouteObservedAt = "2026-09-03T11:00:00.000Z";
    const next = applyUsageLimitsUpdate({
      previous: { ...published, nativeRouteVerified: true, nativeRouteObservedAt },
      checkedAt: "2026-09-03T12:10:00.000Z",
      update: { windows: [{ ...session, usedPercent: 66 }] },
    });
    expect(next?.nativeRouteVerified).toBe(true);
    expect(next?.nativeRouteObservedAt).toBe(nativeRouteObservedAt);
  });
  it("returns the published object itself when no window moved", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("retains transient probe-failure recovery without clearing invalid-response evidence", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const update = { windows: [session] };
    expect(
      applyUsageLimitsUpdate({ previous: failed, checkedAt, update })?.unavailable,
    ).toBeUndefined();
    const invalid = {
      ...failed,
      unavailable: { ...failed.unavailable, invalidResponse: true as const },
    };
    expect(applyUsageLimitsUpdate({ previous: invalid, checkedAt, update })?.unavailable).toEqual(
      invalid.unavailable,
    );
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("Claude denial reset", () => {
  const fence = { ordinaryUsageAllowed: false, nativeDenialRequiresFullRead: true } as const;
  const deny = (
    previous: Parameters<typeof applyUsageLimitsUpdate>[0]["previous"],
    reset?: string,
  ) =>
    applyUsageLimitsUpdate({
      previous,
      checkedAt,
      update: { windows: [], ...fence, ...(reset ? { nativeDenialResetsAt: reset } : {}) },
    });

  it("stores the rejected window's reset and keeps it through positive sparse updates", () => {
    const denied = deny(published, "2026-09-03T14:00:00.000Z");
    expect(denied?.nativeDenialResetsAt).toBe("2026-09-03T14:00:00.000Z");
    const positive = applyUsageLimitsUpdate({
      previous: denied,
      checkedAt,
      update: { windows: [{ ...session, usedPercent: 1 }] },
    });
    expect(positive?.nativeDenialResetsAt).toBe("2026-09-03T14:00:00.000Z");
    expect(positive?.ordinaryUsageAllowed).toBe(false);
  });

  it("keeps the later of two resets, and a reset-less denial cannot lapse", () => {
    const weekly = deny(published, "2026-09-08T00:00:00.000Z");
    expect(deny(weekly, "2026-09-03T14:00:00.000Z")?.nativeDenialResetsAt).toBe(
      "2026-09-08T00:00:00.000Z",
    );
    expect(deny(weekly, undefined)?.nativeDenialResetsAt).toBeUndefined();
  });

  it("lapses in nativeQuotaDenied only after the reset", () => {
    const denied = deny(published, "2026-09-03T14:00:00.000Z");
    expect(nativeQuotaDenied(denied, Date.parse("2026-09-03T13:59:59Z"))).toBe(true);
    expect(nativeQuotaDenied(denied, Date.parse("2026-09-03T14:00:00Z"))).toBe(false);
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  const claudeDriver = ProviderDriverKind.make("claudeAgent");
  const codexDriver = ProviderDriverKind.make("codex");
  const laterAt = "2026-09-03T12:00:02.000Z";
  const unsupported = {
    checkedAt: laterAt,
    windows: [],
    unavailable: { reason: "unsupported" as const },
  };

  it.each([true, false])(
    "preserves Claude history and ordinaryUsageAllowed=%s through unsupported lookup",
    (ordinaryUsageAllowed) => {
      const previous = {
        ...published,
        windows: [{ ...session, usedPercent: 100 }, weekly],
        ordinaryUsageAllowed,
        nativeAllowanceObservedAt: checkedAt,
        ...(!ordinaryUsageAllowed
          ? { nativeDenialObservedAt: checkedAt, nativeDenialRequiresFullRead: true as const }
          : {}),
      };
      expect(
        resolveUsageLimitsAfterProbe({
          driver: claudeDriver,
          published: previous,
          probed: unsupported,
        }),
      ).toEqual({ ...previous, checkedAt: laterAt, unavailable: unsupported.unavailable });
      expect(previous.checkedAt).toBe(checkedAt);
      expect(previous.windows[0]?.usedPercent).toBe(100);
    },
  );

  it("keeps Claude malformed evidence through unsupported, failed and absent probes until a full read", () => {
    const previous = {
      ...published,
      nativeAllowanceObservedAt: checkedAt,
      unavailable: { reason: "probeFailed" as const, invalidResponse: true as const },
    };
    const unavailable = resolveUsageLimitsAfterProbe({
      driver: claudeDriver,
      published: previous,
      probed: unsupported,
    });
    expect(unavailable).toEqual({ ...previous, checkedAt: laterAt });
    const failed = resolveUsageLimitsAfterProbe({
      driver: claudeDriver,
      published: unavailable,
      probed: {
        checkedAt: "2026-09-03T12:00:03.000Z",
        windows: [],
        unavailable: { reason: "probeFailed" },
      },
    });
    expect(failed).toEqual(unavailable);
    expect(
      resolveUsageLimitsAfterProbe({ driver: claudeDriver, published: failed, probed: undefined }),
    ).toBe(failed);
    const full = { ...published, checkedAt: laterAt, nativeAllowanceObservedAt: laterAt };
    expect(
      resolveUsageLimitsAfterProbe({ driver: claudeDriver, published: failed, probed: full }),
    ).toBe(full);
  });

  it("does not erase or renew unavailable Claude history when the next probe fails", () => {
    const previous = { ...published, unavailable: unsupported.unavailable };
    expect(
      resolveUsageLimitsAfterProbe({
        driver: claudeDriver,
        published: previous,
        probed: { checkedAt: laterAt, windows: [], unavailable: { reason: "probeFailed" } },
      }),
    ).toEqual(previous);
    expect(
      resolveUsageLimitsAfterProbe({ driver: claudeDriver, published, probed: undefined }),
    ).toBe(published);
  });

  it("keeps first unsupported reads and Codex replacement behavior unchanged", () => {
    expect(
      resolveUsageLimitsAfterProbe({
        driver: claudeDriver,
        published: undefined,
        probed: unsupported,
      }),
    ).toBe(unsupported);
    expect(
      resolveUsageLimitsAfterProbe({ driver: codexDriver, published, probed: unsupported }),
    ).toBe(unsupported);
    expect(
      resolveUsageLimitsAfterProbe({ driver: codexDriver, published, probed: undefined }),
    ).toBeUndefined();
  });

  it("retains a main denial that arrives while an earlier allowed full probe is in flight", () => {
    const t0 = checkedAt,
      t1 = "2026-09-03T12:00:01.000Z",
      t2 = Date.parse("2026-09-03T12:00:02.000Z");
    const started = {
      ...published,
      nativeAllowanceObservedAt: t0,
      ordinaryUsageAllowed: true,
      spendControlReached: false,
      credits: { hasCredits: true, unlimited: true },
    };
    const live = applyUsageLimitsUpdate({
      previous: started,
      checkedAt: t1,
      update: { windows: [], spendControlReached: true },
    })!;
    const result = resolveUsageLimitsAfterProbe({ published: live, probed: started });
    expect(result).toBe(live);
    expect(result?.nativeDenialObservedAt).toBe(t1);
    expect(result?.spendControlReached).toBe(true);
    expect(result?.nativeAllowanceObservedAt).toBe(t0);
    expect(result?.windows).toEqual(live.windows);
    expect(nativeQuotaDenied(result, t2)).toBe(true);
  });
  it.each([
    ["tie", "2026-09-03T12:00:01.000Z", "2026-09-03T12:00:01.000Z"],
    ["window timestamp only", "2026-09-03T12:00:02.000Z", checkedAt],
    ["invalid probe time", "invalid", "2026-09-03T12:00:02.000Z"],
    ["invalid full-read time", "2026-09-03T12:00:02.000Z", "invalid"],
    ["missing full-read proof", "2026-09-03T12:00:02.000Z", undefined],
  ])("does not clear denial with %s", (_case, probeAt, fullAt) => {
    const denied = {
      ...published,
      nativeAllowanceObservedAt: checkedAt,
      nativeDenialObservedAt: "2026-09-03T12:00:01.000Z",
      ordinaryUsageAllowed: false,
    };
    const probed = {
      ...published,
      checkedAt: probeAt,
      ordinaryUsageAllowed: true,
      ...(fullAt !== undefined ? { nativeAllowanceObservedAt: fullAt } : {}),
    };
    expect(resolveUsageLimitsAfterProbe({ published: denied, probed })).toBe(denied);
    expect(resolveUsageLimitsAfterProbe({ published: denied, probed: undefined })).toBe(denied);
  });
  it("requires an ordered supported full read to recover, without inventing a malformed denial time", () => {
    const denied = {
      ...published,
      nativeAllowanceObservedAt: checkedAt,
      nativeDenialObservedAt: "2026-09-03T12:00:01.000Z",
      ordinaryUsageAllowed: false,
    };
    const later = {
      ...published,
      checkedAt: "2026-09-03T12:00:02.000Z",
      nativeAllowanceObservedAt: "2026-09-03T12:00:02.000Z",
      ordinaryUsageAllowed: true,
      spendControlReached: false,
    };
    expect(resolveUsageLimitsAfterProbe({ published: denied, probed: later })).toBe(later);
    const malformed = { ...denied, nativeDenialObservedAt: "invalid" };
    expect(resolveUsageLimitsAfterProbe({ published: malformed, probed: later })).toBe(malformed);
    const unproved = { ...published, ordinaryUsageAllowed: false };
    expect(resolveUsageLimitsAfterProbe({ published: unproved, probed: later })).toBe(later);
    const routeDenied = {
      ...later,
      checkedAt,
      nativeAllowanceObservedAt: checkedAt,
      nativeRouteVerified: false,
      nativeRouteObservedAt: checkedAt,
    };
    const kept = resolveUsageLimitsAfterProbe({ published: denied, probed: routeDenied });
    expect(kept?.ordinaryUsageAllowed).toBe(false);
    expect(kept?.nativeDenialObservedAt).toBe(denied.nativeDenialObservedAt);
    expect(kept?.nativeRouteVerified).toBe(false);
    expect(kept?.nativeRouteObservedAt).toBe(checkedAt);
  });
  it("an explicit denied route overrides previous permission even when quota probe fails", () => {
    const old = { ...published, nativeRouteVerified: true, nativeRouteObservedAt: checkedAt };
    const probed = {
      checkedAt,
      windows: [],
      unavailable: { reason: "probeFailed" as const },
      nativeRouteVerified: false,
      nativeRouteObservedAt: "2026-09-03T12:10:00.000Z",
    };
    const next = resolveUsageLimitsAfterProbe({ published: old, probed });
    expect(next?.windows).toEqual(published.windows);
    expect(next?.nativeRouteVerified).toBe(false);
    expect(next?.nativeRouteObservedAt).toBe(probed.nativeRouteObservedAt);
  });
  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });
});

it("preserves native permission and credit proof time across sparse window updates", () => {
  const previous = {
    checkedAt: "2026-10-08T00:00:00Z",
    windows: [{ id: "primary", kind: "session" as const, label: "Session", usedPercent: 90 }],
    nativeAllowanceObservedAt: "2026-10-08T00:00:00Z",
    ordinaryUsageAllowed: false,
    spendControlReached: true,
    rateLimitReachedType: "workspace_owner_usage_limit_reached",
    credits: { hasCredits: true, unlimited: false, balance: "10" },
  };
  const result = applyUsageLimitsUpdate({
    previous,
    update: { windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 10 }] },
    checkedAt: "2026-10-08T01:00:00Z",
  });
  expect(result?.checkedAt).toBe("2026-10-08T01:00:00Z");
  expect(result?.nativeAllowanceObservedAt).toBe(previous.nativeAllowanceObservedAt);
  expect(result?.ordinaryUsageAllowed).toBe(false);
  expect(result?.spendControlReached).toBe(true);
  expect(result?.rateLimitReachedType).toBe(previous.rateLimitReachedType);
  expect(result?.credits).toEqual(previous.credits);
});
