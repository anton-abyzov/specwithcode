import { describe, expect, it } from "vitest";

import { delegatedRuntimeModeWarning, joinLaunchWarnings } from "./delegatedRuntimeMode.ts";

const muse = {
  displayName: "Muse Code",
  supportedRuntimeModes: ["approval-required", "full-access"] as const,
};

describe("delegatedRuntimeModeWarning", () => {
  it("names the mode a Muse worker asked for Auto really runs", () => {
    expect(
      delegatedRuntimeModeWarning({ requested: "auto", parentMode: "full-access", provider: muse }),
    ).toBe(
      "Muse Code has no Auto mode, so this worker runs Supervised. " +
        "Each command it runs waits for a person to approve it in the app; nobody approves for you. " +
        'For unattended work, delegate with runtimeMode "full-access" or to a provider that offers Auto. ' +
        "Muse Code offers Supervised and Full access.",
    );
  });

  it("does not suggest Full access to a parent that cannot grant it", () => {
    const warning = delegatedRuntimeModeWarning({
      requested: "auto",
      parentMode: "auto",
      provider: muse,
    });
    expect(warning).toContain("runs Supervised");
    expect(warning).not.toContain('"full-access"');
    expect(warning).toContain("delegate to a provider that offers Auto");
  });

  it("is silent when the mode is offered, no modes are listed, or the provider is unknown", () => {
    for (const requested of ["approval-required", "full-access"] as const)
      expect(
        delegatedRuntimeModeWarning({ requested, parentMode: "full-access", provider: muse }),
      ).toBeUndefined();
    expect(
      delegatedRuntimeModeWarning({ requested: "auto", parentMode: "auto", provider: {} }),
    ).toBeUndefined();
    expect(
      delegatedRuntimeModeWarning({
        requested: "auto",
        parentMode: "auto",
        provider: { supportedRuntimeModes: [] },
      }),
    ).toBeUndefined();
    expect(
      delegatedRuntimeModeWarning({ requested: "auto", parentMode: "auto", provider: undefined }),
    ).toBeUndefined();
  });

  it("falls back to a generic provider name", () => {
    expect(
      delegatedRuntimeModeWarning({
        requested: "auto-accept-edits",
        parentMode: "full-access",
        provider: { supportedRuntimeModes: ["approval-required"] },
      }),
    ).toMatch(/^This provider has no Auto-accept edits mode, so this worker runs Supervised\./);
  });
});

describe("joinLaunchWarnings", () => {
  it("keeps every warning and drops missing ones", () => {
    expect(joinLaunchWarnings(undefined, undefined)).toBeUndefined();
    expect(joinLaunchWarnings("Pass an increment.", undefined, "Runs Supervised.")).toBe(
      "Pass an increment. Runs Supervised.",
    );
  });
});
