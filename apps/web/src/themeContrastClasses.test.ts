import { describe, expect, it } from "vite-plus/test";

// Text classes that fall below WCAG AA in the light or dark palette:
// - muted text faded with an alpha suffix (muted is already tuned to ~4.5:1);
// - status fills (`--destructive`, `--warning`, ...) used as text, which are
//   meant for icons and backgrounds; text uses their `-foreground` pairs;
// - the fixed 0.64 disabled dim, replaced by `--disabled-opacity`.
const UNREADABLE = [
  /(?<![-\w])text-(?:sidebar-muted-foreground|muted-foreground|secondary-label|placeholder)\/\d+/,
  /(?<![-\w])text-(?:destructive|warning|success|info|error)(?:\/\d+)?(?![-\w/])/,
  /(?<![-\w])opacity-64(?!\d)/,
];

const sources = import.meta.glob<string>(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("theme contrast classes", () => {
  it("keeps text classes readable in light and dark themes", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    // Every offender in one run, with its line: a first-match-only scan let a
    // second class in the same file wait for the next run.
    const offenders = Object.entries(sources).flatMap(([path, text]) => {
      const file = path.replace(/^\.\//, "");
      return UNREADABLE.flatMap((pattern) =>
        Array.from(
          text.matchAll(
            new RegExp(
              pattern.source,
              pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
            ),
          ),
          (match) => {
            const line = text.slice(0, match.index).split("\n").length;
            return `${file}:${line}: ${match[0]}`;
          },
        ),
      );
    });
    expect(offenders).toEqual([]);
  });

  it("scans the files that once waited on other branches", () => {
    for (const file of [
      "./components/CommandPalette.tsx",
      "./components/studio/ProjectCreation.tsx",
      "./components/studio/NewProjectFolderPicker.tsx",
      "./components/studio/CoordinatorConversation.tsx",
    ]) {
      expect(sources[file], file).toBeTypeOf("string");
    }
  });
});
