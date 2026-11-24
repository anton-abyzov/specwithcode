import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));

import { ledgerSourcesText } from "./SubscriptionsView";

describe("ledgerSourcesText", () => {
  it("names the machines counted and the ones left out, with why", () => {
    expect(
      ledgerSourcesText(
        ["M5", "m1", "m4"],
        [
          { name: "m3", reason: "no permission" },
          { name: "win", reason: "out of reach" },
        ],
      ),
    ).toBe("Resets counted from M5, m1, m4. Not counted: m3 (no permission), win (out of reach).");
  });
  it("says when every machine was read", () => {
    expect(ledgerSourcesText(["M5"], [])).toBe("Resets counted from M5.");
  });
  it("says when no machine was read", () => {
    expect(ledgerSourcesText([], [{ name: "m4", reason: "could not read" }])).toBe(
      "No machine's reset history was read. Not counted: m4 (could not read).",
    );
  });
});
