import { describe, expect, it } from "vite-plus/test";

import {
  canonicalLinkKey,
  organizeShelf,
  SHELF_SECTION_LIMIT,
  SHELF_STALE_AFTER_MS,
  searchShelf,
  shelfEntries,
  type ShelfInput,
} from "./artifactShelf";
import type { ThreadArtifact } from "./threadArtifacts";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function link(url: string, name: string, messageId = "m"): ThreadArtifact {
  return { key: url, kind: "link", url, host: new URL(url).hostname, name, messageId };
}

function file(path: string, messageId = "m"): ThreadArtifact {
  const basename = path.split("/").at(-1)!;
  return {
    key: `file:${path}`,
    kind: basename.endsWith(".md") ? "markdown" : basename.endsWith(".png") ? "image" : "file",
    name: basename,
    messageId,
    meta: { filePath: path, basename, workspaceRelativePath: null } as never,
  };
}

function input(artifacts: ThreadArtifact[], overrides: Partial<ShelfInput> = {}): ShelfInput {
  return {
    artifacts,
    mentionedAt: () => NOW - DAY,
    pullRequests: new Map(),
    missingPaths: new Set(),
    pinned: new Set(),
    hidden: new Set(),
    now: NOW,
    ...overrides,
  };
}

describe("canonicalLinkKey", () => {
  it("treats every URL of one pull request as the same thing", () => {
    const keys = [
      "https://github.com/anton-abyzov/specweave/pull/2067",
      "https://github.com/anton-abyzov/specweave/pull/2067/files",
      "https://github.com/Anton-Abyzov/specweave/pull/2067#issuecomment-1",
    ].map(canonicalLinkKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("ignores www, a trailing slash, the fragment, tracking parameters and the scheme", () => {
    expect(canonicalLinkKey("https://www.gittrend.io/repo/?utm_source=x#top")).toBe(
      canonicalLinkKey("http://gittrend.io/repo"),
    );
    expect(canonicalLinkKey("https://example.com/a?page=2")).not.toBe(
      canonicalLinkKey("https://example.com/a?page=3"),
    );
  });
});

describe("shelfEntries", () => {
  it("lists each thing once, newest mention first", () => {
    const entries = shelfEntries(
      input([
        link("https://github.com/acme/app/pull/230/files", "pull/230", "new"),
        link("https://github.com/acme/app/pull/230", "pull/230", "old"),
        link("https://status.spec-weave.com/", "status"),
        link("https://status.spec-weave.com", "status"),
      ]),
    );
    expect(entries.map((entry) => entry.label)).toEqual(["app #230", "status"]);
    expect(entries[0]!.artifact.messageId).toBe("new");
  });

  it("names a pull request by its tracked title and folds it once merged or closed", () => {
    const merged = "https://github.com/acme/app/pull/1";
    const open = "https://github.com/acme/app/pull/2";
    const entries = shelfEntries(
      input([link(merged, "pull/1"), link(open, "pull/2")], {
        mentionedAt: () => NOW - 30 * DAY,
        pullRequests: new Map([
          [canonicalLinkKey(merged), { state: "merged", title: "Ship pins" }],
          [canonicalLinkKey(open), { state: "open", title: "Organize artifacts" }],
        ]),
      }),
    );
    expect(entries.map((entry) => [entry.label, entry.aged])).toEqual([
      ["Ship pins", "merged"],
      // Open stays current however long ago it was named.
      ["Organize artifacts", null],
    ]);
  });

  it("marks a file the host no longer has as missing, and a quiet one as stale", () => {
    const entries = shelfEntries(
      input([file("/tmp/gone.png"), file("/tmp/old.md", "old"), file("/tmp/new.md", "new")], {
        missingPaths: new Set(["/tmp/gone.png"]),
        mentionedAt: (artifact) =>
          artifact.messageId === "old" ? NOW - SHELF_STALE_AFTER_MS - 1 : NOW,
      }),
    );
    expect(entries.map((entry) => entry.aged)).toEqual(["missing", "stale", null]);
  });
});

describe("organizeShelf", () => {
  it("puts pins first, a section per type, and folds Older and Hidden", () => {
    const entries = shelfEntries(
      input(
        [
          file("/Users/me/notes/STEPS.md"),
          link("https://github.com/acme/app/pull/9", "pull/9"),
          link("https://gittrend.io/x", "Gemini Nexus"),
          file("/tmp/report.html"),
          file("/tmp/hidden.md"),
          file("/tmp/old.md", "old"),
        ],
        {
          pinned: new Set(["link:gittrend.io/x"]),
          hidden: new Set(["file:/tmp/hidden.md"]),
          mentionedAt: (artifact) => (artifact.messageId === "old" ? NOW - 30 * DAY : NOW),
        },
      ),
    );
    const shelf = organizeShelf(entries, { query: "", expanded: new Set() });
    expect(
      shelf.sections.map((section) => [section.id, section.total, section.entries.length]),
    ).toEqual([
      ["pinned", 1, 1],
      ["pullRequests", 1, 1],
      ["files", 2, 2],
      ["older", 1, 0],
      ["hidden", 1, 0],
    ]);
    expect(shelf.visibleCount).toBe(5);
    expect(shelf.sections[2]!.entries[0]!.detail).toBe("me/notes");
  });

  it("shows the newest few per section until the section is opened", () => {
    const many = Array.from({ length: 40 }, (_, index) => file(`/tmp/f/${index}.md`));
    const entries = shelfEntries(input(many));
    const closed = organizeShelf(entries, { query: "", expanded: new Set() });
    expect(closed.sections[0]!.entries).toHaveLength(SHELF_SECTION_LIMIT);
    expect(closed.sections[0]!.total).toBe(40);
    const open = organizeShelf(entries, { query: "", expanded: new Set(["files"]) });
    expect(open.sections[0]!.entries).toHaveLength(40);
  });

  it("searches everything, hidden and older included, as one ranked list", () => {
    const entries = shelfEntries(
      input(
        [
          file("/tmp/competitors-2026-10-15.md"),
          link("https://chromeunboxed.com/a", "Chrome Unboxed"),
          file("/tmp/chrome-connection-paths.md"),
          file("/tmp/hidden-chrome.md"),
        ],
        { hidden: new Set(["file:/tmp/hidden-chrome.md"]) },
      ),
    );
    const shelf = organizeShelf(entries, { query: "chrome", expanded: new Set() });
    expect(shelf.sections).toHaveLength(1);
    expect(shelf.sections[0]!.entries.map((entry) => entry.label)).toEqual([
      "Chrome Unboxed",
      "chrome-connection-paths.md",
      "hidden-chrome.md",
    ]);
    expect(searchShelf(entries, "pull requests")).toHaveLength(0);
    expect(searchShelf(entries, "links chrome").map((entry) => entry.label)).toEqual([
      "Chrome Unboxed",
    ]);
  });
});
