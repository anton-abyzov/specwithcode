import * as CodexErrors from "@specweave-studio/effect-codex-app-server/errors";
import { describe, expect, it } from "vite-plus/test";
import { windowAppliesToModel } from "@specweave-studio/shared/usageWindows";

import {
  codexRateLimitsFailureMessage,
  codexRateLimitsToLimits,
  codexRateLimitsToUpdate,
  codexResetCreditsToContract,
  codexUsageLimitMessage,
  mergeCodexRateLimits,
} from "./codexUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";

describe("sparse main native credit withdrawal", () => {
  it.each([
    { credits: { hasCredits: false } },
    { credits: { balance: "0" } },
    { credits: { hasCredits: true, unlimited: false, balance: "00.000000000000000000000000" } },
    { spendControlReached: true },
    { rateLimitReachedType: "workspace_owner_credits_depleted" },
    { rateLimitReachedType: "workspace_member_credits_depleted" },
    { rateLimitReachedType: "workspace_owner_usage_limit_reached" },
    { rateLimitReachedType: "workspace_member_usage_limit_reached" },
  ])("withdraws main credit admission for %j without requiring windows", (snapshot) => {
    const update = codexRateLimitsToUpdate(snapshot);
    expect(update?.nativeCreditDenied).toBe(true);
    expect(update?.ordinaryUsageAllowed).toBeUndefined();
    expect(update?.windows).toEqual([]);
    expect(update).not.toHaveProperty("credits");
  });

  it.each([
    undefined,
    null,
    "",
    "0.000000000000000000000001",
    "1",
    "NaN",
    "-0",
    "0e0",
    ".0",
    "0.",
    " 0",
    "0".repeat(25),
  ])("does not infer zero credit from unknown, positive or malformed balance %j", (balance) => {
    expect(
      codexRateLimitsToUpdate({ credits: balance === undefined ? {} : { balance } }),
    ).toBeUndefined();
  });

  it("does not grant permission from positive credit/window notifications", () => {
    expect(
      codexRateLimitsToUpdate({
        credits: { hasCredits: true, unlimited: true, balance: "10" },
        ordinaryUsageAllowed: true,
        spendControlReached: false,
      }),
    ).toBeUndefined();
    expect(
      codexRateLimitsToUpdate({
        credits: { hasCredits: true, unlimited: false, balance: "10" },
        ordinaryUsageAllowed: true,
        primary: { usedPercent: 0 },
      }),
    ).toEqual({ windows: [{ id: "primary", kind: "other", label: "Primary", usedPercent: 0 }] });
    expect(
      codexRateLimitsToUpdate({
        ordinaryUsageAllowed: false,
        rateLimitReachedType: "rate_limit_reached",
      })?.nativeCreditDenied,
    ).toBeUndefined();
  });

  it("honors a hard workspace denial even alongside positive sparse permission flags", () => {
    expect(
      codexRateLimitsToUpdate({
        ordinaryUsageAllowed: true,
        spendControlReached: false,
        credits: { hasCredits: true, unlimited: true },
        rateLimitReachedType: "workspace_member_usage_limit_reached",
      }),
    ).toEqual({
      windows: [],
      nativeCreditDenied: true,
      rateLimitReachedType: "workspace_member_usage_limit_reached",
    });
  });

  it("isolates model-specific credit/workspace/spend denial from the main pool", () => {
    const snapshot = {
      limitId: "codex_bengalfox",
      credits: { hasCredits: false, balance: "0" },
      spendControlReached: true,
      rateLimitReachedType: "workspace_owner_credits_depleted",
    };
    expect(codexRateLimitsToUpdate(snapshot)).toBeUndefined();
    expect(codexRateLimitsToUpdate({ ...snapshot, primary: { usedPercent: 100 } })).toEqual({
      windows: [
        {
          id: "codex_bengalfox:primary",
          kind: "other",
          label: "codex_bengalfox: Primary",
          modelScope: "codex_bengalfox",
          usedPercent: 100,
        },
      ],
    });
  });
});

describe("codexRateLimitsToLimits", () => {
  it("hashes only the exact supported nonempty accountId without publishing it", () => {
    const limits = codexRateLimitsToLimits({
      checkedAt,
      snapshot: {},
      accountId: "synthetic-native-account",
    });
    expect(limits.quotaPoolId).toMatch(/^codex:sha256:[a-f0-9]{64}$/);
    expect(limits.quotaPoolObservedAt).toBe(checkedAt);
    expect(JSON.stringify(limits)).not.toContain("synthetic-native-account");
    expect(
      codexRateLimitsToLimits({ checkedAt, snapshot: {}, accountId: "synthetic-native-account" })
        .quotaPoolId,
    ).toBe(limits.quotaPoolId);
    expect(
      codexRateLimitsToLimits({ checkedAt, snapshot: {}, accountId: " synthetic-native-account" })
        .quotaPoolId,
    ).not.toBe(limits.quotaPoolId);
    for (const accountId of [null, undefined, "", "   "])
      expect(
        codexRateLimitsToLimits({
          checkedAt,
          snapshot: {},
          ...(accountId === undefined ? {} : { accountId }),
        }).quotaPoolId,
      ).toBeUndefined();
  });
  it("maps primary and secondary onto the session and weekly windows", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: {
          planType: "plus",
          primary: { usedPercent: 12, resetsAt: 1_784_000_000, windowDurationMins: 300 },
          secondary: { usedPercent: 47, resetsAt: 1_784_500_000, windowDurationMins: 10080 },
        },
      }),
    ).toEqual({
      checkedAt,
      nativeAllowanceObservedAt: checkedAt,
      windows: [
        {
          id: "primary",
          kind: "session",
          label: "Session",
          usedPercent: 12,
          windowDurationMins: 300,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 47,
          windowDurationMins: 10080,
          resetsAt: "2026-07-19T22:26:40.000Z",
        },
      ],
    });
  });

  it.each(["free", "go", "pro", "plus"])(
    "does not invent a period for a duration-less primary on %s",
    (planType) => {
      expect(
        codexRateLimitsToLimits({
          checkedAt,
          snapshot: { planType, primary: { usedPercent: 80, resetsAt: null } },
        }).windows,
      ).toEqual([
        {
          id: "primary",
          kind: "other",
          label: "Primary",
          usedPercent: 80,
        },
      ]);
    },
  );

  it("keeps the main Codex allowance distinct from every model-specific bucket", () => {
    const spark = {
      limitId: "codex_bengalfox",
      primary: { usedPercent: 0, windowDurationMins: 300 },
      secondary: { usedPercent: 90, windowDurationMins: 10080 },
    };
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: spark,
        rateLimitsByLimitId: {
          codex_bengalfox: spark,
          codex: { secondary: { usedPercent: 42, windowDurationMins: 10080 } },
        },
      }).windows.toSorted((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      {
        id: "codex_bengalfox:primary",
        kind: "session",
        label: "codex_bengalfox: Session",
        modelScope: "codex_bengalfox",
        usedPercent: 0,
        windowDurationMins: 300,
      },
      {
        id: "codex_bengalfox:secondary",
        kind: "weekly",
        label: "codex_bengalfox: Weekly",
        modelScope: "codex_bengalfox",
        usedPercent: 90,
        windowDurationMins: 10080,
      },
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 42,
        windowDurationMins: 10080,
      },
    ]);
  });

  it("scopes a model bucket to the model it names, never to every Codex model", () => {
    const spark = {
      limitId: "codex_bengalfox",
      limitName: "GPT-5.3-Codex-Spark",
      secondary: { usedPercent: 100, windowDurationMins: 10080 },
    };
    const limits = codexRateLimitsToLimits({
      checkedAt,
      snapshot: { secondary: { usedPercent: 12, windowDurationMins: 10080 } },
      rateLimitsByLimitId: {
        codex: { secondary: { usedPercent: 12, windowDurationMins: 10080 } },
        codex_bengalfox: spark,
      },
    });
    const bucket = limits.windows.find((window) => window.id === "codex_bengalfox:secondary");
    expect(bucket).toMatchObject({
      label: "GPT-5.3-Codex-Spark: Weekly",
      modelScope: "GPT-5.3-Codex-Spark",
    });
    expect(windowAppliesToModel(bucket!, "gpt-5.3-codex-spark")).toBe(true);
    expect(windowAppliesToModel(bucket!, "gpt-6.1-sol")).toBe(false);
    expect(windowAppliesToModel(bucket!, null)).toBe(false);
    expect(limits.windows.find((window) => window.id === "secondary")?.modelScope).toBeUndefined();
  });

  it.each([undefined, null, {}])(
    "supports legacy reads with no bucket map: %j",
    (rateLimitsByLimitId) => {
      const snapshot = { primary: { usedPercent: 12, windowDurationMins: 300 } };
      expect(codexRateLimitsToLimits({ checkedAt, snapshot, rateLimitsByLimitId })).toEqual(
        codexRateLimitsToLimits({ checkedAt, snapshot }),
      );
    },
  );

  it("keeps a model-specific legacy snapshot visibly separate from the main allowance", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: {
          limitId: "codex_bengalfox",
          secondary: { usedPercent: 90 },
        },
      }).windows,
    ).toEqual([
      {
        id: "codex_bengalfox:secondary",
        kind: "other",
        label: "codex_bengalfox: Secondary",
        modelScope: "codex_bengalfox",
        usedPercent: 90,
      },
    ]);
  });
  it("preserves fresh ordinary permission, spend denial and credit balance from the main bucket", () => {
    const limits = codexRateLimitsToLimits({
      checkedAt,
      ordinaryUsageAllowed: false,
      snapshot: {},
      rateLimitsByLimitId: {
        codex: {
          spendControlReached: true,
          rateLimitReachedType: "workspace_owner_usage_limit_reached",
          credits: { hasCredits: true, unlimited: false, balance: "91.50" },
          secondary: { usedPercent: 100, windowDurationMins: 10080 },
        },
        codex_bengalfox: {
          spendControlReached: false,
          credits: { hasCredits: false, unlimited: true, balance: "0" },
          primary: { usedPercent: 0, windowDurationMins: 300 },
        },
      },
    });
    expect(limits).toMatchObject({
      ordinaryUsageAllowed: false,
      spendControlReached: true,
      rateLimitReachedType: "workspace_owner_usage_limit_reached",
      credits: { hasCredits: true, unlimited: false, balance: "91.50" },
      nativeAllowanceObservedAt: checkedAt,
    });
  });
  it("timestamps a full read with unknown permission without inventing a permission or banked credits", () => {
    const limits = codexRateLimitsToLimits({ checkedAt, snapshot: {} });
    expect(limits.nativeAllowanceObservedAt).toBe(checkedAt);
    expect(limits.ordinaryUsageAllowed).toBeUndefined();
    expect(limits.credits).toBeUndefined();
  });
  it.each([
    { credits: { hasCredits: false } },
    { credits: { balance: "0.000" } },
    { spendControlReached: true },
    { rateLimitReachedType: "workspace_owner_credits_depleted" },
  ])("preserves an explicit full-read credit withdrawal from %j", (snapshot) => {
    const limits = codexRateLimitsToLimits({ checkedAt, snapshot, ordinaryUsageAllowed: true });
    expect(limits.nativeCreditDenialObservedAt).toBe(checkedAt);
    expect(limits.nativeAllowanceObservedAt).toBe(checkedAt);
    expect(limits.ordinaryUsageAllowed).toBe(true);
    expect(limits.credits).toBeUndefined();
  });
  it("does not fabricate a full credit object from incomplete or malformed metadata", () => {
    for (const credits of [
      { hasCredits: true },
      { unlimited: false, balance: "5" },
      { hasCredits: true, unlimited: false, balance: "NaN" },
    ]) {
      expect(codexRateLimitsToLimits({ checkedAt, snapshot: { credits } }).credits).toBeUndefined();
    }
  });
  it("never promotes model-specific credits or denial metadata into the main native allowance", () => {
    const limits = codexRateLimitsToLimits({
      checkedAt,
      snapshot: {
        limitId: "codex_bengalfox",
        spendControlReached: true,
        credits: { hasCredits: true, unlimited: true },
      },
    });
    expect(limits.spendControlReached).toBeUndefined();
    expect(limits.credits).toBeUndefined();
  });
  it("ignores invalid duration and bucket identifiers rather than constructing misleading rows", () => {
    const limits = codexRateLimitsToLimits({
      checkedAt,
      snapshot: {
        primary: { usedPercent: 15, windowDurationMins: -1 },
        secondary: { usedPercent: 20, windowDurationMins: 0.5 },
      },
      rateLimitsByLimitId: { "unsafe/bucket": { primary: { usedPercent: 3 } } },
    });
    expect(limits.windows).toEqual([
      { id: "primary", kind: "other", label: "Primary", usedPercent: 15 },
      { id: "secondary", kind: "other", label: "Secondary", usedPercent: 20 },
    ]);
  });
});

describe("codexRateLimitsToUpdate", () => {
  it("carries an explicit main spend denial even without a window", () => {
    expect(
      codexRateLimitsToUpdate({
        limitId: "codex",
        spendControlReached: true,
        rateLimitReachedType: "workspace_member_usage_limit_reached",
      }),
    ).toEqual({
      windows: [],
      spendControlReached: true,
      nativeCreditDenied: true,
      rateLimitReachedType: "workspace_member_usage_limit_reached",
    });
    expect(
      codexRateLimitsToUpdate({ ordinaryUsageAllowed: false, primary: { usedPercent: 20 } }),
    ).toEqual({
      windows: [{ id: "primary", kind: "other", label: "Primary", usedPercent: 20 }],
      ordinaryUsageAllowed: false,
    });
  });

  it("does not promote model-specific denial or sparse positive permission", () => {
    for (const snapshot of [
      {
        limitId: "codex_bengalfox",
        spendControlReached: true,
        ordinaryUsageAllowed: false,
        rateLimitReachedType: "workspace_member_usage_limit_reached",
      },
      {
        limitId: "codex",
        spendControlReached: false,
        ordinaryUsageAllowed: true,
        rateLimitReachedType: "rate_limit_reached",
      },
      { limitId: "codex", rateLimitReachedType: "rate_limit_reached" },
    ]) {
      expect(codexRateLimitsToUpdate(snapshot)).toBeUndefined();
      const update = codexRateLimitsToUpdate({ ...snapshot, primary: { usedPercent: 20 } });
      expect(update).toEqual({
        windows: [
          {
            id: snapshot.limitId === "codex" ? "primary" : "codex_bengalfox:primary",
            kind: "other",
            label: snapshot.limitId === "codex" ? "Primary" : "codex_bengalfox: Primary",
            ...(snapshot.limitId === "codex" ? {} : { modelScope: "codex_bengalfox" }),
            usedPercent: 20,
          },
        ],
      });
    }
  });

  it("carries only the windows the notification names", () => {
    expect(
      codexRateLimitsToUpdate({
        secondary: { usedPercent: 51, windowDurationMins: 10080 },
      }),
    ).toEqual({
      windows: [
        {
          id: "secondary",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 51,
          windowDurationMins: 10080,
        },
      ],
    });
    expect(codexRateLimitsToUpdate({ planType: "plus" })).toBeUndefined();
  });

  it("keeps Spark notifications on separate rows without renewing full-read permission evidence", () => {
    expect(
      codexRateLimitsToUpdate({
        limitId: "codex_bengalfox",
        primary: { usedPercent: 0, windowDurationMins: 300 },
        secondary: { usedPercent: 90, windowDurationMins: 10080 },
      }),
    ).toEqual({
      windows: [
        {
          id: "codex_bengalfox:primary",
          kind: "session",
          label: "codex_bengalfox: Session",
          modelScope: "codex_bengalfox",
          usedPercent: 0,
          windowDurationMins: 300,
        },
        {
          id: "codex_bengalfox:secondary",
          kind: "weekly",
          label: "codex_bengalfox: Weekly",
          modelScope: "codex_bengalfox",
          usedPercent: 90,
          windowDurationMins: 10080,
        },
      ],
    });
    expect(
      codexRateLimitsToUpdate({
        limitId: "codex",
        secondary: { usedPercent: 42, windowDurationMins: 10080 },
      })?.windows,
    ).toEqual([
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 42,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("codexRateLimitsFailureMessage", () => {
  it("keeps the JSON-RPC code and nothing else from a request failure", () => {
    expect(
      codexRateLimitsFailureMessage(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage:
            "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized",
        }),
      ),
    ).toBe("Codex could not read usage (JSON-RPC -32603).");
  });

  it("phrases a dead process differently from a bad answer", () => {
    expect(
      codexRateLimitsFailureMessage(new CodexErrors.CodexAppServerProcessExitedError({ code: 1 })),
    ).toBe("Codex exited before it could report usage.");
  });
});

describe("codexResetCreditsToContract", () => {
  it("counts available credits and reports the soonest expiry", () => {
    expect(
      codexResetCreditsToContract({
        availableCount: 2,
        credits: [
          { status: "available", expiresAt: 1_784_500_000 },
          { status: "redeemed", expiresAt: 1_700_000_000 },
          { status: "available", expiresAt: 1_784_000_000 },
        ],
      }),
    ).toEqual({ availableCount: 2, nextExpiresAt: "2026-07-14T03:33:20.000Z" });
    expect(codexResetCreditsToContract({ availableCount: 0 })).toEqual({ availableCount: 0 });
    expect(codexResetCreditsToContract(null)).toBeUndefined();
  });

  it("rides along on the probe's limits", () => {
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: { primary: { usedPercent: 5, windowDurationMins: 300 } },
        resetCredits: { availableCount: 1 },
      }).resetCredits,
    ).toEqual({ availableCount: 1 });
  });
});

describe("codexUsageLimitMessage", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const atSeconds = Date.parse(at) / 1000;

  it("names the exhausted window and the workspace's missing credits", () => {
    expect(
      codexUsageLimitMessage(
        {
          limitId: "codex",
          rateLimitReachedType: "workspace_owner_credits_depleted",
          primary: { usedPercent: 40, resetsAt: atSeconds + 3_600, windowDurationMins: 300 },
          secondary: {
            usedPercent: 100,
            resetsAt: atSeconds + 5 * 86_400 + 5 * 3_600,
            windowDurationMins: 10_080,
          },
        },
        at,
      ),
    ).toBe(
      "Codex usage limit reached. The weekly limit resets in 5d 5h. The workspace has no credits to continue sooner: ask your workspace owner to add credits, or send the message again once the limit resets.",
    );
  });

  it("points a reached spend cap at the workspace owner", () => {
    expect(
      codexUsageLimitMessage(
        {
          limitId: "codex",
          rateLimitReachedType: "workspace_member_usage_limit_reached",
          primary: {
            usedPercent: 100,
            resetsAt: atSeconds + 3 * 3_600 + 20 * 60,
            windowDurationMins: 300,
          },
        },
        at,
      ),
    ).toBe(
      "Codex usage limit reached. The session limit resets in 3h 20m. The workspace spend limit is reached: ask your workspace owner to raise it, or send the message again once the limit resets.",
    );
  });

  it("names no window when credits run out without one", () => {
    expect(
      codexUsageLimitMessage(
        { limitId: "codex", rateLimitReachedType: "workspace_member_credits_depleted" },
        at,
      ),
    ).toBe(
      "Codex usage limit reached. The workspace has no credits to continue sooner: ask your workspace owner to add credits, or send the message again once the limit resets.",
    );
  });

  it("says only what it knows without a snapshot", () => {
    expect(codexUsageLimitMessage(undefined, at)).toBe(
      "Codex usage limit reached. Send the message again once the limit resets.",
    );
  });
});

describe("mergeCodexRateLimits", () => {
  it("keeps windows an update does not carry", () => {
    const merged = mergeCodexRateLimits(
      {
        limitId: "codex",
        planType: "business",
        primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      },
      { rateLimitReachedType: "rate_limit_reached" },
    );

    expect(merged).toEqual({
      limitId: "codex",
      planType: "business",
      rateLimitReachedType: "rate_limit_reached",
      primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    });
  });

  it("ignores a model-specific snapshot so it cannot replace the main allowance", () => {
    const main = {
      limitId: "codex",
      primary: { usedPercent: 100, resetsAt: 1_800_000_000, windowDurationMins: 300 },
    };
    expect(
      mergeCodexRateLimits(main, {
        limitId: "spark",
        primary: { usedPercent: 3, resetsAt: 1_800_000_000, windowDurationMins: 300 },
      }),
    ).toBe(main);
  });
});

import { codexUsageLimitResetAt } from "./codexUsageLimits.ts";

describe("codexUsageLimitResetAt", () => {
  it("waits for every exhausted window and never invents an unknown reset", () => {
    expect(
      codexUsageLimitResetAt({
        primary: { usedPercent: 100, resetsAt: 2000000000 },
        secondary: { usedPercent: 100, resetsAt: 2000100000 },
      }),
    ).toBe("2033-05-19T07:20:00.000Z");
    expect(codexUsageLimitResetAt({ primary: { usedPercent: 100 } })).toBeNull();
    expect(
      codexUsageLimitResetAt({ primary: { usedPercent: 50, resetsAt: 2000000000 } }),
    ).toBeNull();
  });
});
