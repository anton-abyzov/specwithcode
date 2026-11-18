import { describe, expect, it } from "vite-plus/test";
import { sameStaleReason, staleCopyText } from "./staleCopyText";

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
    expect(words("dirty", ".").detail).toContain(
      "specweave on M5 has uncommitted changes, or a submodule that is not checked out.",
    );
    expect(words("not-published").detail).toContain(
      "m4's commits in specweave are not on its remote",
    );
  });

  it("says a failed LFS download after the update as it is, never as older commits", () => {
    const lfs = words("lfs-failed", "assets");
    expect(lfs.headline).toBe("M5's copy was updated, but its Git LFS files did not download");
    expect(lfs.detail).not.toContain("older commits");
    expect(words("missing-repository", "x").detail).toContain(
      "moving anyway starts there without it",
    );
    expect(words("identity-mismatch", "x").detail).toContain("leaves that repository as it is");
  });

  it("falls back to the machine's own words for a reason it does not know", () => {
    expect(words("something-new").detail).toBe(
      "The copy there was not updated. Check the repository on M5, then check again. Nothing on M5 is overwritten: moving anyway leaves that repository as it is.",
    );
  });

  it("treats an anyway as covering only the same reason in the same repository", () => {
    const a = { reason: "dirty", message: "m" };
    expect(sameStaleReason(a, { ...a, repository: "." })).toBe(true);
    expect(sameStaleReason(a, { ...a, repository: "nested" })).toBe(false);
    expect(sameStaleReason(a, { reason: "local-commits", message: "m" })).toBe(false);
    expect(sameStaleReason(a, null)).toBe(false);
    // New unsafe Git keys are a new reason the person has not seen.
    const unsafe = { reason: "unsafe-git-config", message: "m", unsafeConfig: ["core.fsmonitor"] };
    expect(sameStaleReason(unsafe, { ...unsafe })).toBe(true);
    expect(
      sameStaleReason(unsafe, { ...unsafe, unsafeConfig: ["core.fsmonitor", "core.hooksPath"] }),
    ).toBe(false);
  });

  it("words the anyway choice for what it really leaves", () => {
    expect(words("local-commits", "x").anyway).toBe("Make M5 main anyway, on its older commits");
    expect(words("lfs-failed", "x").anyway).toBe("Make M5 main anyway, without those large files");
    expect(words("missing-repository", "x").anyway).toBe("Make M5 main anyway, without x");
    expect(words("identity-mismatch", "x").anyway).toBe("Make M5 main anyway, with x as it is");
  });
});
