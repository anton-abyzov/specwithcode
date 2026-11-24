import { describe, expect, it } from "@effect/vitest";

import { personalLinkIdForAccount } from "./personalLinkId.ts";

describe("the account's Percy link id (1448 D-11)", () => {
  it("is logical:percy: and the first 32 hex characters of SHA-256 of percy:<user id>", () => {
    // printf 'percy:user_test_0001' | shasum -a 256
    expect(personalLinkIdForAccount("user_test_0001")).toBe(
      "logical:percy:7035e952171cd91854deef5689d491cb",
    );
  });

  it("is the same on every machine of one account and differs between accounts", () => {
    expect(personalLinkIdForAccount("user_test_0001")).toBe(
      personalLinkIdForAccount("user_test_0001"),
    );
    expect(personalLinkIdForAccount("user_test_0002")).toBe(
      "logical:percy:974c41907b614d28a7d862e64fb9aef2",
    );
  });

  it("does not carry the user id", () => {
    expect(personalLinkIdForAccount("user_test_0001")).not.toContain("user_test_0001");
  });
});
