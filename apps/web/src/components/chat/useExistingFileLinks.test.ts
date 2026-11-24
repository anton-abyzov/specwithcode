import { describe, expect, it } from "vite-plus/test";

import { uniqueSearchMatch } from "./useExistingFileLinks";

describe("uniqueSearchMatch", () => {
  it("finds the one file whose path ends with the name", () => {
    const entries = [
      { path: "apps/web/src/components/studio/CoordinatorConversation.tsx" },
      { path: "apps/web/src/components/studio/CoordinatorConversation.test.tsx" },
    ];
    expect(uniqueSearchMatch(entries, false, "CoordinatorConversation.tsx")).toBe(
      "apps/web/src/components/studio/CoordinatorConversation.tsx",
    );
  });

  it("names none when the name sits in more than one folder", () => {
    const entries = [
      { path: ".specweave/increments/1347-upstream-security-pass/spec.md" },
      { path: ".specweave/increments/1442-offline-thread-banner/spec.md" },
    ];
    expect(uniqueSearchMatch(entries, false, "spec.md")).toBeNull();
  });

  it("names none when the search was cut short", () => {
    const entries = [{ path: ".specweave/increments/1347-upstream-security-pass/spec.md" }];
    expect(uniqueSearchMatch(entries, true, "spec.md")).toBeNull();
  });
});
