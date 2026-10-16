import { describe, expect, it } from "vite-plus/test";
import type { ThreadId } from "@specweave-studio/contracts";
import { linkPlainThreadMentions, projectMentionThreads } from "./plainThreadMentions";
import { prepareProjectMarkdown } from "./projectWorkspaceModel";
import { linkedThreadIds } from "./projectThreadMentions";

const thread = (id: string, title: string, extra: { deletedAt?: string | null } = {}) => ({
  id: id as ThreadId,
  title,
  deletedAt: extra.deletedAt ?? null,
});

const release = thread("thread:delegated-task:command%3Amcp%3Arel", "Release Chrome extension");
const threads = [
  release,
  thread("docs-1", "Docs"),
  thread("auth-1", "Fix auth flow"),
  thread("chrome-1", "Chrome extension"),
];
const releaseHref = "studio://thread/thread%3Adelegated-task%3Acommand%253Amcp%253Arel";

describe("linkPlainThreadMentions", () => {
  it("links the coordinator's plain mention of a worker", () => {
    expect(linkPlainThreadMentions("Sent to the Release Chrome extension worker.", threads)).toBe(
      `Sent to the [Release Chrome extension](${releaseHref}) worker.`,
    );
  });

  it("links a title at the end of a sentence and prefers the longest title", () => {
    expect(linkPlainThreadMentions("Handed off to Release Chrome extension.", threads)).toBe(
      `Handed off to [Release Chrome extension](${releaseHref}).`,
    );
    expect(linkPlainThreadMentions("The Chrome extension thread is idle.", threads)).toBe(
      "The [Chrome extension](studio://thread/chrome-1) thread is idle.",
    );
  });

  it("needs a cue for a different case or a one-word title", () => {
    expect(linkPlainThreadMentions("Read the docs first.", threads)).toBe("Read the docs first.");
    expect(linkPlainThreadMentions("We should fix auth flow later.", threads)).toBe(
      "We should fix auth flow later.",
    );
    expect(linkPlainThreadMentions("Asked the docs worker.", threads)).toBe(
      "Asked the [docs](studio://thread/docs-1) worker.",
    );
    expect(linkPlainThreadMentions('Ask "Docs" next.', threads)).toBe(
      'Ask "[Docs](studio://thread/docs-1)" next.',
    );
    expect(linkPlainThreadMentions("The fix auth flow thread finished.", threads)).toBe(
      "The [fix auth flow](studio://thread/auth-1) thread finished.",
    );
  });

  it("never links inside code, links, URLs or longer words", () => {
    const untouched = [
      "Run `Release Chrome extension worker` locally.",
      "```\nRelease Chrome extension worker\n```",
      `See [Release Chrome extension](${releaseHref}) worker.`,
      "See [the release](https://example.com/Release Chrome extension).",
      "Open https://example.com/Release-Chrome-extension now.",
      "Pre-Release Chrome extension-builds worker.",
      '<a title="Release Chrome extension worker">x</a>',
    ];
    for (const text of untouched) expect(linkPlainThreadMentions(text, threads)).toBe(text);
  });

  it("links prose around protected spans", () => {
    expect(
      linkPlainThreadMentions("`npm test` passed; tell the Docs worker.\n```\nDocs\n```", threads),
    ).toBe("`npm test` passed; tell the [Docs](studio://thread/docs-1) worker.\n```\nDocs\n```");
  });

  it("skips duplicate, default, deleted and excluded titles", () => {
    expect(
      linkPlainThreadMentions("The Same title worker and the New thread worker.", [
        thread("a", "Same title"),
        thread("b", "same title"),
        thread("c", "New thread"),
      ]),
    ).toBe("The Same title worker and the New thread worker.");
    expect(
      linkPlainThreadMentions("The Old worker thread.", [
        thread("d", "Old worker", { deletedAt: "2026-10-16T00:00:00.000Z" }),
      ]),
    ).toBe("The Old worker thread.");
    expect(
      linkPlainThreadMentions("Tell the Fix auth flow worker.", threads, new Set(["auth-1"])),
    ).toBe("Tell the Fix auth flow worker.");
  });
});

describe("projectMentionThreads", () => {
  it("keeps the project's other live threads", () => {
    const rows = [
      { ...thread("self", "Me"), projectId: "p1" },
      { ...thread("sibling", "Sibling"), projectId: "p1" },
      { ...thread("other", "Other"), projectId: "p2" },
      { ...thread("gone", "Gone", { deletedAt: "2026-10-16T00:00:00.000Z" }), projectId: "p1" },
    ];
    expect(projectMentionThreads(rows, "p1", "self").map((row) => row.id)).toEqual(["sibling"]);
    expect(projectMentionThreads(rows, null, "self")).toEqual([]);
  });
});

describe("prepareProjectMarkdown with plain mentions", () => {
  it("links the plain mention so the message names the thread", () => {
    const text = prepareProjectMarkdown("Sent to the Release Chrome extension worker.", threads);
    expect(text).toBe(`Sent to the [Release Chrome extension](${releaseHref}) worker.`);
    expect(linkedThreadIds(text)).toEqual([release.id]);
  });
});
