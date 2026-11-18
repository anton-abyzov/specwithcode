import { describe, expect, it } from "vite-plus/test";

import { composerNotice, specweaveOfferApplies } from "./composerNotice.logic";

describe("composerNotice", () => {
  it("shows one notice, and Full access wins when both apply", () => {
    expect(composerNotice({ accessRecommended: true, specweaveOffered: true })).toBe("access");
    expect(composerNotice({ accessRecommended: true, specweaveOffered: false })).toBe("access");
    expect(composerNotice({ accessRecommended: false, specweaveOffered: true })).toBe("specweave");
    expect(composerNotice({ accessRecommended: false, specweaveOffered: false })).toBeNull();
  });
});

describe("specweaveOfferApplies", () => {
  const snapshot = (fields: Record<string, unknown> = {}) => ({
    settings: { kind: "code" },
    specweave: false,
    specweaveState: "off" as const,
    ...fields,
  });
  const applies = (fields: Record<string, unknown> = {}, extra: Record<string, boolean> = {}) =>
    specweaveOfferApplies({
      snapshot: snapshot(fields) as Parameters<typeof specweaveOfferApplies>[0]["snapshot"],
      coordinator: extra.coordinator ?? true,
      canAnswer: extra.canAnswer ?? true,
    });

  it("offers SpecWeave once to the coordinator of a code project that is off", () => {
    expect(applies()).toBe(true);
  });

  it("never returns once acted on or declined", () => {
    expect(applies({ specweaveAdviceSeen: true })).toBe(false);
    expect(applies({ specweaveDeclined: true })).toBe(false);
  });

  it("stays away where it does not belong", () => {
    expect(applies({ specweaveState: "on", specweave: true })).toBe(false);
    expect(applies({ specweaveState: "unfinished" })).toBe(false);
    expect(applies({ settings: { kind: "personal" } })).toBe(false);
    expect(applies({ settings: { kind: "code", origin: "automated" } })).toBe(false);
    // An older server cannot store the answer, so the line would return forever.
    expect(applies({ specweaveState: undefined })).toBe(false);
    expect(applies({}, { coordinator: false })).toBe(false);
    expect(applies({}, { canAnswer: false })).toBe(false);
    expect(specweaveOfferApplies({ snapshot: null, coordinator: true, canAnswer: true })).toBe(
      false,
    );
  });
});
