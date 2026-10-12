import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ProviderSetupError } from "@specweave-studio/contracts";
import { providerSetupFailureDetail } from "./ProviderAdapter.ts";

describe("nested provider setup guidance", () => {
  it("unwraps the exact admission guidance through session errors", () => {
    const denial = new ProviderSetupError({ instanceId: ProviderInstanceId.make("codex"), operation: "session", detail: "This subscription is exhausted. Select an eligible account for new work." });
    expect(providerSetupFailureDetail(new Error("outer", { cause: new Error("middle", { cause: denial }) }))).toBe(denial.detail);
  });
  it("does not expose arbitrary raw errors or recurse through cycles", () => {
    const raw = new Error("synthetic private payload");
    expect(providerSetupFailureDetail(raw)).toBeUndefined();
    raw.cause = raw;
    expect(providerSetupFailureDetail(raw)).toBeUndefined();
  });
});
