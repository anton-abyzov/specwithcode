import { describe, expect, it } from "vite-plus/test";

import {
  decideFinishedWorktree,
  type FinishedFolderFacts,
  type FinishedMember,
  type FinishedMemberGit,
  type FinishedWorktreeRules,
  isMediaFile,
  MEDIA_LIMIT_BYTES,
} from "./finishedWorktrees.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-16T12:00:00.000Z");

const git = (overrides: Partial<FinishedMemberGit> = {}): FinishedMemberGit => ({
  branch: "feature",
  changes: false,
  untracked: [],
  ignoredOther: [],
  media: { files: 0, bytes: 0 },
  hiddenTrackedChanges: false,
  stash: false,
  reflogOnlyCommits: 0,
  unpushedCommits: 0,
  restorable: true,
  nestedRepository: false,
  headInDefault: false,
  pullRequest: { state: "open", contentIntegrated: false },
  ...overrides,
});

const member = (
  overrides: Partial<FinishedMemberGit> = {},
  relativePath = "",
  extra: Partial<FinishedMember> = {},
): FinishedMember => ({
  relativePath,
  registration: null,
  locked: false,
  git: git(overrides),
  ...extra,
});

const folder = (overrides: Partial<FinishedFolderFacts> = {}): FinishedFolderFacts => ({
  chats: {
    heads: [{ title: "Worker", state: "resolved" }],
    notQuiet: null,
    newestActivityAt: NOW - DAY,
    pullRequestFinished: false,
  },
  deleted: null,
  chatBranch: "feature",
  outOfReach: null,
  unreadable: null,
  openNearby: null,
  inUse: null,
  processesUnknown: false,
  looseFiles: 0,
  members: [member()],
  ...overrides,
});

const openChat = (activityAgoMs: number | null, pullRequestFinished = true) => ({
  heads: [{ title: "Worker", state: "open" as const }],
  notQuiet: null,
  newestActivityAt: activityAgoMs === null ? null : NOW - activityAgoMs,
  pullRequestFinished,
});

const rules = (overrides: Partial<FinishedWorktreeRules> = {}): FinishedWorktreeRules => ({
  worktreeAfterDays: null,
  worktreeOnMerge: true,
  worktreeOnDelete: false,
  worktreeUnchanged: false,
  removeResolvedWorktrees: true,
  ...overrides,
});

const merged = { state: "merged" as const, contentIntegrated: true };
const closed = { state: "closed" as const, contentIntegrated: false };

describe("finished worktree decision", () => {
  it.each([
    [
      "deleted: every chat deleted, with the delete rule",
      folder({
        chats: null,
        deleted: { cleanupPending: false },
        members: [member({ unpushedCommits: 3 })],
      }),
      rules({ worktreeOnDelete: true }),
      "deleted",
    ],
    [
      "inactive: closed chats quiet for the configured days, commits unpushed",
      folder({ members: [member({ unpushedCommits: 2 })] }),
      rules({ worktreeAfterDays: 1, removeResolvedWorktrees: false }),
      "inactive",
    ],
    [
      "unchanged: closed chats and no commits of its own",
      folder({ members: [member({ headInDefault: true })] }),
      rules({ worktreeUnchanged: true }),
      "unchanged",
    ],
    [
      "merged: a resolved chat's merged pull request with its content on the default branch",
      folder({ members: [member({ unpushedCommits: 4, pullRequest: merged })] }),
      rules({ removeResolvedWorktrees: false }),
      "merged",
    ],
    [
      "closed: a closed pull request with every commit pushed",
      folder({ members: [member({ pullRequest: closed })] }),
      rules({ removeResolvedWorktrees: false }),
      "closed",
    ],
    [
      "merged: an open chat quiet for six hours",
      folder({ chats: openChat(6 * HOUR), members: [member({ pullRequest: merged })] }),
      rules(),
      "merged",
    ],
    [
      "resolved: a resolved chat with an open pull request and everything pushed",
      folder(),
      rules(),
      "resolved",
    ],
    [
      "resolved: an archived chat whose unpushed commits are on the default branch",
      folder({
        chats: { ...folder().chats!, heads: [{ title: "Worker", state: "archived" }] },
        members: [member({ unpushedCommits: 2, headInDefault: true })],
      }),
      rules(),
      "resolved",
    ],
    [
      "resolved: two repositories, both pushed",
      folder({ members: [member(), member({ branch: "other" }, "repositories/a/b")] }),
      rules(),
      "resolved",
    ],
  ] as const)("removes it when %s", (_name, facts, rulesInForce, reason) => {
    expect(decideFinishedWorktree(facts, rulesInForce, NOW)).toMatchObject({
      action: "remove",
      reason,
    });
  });

  it.each([
    [
      "broken-registration",
      folder({
        chats: openChat(DAY),
        members: [member({}, "", { registration: "It points elsewhere." })],
      }),
      rules(),
    ],
    ["running", folder({ chats: { ...folder().chats!, notQuiet: "Review" } }), rules()],
    [
      "running",
      folder({ chats: null, deleted: { cleanupPending: true } }),
      rules({ worktreeOnDelete: true }),
    ],
    ["open", folder({ chats: openChat(DAY, false) }), rules()],
    ["open", folder({ openNearby: "Another chat works in a folder inside it." }), rules()],
    ["recent", folder({ chats: openChat(5 * HOUR) }), rules()],
    ["recent", folder({ chats: openChat(null) }), rules()],
    ["changes", folder({ members: [member({ changes: true })] }), rules()],
    ["untracked", folder({ members: [member({ untracked: ["notes.md"] })] }), rules()],
    ["untracked", folder({ members: [], looseFiles: 2 }), rules()],
    [
      "unpushed",
      folder({
        members: [
          member({ unpushedCommits: 1, pullRequest: { state: "none", contentIntegrated: false } }),
        ],
      }),
      rules(),
    ],
    ["unpushed", folder({ members: [member({ reflogOnlyCommits: 1 })] }), rules()],
    ["stash", folder({ members: [member({ stash: true })] }), rules()],
    ["ignored-files", folder({ members: [member({ ignoredOther: [".env"] })] }), rules()],
    [
      "media",
      folder({ members: [member({ media: { files: 3, bytes: MEDIA_LIMIT_BYTES + 1 } })] }),
      rules(),
    ],
    ["in-use", folder({ inUse: "A process works in it." }), rules()],
    ["in-use", folder({ members: [member({}, "", { locked: true })] }), rules()],
    ["nested-work", folder({ members: [member({ hiddenTrackedChanges: true })] }), rules()],
    ["nested-work", folder({ members: [member({ nestedRepository: true })] }), rules()],
    ["no-rule", folder({ outOfReach: "It is outside the app's worktree folders." }), rules()],
    ["no-rule", folder(), rules({ worktreeOnMerge: false, removeResolvedWorktrees: false })],
    ["no-rule", folder({ chats: null, deleted: { cleanupPending: false } }), rules()],
    ["unknown", folder({ processesUnknown: true }), rules()],
    ["unknown", folder({ members: [member({ changes: null })] }), rules()],
    ["unknown", folder({ members: [member({ branch: "elsewhere" })] }), rules()],
    ["unknown", folder({ chatBranch: null }), rules()],
    ["unknown", folder({ members: [member({ restorable: false }, "repositories/a/b")] }), rules()],
    ["unknown", folder({ unreadable: "The worktree-set manifest could not be read." }), rules()],
  ] as const)("keeps it as %s", (reason, facts, rulesInForce) => {
    const decision = decideFinishedWorktree(facts, rulesInForce, NOW);
    expect(decision).toMatchObject({ action: "keep", reason });
    expect("needs" in decision).toBe(false);
  });

  it("keeps a closed pull request's folder with an unpushed commit, and any folder with a stash", () => {
    const unpushedClosed = folder({
      members: [member({ unpushedCommits: 1, pullRequest: closed })],
    });
    expect(decideFinishedWorktree(unpushedClosed, rules(), NOW)).toMatchObject({
      action: "keep",
      reason: "unpushed",
    });
    const stashedOpen = folder({
      chats: openChat(7 * HOUR),
      members: [member({ pullRequest: merged, stash: true })],
    });
    expect(decideFinishedWorktree(stashedOpen, rules(), NOW)).toMatchObject({ reason: "stash" });
    // Under every rule, the ones that removed folders before this one included.
    const stashedResolvedMerged = folder({
      members: [member({ pullRequest: merged, stash: true })],
    });
    expect(decideFinishedWorktree(stashedResolvedMerged, rules(), NOW)).toMatchObject({
      action: "keep",
      reason: "stash",
    });
    const stashedDeleted = folder({
      chats: null,
      deleted: { cleanupPending: false },
      members: [member({ stash: true })],
    });
    expect(
      decideFinishedWorktree(stashedDeleted, rules({ worktreeOnDelete: true }), NOW),
    ).toMatchObject({ action: "keep", reason: "stash" });
    const unreadableStash = folder({ members: [member({ pullRequest: merged, stash: null })] });
    expect(decideFinishedWorktree(unreadableStash, rules(), NOW)).toMatchObject({
      action: "keep",
      reason: "unknown",
    });
  });

  it("needs one merged or closed member, and every other one finished, to remove a set", () => {
    const facts = (second: Partial<FinishedMemberGit>) =>
      folder({
        chats: openChat(7 * HOUR),
        members: [member({ pullRequest: merged }), member(second, "repositories/a/b")],
      });
    expect(
      decideFinishedWorktree(
        facts({ pullRequest: { state: "none", contentIntegrated: false }, headInDefault: true }),
        rules(),
        NOW,
      ),
    ).toMatchObject({ action: "remove", reason: "merged" });
    expect(
      decideFinishedWorktree(
        facts({ pullRequest: { state: "open", contentIntegrated: false } }),
        rules(),
        NOW,
      ),
    ).toMatchObject({ action: "keep", reason: "open" });
    expect(
      decideFinishedWorktree(
        folder({
          chats: openChat(7 * HOUR),
          members: [
            member({
              pullRequest: { state: "none", contentIntegrated: false },
              headInDefault: true,
            }),
          ],
        }),
        rules(),
        NOW,
      ),
    ).toMatchObject({ action: "keep", reason: "open" });
  });

  it("asks for each costlier fact only while a rule could still remove the folder", () => {
    const unread = (overrides: Partial<FinishedMemberGit>) =>
      folder({ chats: openChat(7 * HOUR), members: [member(overrides)] });
    expect(
      decideFinishedWorktree(
        folder({ members: [member({}, "", { git: undefined })] }),
        rules(),
        NOW,
      ),
    ).toMatchObject({ needs: "git" });
    expect(
      decideFinishedWorktree(unread({ headInDefault: undefined }), rules(), NOW),
    ).toMatchObject({
      needs: "default-branch",
    });
    expect(decideFinishedWorktree(unread({ pullRequest: undefined }), rules(), NOW)).toMatchObject({
      needs: "pull-request",
    });
    expect(
      decideFinishedWorktree(
        unread({ pullRequest: merged, nestedRepository: undefined }),
        rules(),
        NOW,
      ),
    ).toMatchObject({ needs: "nested-repositories" });
    // An open chat at work needs no Git command and no host lookup at all.
    expect(
      decideFinishedWorktree(
        folder({ chats: openChat(HOUR), members: [member({}, "", { git: undefined })] }),
        rules(),
        NOW,
      ),
    ).toEqual({ action: "keep", reason: "recent", detail: "Quiet for 1 hour; it goes after 6." });
    // A resolved, pushed folder needs no host lookup.
    expect(
      decideFinishedWorktree(
        folder({ members: [member({ pullRequest: undefined, headInDefault: undefined })] }),
        rules({ worktreeOnMerge: false }),
        NOW,
      ),
    ).toMatchObject({ action: "remove", reason: "resolved" });
  });

  it("prefers deleted, then inactive, then unchanged, then merged, then resolved", () => {
    const everything = folder({ members: [member({ headInDefault: true, pullRequest: merged })] });
    const all = rules({ worktreeAfterDays: 1, worktreeUnchanged: true });
    expect(decideFinishedWorktree(everything, all, NOW)).toMatchObject({ reason: "inactive" });
    expect(
      decideFinishedWorktree(everything, { ...all, worktreeAfterDays: null }, NOW),
    ).toMatchObject({ reason: "unchanged" });
    expect(
      decideFinishedWorktree(
        everything,
        { ...all, worktreeAfterDays: null, worktreeUnchanged: false },
        NOW,
      ),
    ).toMatchObject({ reason: "merged" });
  });

  it("never reads an unknown activity time as old, and a future one neither", () => {
    for (const newestActivityAt of [null, NOW + DAY])
      expect(
        decideFinishedWorktree(
          folder({
            members: [member({ unpushedCommits: 1 })],
            chats: { ...folder().chats!, newestActivityAt },
          }),
          rules({ worktreeAfterDays: 1, removeResolvedWorktrees: false, worktreeOnMerge: false }),
          NOW,
        ),
      ).toMatchObject({ action: "keep", reason: "no-rule" });
  });

  it("knows media by its extension", () => {
    expect(["clip.MP4", "shot.png", "report.pdf", "voice.m4a"].every(isMediaFile)).toBe(true);
    expect([".env", "notes.md", "png", "data.json"].some(isMediaFile)).toBe(false);
  });
});
