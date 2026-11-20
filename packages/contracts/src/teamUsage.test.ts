import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  TEAM_USAGE_SUMMARY_KEYS,
  TeamUsageEndpoint,
  TeamUsageSummary,
  teamUsageSummaryExtraKeys,
} from "./teamUsage.ts";

const summary = {
  machineLabel: "M4",
  at: "2026-11-19T10:00:00.000Z",
  accounts: [
    {
      provider: "cursor",
      accountLabel: "Cursor",
      windows: [],
      limitHits: 0,
      handoffs: 0,
      providerSwitches: 0,
    },
  ],
};

describe("team usage summary contract (0898 AC-02)", () => {
  it("lists exactly the fields AC-02 names", () => {
    expect(TEAM_USAGE_SUMMARY_KEYS).toEqual({
      summary: ["machineLabel", "at", "accounts"],
      account: [
        "provider",
        "accountLabel",
        "planTier",
        "windows",
        "limitHits",
        "handoffs",
        "providerSwitches",
      ],
      window: ["kind", "remainingPercent", "lowestRemainingPercent", "resetsAt"],
    });
  });

  it("decodes a summary with no reading (usage not readable yet)", () => {
    expect(Schema.decodeUnknownSync(TeamUsageSummary)(summary)).toEqual(summary);
    expect(teamUsageSummaryExtraKeys(summary)).toEqual([]);
  });

  it("names every key outside the list, at any depth", () => {
    expect(
      teamUsageSummaryExtraKeys({
        ...summary,
        email: "x",
        accounts: [
          {
            ...summary.accounts[0],
            subscriptionKey: "y",
            windows: [{ kind: "session", remainingPercent: 1, lowestRemainingPercent: 1, label: "z" }],
          },
        ],
      }),
    ).toEqual(["email", "accounts[0].subscriptionKey", "accounts[0].windows[0].label"]);
    expect(teamUsageSummaryExtraKeys(null)).toEqual([":not-an-object"]);
  });

  it("accepts only https self-hosted endpoints", () => {
    const decode = Schema.decodeUnknownExit(TeamUsageEndpoint);
    expect(decode({ kind: "selfHosted", url: "https://team.example/usage" })._tag).toBe("Success");
    expect(decode({ kind: "selfHosted", url: "http://team.example/usage" })._tag).toBe("Failure");
  });
});
