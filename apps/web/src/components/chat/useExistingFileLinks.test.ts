import { describe, expect, it } from "vite-plus/test";

import { searchRootsForFile, uniqueSearchMatch } from "./useExistingFileLinks";

const page = (paths: ReadonlyArray<string>, truncated = false) => ({
  entries: paths.map((path) => ({ path, kind: "file" })),
  truncated,
});

describe("uniqueSearchMatch", () => {
  it("finds the one file whose path ends with the name", () => {
    expect(
      uniqueSearchMatch(
        page([
          "apps/web/src/components/studio/CoordinatorConversation.tsx",
          "apps/web/src/components/studio/CoordinatorConversation.test.tsx",
        ]),
        "CoordinatorConversation.tsx",
      ),
    ).toEqual({
      kind: "unique",
      path: "apps/web/src/components/studio/CoordinatorConversation.tsx",
    });
  });

  it("finds a unique whole-name match among fuzzy hits", () => {
    expect(
      uniqueSearchMatch(
        page(["apps/server/src/ws.ts", "apps/server/src/wsRpc.ts", "apps/web/src/wsTransport.ts"]),
        "ws.ts",
      ),
    ).toEqual({ kind: "unique", path: "apps/server/src/ws.ts" });
  });

  it("is ambiguous when the name sits in more than one folder", () => {
    expect(
      uniqueSearchMatch(
        page([
          ".specweave/increments/1347-upstream-security-pass/spec.md",
          ".specweave/increments/1442-offline-thread-banner/spec.md",
        ]),
        "spec.md",
      ),
    ).toEqual({ kind: "ambiguous" });
  });

  it("is ambiguous when the search was cut short, whatever the page holds", () => {
    const cut = page(["a/reports/spec.md", "inc-1/spec.md", "apps/server/src/ws.ts"], true);
    expect(uniqueSearchMatch(cut, "reports/spec.md")).toEqual({ kind: "ambiguous" });
    expect(uniqueSearchMatch(cut, "ws.ts")).toEqual({ kind: "ambiguous" });
  });

  it("is ambiguous when two files differ only in case", () => {
    expect(uniqueSearchMatch(page(["a/config.ts", "b/Config.ts"]), "config.ts")).toEqual({
      kind: "ambiguous",
    });
  });

  it("ignores folders that share the name, and finds none without a match", () => {
    const entries = [
      { path: "docs/spec.md", kind: "directory" },
      { path: "apps/web/spec.md", kind: "file" },
    ];
    expect(uniqueSearchMatch({ entries, truncated: false }, "spec.md")).toEqual({
      kind: "unique",
      path: "apps/web/spec.md",
    });
    expect(uniqueSearchMatch(page(["apps/web/specs.md"]), "spec.md")).toEqual({ kind: "none" });
  });
});

describe("searchRootsForFile", () => {
  const roots = ["/ws/inc-1442", "/ws/inc-1441", "/ws"];

  it("stops at an ambiguous root instead of taking a later root's file", async () => {
    const pages: Record<string, ReturnType<typeof page>> = {
      "/ws/inc-1442": page(["spec.md", "old/spec.md"]),
      "/ws/inc-1441": page(["spec.md"]),
      "/ws": page(["docs/spec.md"]),
    };
    expect(await searchRootsForFile(roots, "spec.md", async (root) => pages[root]!)).toBeNull();
  });

  it("stops at a root whose search was cut short", async () => {
    const pages: Record<string, ReturnType<typeof page>> = {
      "/ws/inc-1442": page(["notes/x.md"], true),
      "/ws/inc-1441": page(["spec.md"]),
      "/ws": page([]),
    };
    expect(await searchRootsForFile(roots, "spec.md", async (root) => pages[root]!)).toBeNull();
  });

  it("passes roots that hold none or cannot be searched", async () => {
    const pages: Record<string, ReturnType<typeof page> | null> = {
      "/ws/inc-1442": page(["spec-old.md"]),
      "/ws/inc-1441": null,
      "/ws": page(["docs/report.md"]),
    };
    expect(await searchRootsForFile(roots, "report.md", async (root) => pages[root]!)).toBe(
      "/ws/docs/report.md",
    );
  });
});
