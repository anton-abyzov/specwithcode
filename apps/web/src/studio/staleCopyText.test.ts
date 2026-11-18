import { describe, expect, it } from "vite-plus/test";
import { staleCopyText } from "./staleCopyText";

const words = (reason: string, repository?: string) =>
  staleCopyText({
    skipped: {
      reason,
      message: "The copy there was not updated.",
      ...(repository ? { repository } : {}),
    },
    source: "m4",
    target: "M5",
    projectTitle: "specweave",
  });

describe("staleCopyText", () => {
  it("names the machine and repository that cannot fast-forward, and what to do", () => {
    const diverged = words("local-commits", "repositories/anton-abyzov/specwithcode");
    expect(diverged.headline).toBe("M5's copy will not be updated to m4's latest commits");
    expect(diverged.detail).toBe(
      "repositories/anton-abyzov/specwithcode on M5 has commits m4 does not have, so it cannot fast-forward. Push or merge them on M5, then check again. Nothing on M5 is overwritten: moving anyway leaves it on its older commits.",
    );
    expect(words("dirty", ".").detail).toContain("specweave on M5 has uncommitted changes.");
    expect(words("not-published").detail).toContain(
      "m4's commits in specweave are not on its remote",
    );
  });

  it("falls back to the machine's own words for a reason it does not know", () => {
    expect(words("something-new").detail).toBe(
      "The copy there was not updated. Nothing on M5 is overwritten: moving anyway leaves it on its older commits.",
    );
  });
});
