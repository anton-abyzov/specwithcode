import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProviderCredits } from "./providerUsageLimits.ts";
import { StudioCapacityAccount } from "./studio.ts";

const creditsWithBalance = (balance: unknown) => ({
  hasCredits: true,
  unlimited: false,
  balance,
});
const decodeCredits = Schema.decodeUnknownSync(ServerProviderCredits);

describe("native provider credit balances", () => {
  it.each([
    "0",
    "1234.1234567890",
    "0.000000000000000000000001",
    `${"9".repeat(24)}.${"9".repeat(24)}`,
    null,
    undefined,
  ])("preserves the exact bounded balance %j in provider and capacity DTOs", (balance) => {
    const credits = creditsWithBalance(balance);
    const decoded = decodeCredits(credits);
    expect(decoded.balance).toBe(balance);
    expect(Schema.encodeSync(ServerProviderCredits)(decoded).balance).toBe(balance);
    expect(
      Schema.decodeUnknownSync(StudioCapacityAccount.fields.quota.fields.credits)(credits),
    ).toEqual(decoded);
  });

  it.each([
    "",
    "private@example.invalid",
    "https://example.invalid/credit",
    "NaN",
    "Infinity",
    "1e10",
    "+1",
    "-1",
    ".5",
    "1.",
    "1,000",
    " 1",
    "1 ",
    "1\n",
    "1\r\n",
    "1\u2028",
    "9".repeat(25),
    `0.${"9".repeat(25)}`,
    "9".repeat(10_000),
    1,
    {},
  ])("rejects nonnumeric or unbounded balances (%#)", (balance) => {
    expect(
      Schema.decodeUnknownOption(ServerProviderCredits)(creditsWithBalance(balance))._tag,
    ).toBe("None");
  });
});
