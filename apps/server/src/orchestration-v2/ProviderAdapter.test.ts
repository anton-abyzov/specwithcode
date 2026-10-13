import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ProviderSetupError } from "@specweave-studio/contracts";
import { providerSetupFailure, providerSetupFailureDetail } from "./ProviderAdapter.ts";

describe("nested provider setup guidance", () => {
  it("unwraps the exact admission guidance through session errors", () => {
    const denial = new ProviderSetupError({ instanceId: ProviderInstanceId.make("codex"), operation: "session", detail: "This subscription is exhausted. Select an eligible account for new work." });
    expect(providerSetupFailureDetail(new Error("outer", { cause: new Error("middle", { cause: denial }) }))).toBe(denial.detail);
  });
  it("retains typed quota metadata through wrappers without classifying arbitrary prose", () => {
    const denial = new ProviderSetupError({ instanceId: ProviderInstanceId.make("codex"), operation: "session", detail: "Quota denied", usageLimit: { resetAt: "2026-10-18T03:58:37.000Z" } });
    expect(providerSetupFailure(new Error("outer", { cause: denial }))?.usageLimit).toEqual(denial.usageLimit);
    expect(providerSetupFailure(new Error("usage limit reached"))).toBeUndefined();
    const generic = new ProviderSetupError({ instanceId: ProviderInstanceId.make("codex"), operation: "session", detail: "usage limit probe failed" });
    expect(providerSetupFailure(generic)?.usageLimit).toBeUndefined();
  });
  it("does not expose arbitrary raw errors or recurse through cycles", () => {
    const raw = new Error("synthetic private payload");
    expect(providerSetupFailureDetail(raw)).toBeUndefined();
    raw.cause = raw;
    expect(providerSetupFailureDetail(raw)).toBeUndefined();
  });
});
