import { describe, expect, it } from "vite-plus/test";

import { claudeRateLimitEventToUpdate, claudeUsageResponseToLimits } from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            // Newer CLIs add this on top of the typed keys; the pinned SDK
            // typings do not know it yet.
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        unavailable: { reason: "probeFailed", invalidResponse: true },
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            modelScope: "Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("reports API key and Bedrock accounts as unsupported", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: false, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
  });

  it("explains a subscription whose limits were not read", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: true, rate_limits: null },
      }).limits.unavailable,
    ).toEqual({
      reason: "unsupported",
      message: "Signed in to a subscription, but Claude did not return its usage.",
    });
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    // No probe has named the bucket yet: guessing would open a stray row.
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          modelScope: "Fable",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("ignores windows the page does not render and events without a utilization", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1 },
        noNames,
      ),
    ).toBeUndefined();
    expect(
      claudeRateLimitEventToUpdate({ status: "allowed", rateLimitType: "five_hour" }, noNames),
    ).toBeUndefined();
  });

  it.each([-1, 1.01, NaN, Infinity])(
    "ignores invalid utilization %s instead of normalizing it",
    (utilization) => {
      expect(
        claudeRateLimitEventToUpdate(
          { status: "allowed", rateLimitType: "five_hour", utilization },
          noNames,
        ),
      ).toBeUndefined();
    },
  );

  it.each([-1, 0, NaN, Infinity, Number.MAX_VALUE])(
    "does not hide a supplied invalid reset %s",
    (resetsAt) => {
      const event = { rateLimitType: "five_hour" as const, utilization: 0, resetsAt };
      expect(
        claudeRateLimitEventToUpdate({ ...event, status: "allowed" }, noNames),
      ).toBeUndefined();
      expect(claudeRateLimitEventToUpdate({ ...event, status: "rejected" }, noNames)).toEqual({
        windows: [],
        ordinaryUsageAllowed: false,
        nativeDenialRequiresFullRead: true,
        rateLimitReachedType: "rate_limit_reached",
      });
    },
  );

  // Updated with the 2026-10-21 limit fix: a rejected window without a
  // utilization is spent (it used to stay at its last reading). A model
  // weekly's rejection still revokes the whole account.
  it("publishes a rejection even when the native event omits usage or a known window", () => {
    const denial = {
      ordinaryUsageAllowed: false,
      nativeDenialRequiresFullRead: true,
      rateLimitReachedType: "rate_limit_reached",
    };
    for (const event of [
      { status: "rejected" as const },
      { status: "rejected" as const, rateLimitType: "five_hour" as const, utilization: NaN },
    ])
      expect(claudeRateLimitEventToUpdate(event, noNames)).toEqual({ windows: [], ...denial });
    expect(
      claudeRateLimitEventToUpdate({ status: "rejected", rateLimitType: "five_hour" }, noNames),
    ).toEqual({
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 100,
          windowDurationMins: 300,
        },
      ],
      ...denial,
    });
    expect(
      claudeRateLimitEventToUpdate(
        { status: "rejected", rateLimitType: "seven_day_opus", utilization: 0.5 },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day_opus",
          kind: "weekly",
          label: "Weekly · Opus",
          modelScope: "Opus",
          usedPercent: 100,
          windowDurationMins: 10080,
        },
      ],
      ...denial,
    });
  });

  // The rejected event observed at 06:44Z on 2026-10-21: no top-level
  // utilization, which the CLI carried only in `unifiedWindows`.
  const incident = {
    status: "rejected" as const,
    rateLimitType: "five_hour" as const,
    resetsAt: 1_792_575_000,
    unifiedWindows: {
      five_hour: { utilization: 1, resetsAt: 1_792_575_000 },
      seven_day: { utilization: 0.42, resetsAt: 1_793_000_000 },
      seven_day_overage_included: { utilization: 0.3, resetsAt: 1_793_000_000 },
    },
  };

  it("marks the rejected 5-hour window spent with its reset and folds the other windows", () => {
    expect(claudeRateLimitEventToUpdate(incident, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 100,
          windowDurationMins: 300,
          resetsAt: "2026-10-21T09:30:00.000Z",
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 42,
          windowDurationMins: 10080,
          resetsAt: "2026-10-26T07:33:20.000Z",
        },
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          modelScope: "Fable",
          usedPercent: 30,
          windowDurationMins: 10080,
          resetsAt: "2026-10-26T07:33:20.000Z",
        },
      ],
      ordinaryUsageAllowed: false,
      nativeDenialRequiresFullRead: true,
      rateLimitReachedType: "rate_limit_reached",
      nativeDenialResetsAt: "2026-10-21T09:30:00.000Z",
    });
    // Unnamed overage bucket draws no row; the account-wide rows still land.
    expect(
      claudeRateLimitEventToUpdate(incident, noNames)?.windows.map((window) => window.id),
    ).toEqual(["five_hour", "seven_day"]);
  });

  it("takes the reading and reset from unifiedWindows when the top level omits them", () => {
    const { resetsAt: _resetsAt, ...withoutReset } = incident;
    expect(claudeRateLimitEventToUpdate(withoutReset, noNames)).toMatchObject({
      windows: [{ id: "five_hour", usedPercent: 100, resetsAt: "2026-10-21T09:30:00.000Z" }, {}],
      nativeDenialResetsAt: "2026-10-21T09:30:00.000Z",
    });
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: 1_792_575_000 } },
        } as never,
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          usedPercent: 90,
          windowDurationMins: 300,
          resetsAt: "2026-10-21T09:30:00.000Z",
        },
      ],
    });
  });

  it("skips malformed unifiedWindows entries instead of normalizing them", () => {
    expect(
      claudeRateLimitEventToUpdate(
        Object.assign({}, incident, {
          unifiedWindows: {
            five_hour: { utilization: 1, resetsAt: 1_792_575_000 },
            seven_day: { utilization: 4.2, resetsAt: 1_793_000_000 },
            seven_day_overage_included: { utilization: 0.3, resetsAt: -1 },
          },
        }),
        { overageIncluded: "Fable" },
      )?.windows.map((window) => window.id),
    ).toEqual(["five_hour"]);
  });

  it.each([
    ["seven_day_overage_included", "seven_day_fable", "Fable"],
    ["seven_day_opus", "seven_day_opus", "Opus"],
    ["seven_day_some_new_model", "seven_day_some_new_model", "Some New Model"],
  ] as const)(
    "a rejected model weekly (%s) spends its window and fences the account until its reset",
    (rateLimitType, id, modelScope) => {
      const update = claudeRateLimitEventToUpdate(
        { status: "rejected", rateLimitType: rateLimitType as never, resetsAt: 1_793_000_000 },
        { overageIncluded: "Fable" },
      );
      expect(update).toEqual({
        windows: [
          {
            id,
            kind: "weekly",
            label: `Weekly · ${modelScope}`,
            modelScope,
            usedPercent: 100,
            windowDurationMins: 10080,
            resetsAt: "2026-10-26T07:33:20.000Z",
          },
        ],
        ordinaryUsageAllowed: false,
        nativeDenialRequiresFullRead: true,
        rateLimitReachedType: "rate_limit_reached",
        nativeDenialResetsAt: "2026-10-26T07:33:20.000Z",
      });
    },
  );

  it("does not guess a model for an unnamed overage-included rejection", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "rejected", rateLimitType: "seven_day_overage_included" },
        noNames,
      ),
    ).toEqual({
      windows: [],
      ordinaryUsageAllowed: false,
      nativeDenialRequiresFullRead: true,
      rateLimitReachedType: "rate_limit_reached",
    });
  });

  it("lapses only when every account-wide window the rejection shows spent has reset", () => {
    const withWeekly = (seven_day: object) =>
      claudeRateLimitEventToUpdate(
        Object.assign({}, incident, {
          unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1_792_575_000 }, seven_day },
        }),
        noNames,
      );
    const spent = withWeekly({ utilization: 1, resetsAt: 1_793_000_000 });
    expect(spent?.windows.find((window) => window.id === "seven_day")?.usedPercent).toBe(100);
    expect(spent?.nativeDenialResetsAt).toBe("2026-10-26T07:33:20.000Z");
    // A spent weekly with no usable reset leaves nothing to lapse at.
    expect(withWeekly({ utilization: 1 })).toMatchObject({ ordinaryUsageAllowed: false });
    expect(withWeekly({ utilization: 1 })?.nativeDenialResetsAt).toBeUndefined();
    expect(withWeekly({ utilization: 1, resetsAt: -1 })?.nativeDenialResetsAt).toBeUndefined();
    // A weekly with room does not move the session's reset.
    expect(withWeekly({ utilization: 0.99, resetsAt: 1_793_000_000 })?.nativeDenialResetsAt).toBe(
      "2026-10-21T09:30:00.000Z",
    );
  });

  it.each([
    { overageStatus: "allowed" as const },
    { overageStatus: "allowed_warning" as const },
    { isUsingOverage: true },
    { overageInUse: true },
  ])("preserves the adapter's explicitly allowed overage semantics: %j", (overage) => {
    expect(
      claudeRateLimitEventToUpdate({ status: "rejected", ...overage }, noNames),
    ).toBeUndefined();
  });
});
