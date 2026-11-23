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

  it("finds a unique whole-name match among fuzzy hits", () => {
    const entries = [
      { path: "apps/server/src/ws.ts", kind: "file" },
      { path: "apps/server/src/wsRpc.ts", kind: "file" },
      { path: "apps/web/src/wsTransport.ts", kind: "file" },
    ];
    expect(uniqueSearchMatch(entries, false, "ws.ts")).toBe("apps/server/src/ws.ts");
  });

  it("names none when the search was cut short, whatever the page holds", () => {
    const entries = [
      { path: "a/reports/spec.md", kind: "file" },
      { path: "inc-1/spec.md", kind: "file" },
      { path: "apps/server/src/ws.ts", kind: "file" },
      { path: "apps/server/src/wsRpc.ts", kind: "file" },
    ];
    expect(uniqueSearchMatch(entries, true, "reports/spec.md")).toBeNull();
    expect(uniqueSearchMatch(entries, true, "ws.ts")).toBeNull();
  });

  it("names none when two files differ only in case", () => {
    const entries = [
      { path: "a/config.ts", kind: "file" },
      { path: "b/Config.ts", kind: "file" },
    ];
    expect(uniqueSearchMatch(entries, false, "config.ts")).toBeNull();
  });

  it("ignores folders that share the name", () => {
    const entries = [
      { path: "docs/spec.md", kind: "directory" },
      { path: "apps/web/spec.md", kind: "file" },
    ];
    expect(uniqueSearchMatch(entries, false, "spec.md")).toBe("apps/web/spec.md");
  });
});
