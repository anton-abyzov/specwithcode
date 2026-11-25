import {
  DEFAULT_GITHUB_STAR_PROMPT,
  mergeGitHubStarPrompt,
  type GitHubStarPrompt,
  type GitHubStarUsage,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  answerStarPrompt,
  isStarPromptDue,
  noteStartedTurn,
  setStarPromptEnabled,
} from "./githubStarPrompt.logic";

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-11-01T10:00:00.000Z");
const usedEnough: GitHubStarUsage = {
  firstUsedAt: new Date(START).toISOString(),
  threadKeys: ["a", "b", "c", "d", "e"],
};

describe("noteStartedTurn", () => {
  it("records the first use and each new thread, up to five", () => {
    let usage: GitHubStarUsage = { firstUsedAt: null, threadKeys: [] };
    for (const key of ["a", "a", "b", "c", "d", "e", "f"]) {
      usage = noteStartedTurn(usage, key, START) ?? usage;
    }
    expect(usage).toEqual({
      firstUsedAt: new Date(START).toISOString(),
      threadKeys: usedEnough.threadKeys,
    });
  });

  it("makes no write for a thread it already counted", () => {
    expect(noteStartedTurn(usedEnough, "a", START + DAY)).toBeNull();
  });
});

describe("isStarPromptDue", () => {
  it("never asks on first run or before real use", () => {
    expect(
      isStarPromptDue(DEFAULT_GITHUB_STAR_PROMPT, { firstUsedAt: null, threadKeys: [] }, START),
    ).toBe(false);
    const fourThreads = { ...usedEnough, threadKeys: ["a", "b", "c", "d"] };
    expect(isStarPromptDue(DEFAULT_GITHUB_STAR_PROMPT, fourThreads, START + 10 * DAY)).toBe(false);
    expect(isStarPromptDue(DEFAULT_GITHUB_STAR_PROMPT, usedEnough, START + 2 * DAY)).toBe(false);
  });

  it("asks after five threads and three days", () => {
    expect(isStarPromptDue(DEFAULT_GITHUB_STAR_PROMPT, usedEnough, START + 3 * DAY)).toBe(true);
  });

  it("never asks after a star, an exhausted budget or Off", () => {
    const later = START + 400 * DAY;
    for (const status of ["starred", "done", "off"] as const) {
      expect(isStarPromptDue({ status, asks: 0, nextAskAt: null }, usedEnough, later)).toBe(false);
    }
    expect(isStarPromptDue({ status: "asking", asks: 3, nextAskAt: null }, usedEnough, later)).toBe(
      false,
    );
  });
});

describe("answerStarPrompt", () => {
  it("never asks again after Star on GitHub, Already starred or a detected star", () => {
    for (const answer of ["starred-now", "already-starred", "detected"] as const) {
      expect(answerStarPrompt(DEFAULT_GITHUB_STAR_PROMPT, answer, START).status).toBe("starred");
    }
  });

  it("backs off 14 then 30 days, and the third showing is the last", () => {
    const now = START + 3 * DAY;
    const first = answerStarPrompt(DEFAULT_GITHUB_STAR_PROMPT, "shown", now);
    expect(first).toEqual({
      status: "asking",
      asks: 1,
      nextAskAt: new Date(now + 14 * DAY).toISOString(),
    });
    expect(isStarPromptDue(first, usedEnough, now + 13 * DAY)).toBe(false);
    expect(isStarPromptDue(first, usedEnough, now + 14 * DAY)).toBe(true);

    const second = answerStarPrompt(first, "shown", now + 14 * DAY);
    expect(second.asks).toBe(2);
    expect(second.nextAskAt).toBe(new Date(now + 44 * DAY).toISOString());

    const third = answerStarPrompt(second, "shown", now + 44 * DAY);
    expect(third).toEqual({ status: "done", asks: 3, nextAskAt: null });
    expect(isStarPromptDue(third, usedEnough, now + 1000 * DAY)).toBe(false);
  });
});

describe("setStarPromptEnabled", () => {
  it("Off ends asking; On starts a fresh three-ask budget", () => {
    expect(setStarPromptEnabled(false, START).status).toBe("off");
    expect(setStarPromptEnabled(true, START)).toEqual({
      ...DEFAULT_GITHUB_STAR_PROMPT,
      choiceAt: new Date(START).toISOString(),
    });
  });
});

describe("mergeGitHubStarPrompt", () => {
  const starred: GitHubStarPrompt = { status: "starred", asks: 1, nextAskAt: null };
  const off: GitHubStarPrompt = {
    status: "off",
    asks: 0,
    nextAskAt: null,
    choiceAt: "2026-11-20T00:00:00.000Z",
  };
  const done: GitHubStarPrompt = { status: "done", asks: 3, nextAskAt: null };
  const shownOnce: GitHubStarPrompt = {
    status: "asking",
    asks: 1,
    nextAskAt: "2026-12-01T00:00:00.000Z",
  };
  const shownTwice: GitHubStarPrompt = {
    status: "asking",
    asks: 2,
    nextAskAt: "2027-01-01T00:00:00.000Z",
  };

  it("never lets a stale machine's showing undo a star, Off or the last ask", () => {
    for (const settled of [starred, off, done]) {
      expect(mergeGitHubStarPrompt(settled, shownOnce)).toEqual(settled);
      // A machine that never heard of the answer serves the default; it changes nothing.
      expect(mergeGitHubStarPrompt(settled, DEFAULT_GITHUB_STAR_PROMPT)).toEqual(settled);
    }
  });

  it("only moves the count forward", () => {
    expect(mergeGitHubStarPrompt(shownTwice, shownOnce)).toEqual(shownTwice);
    expect(mergeGitHubStarPrompt(shownOnce, shownTwice)).toEqual(shownTwice);
  });

  it("takes a star or Off from anywhere", () => {
    expect(mergeGitHubStarPrompt(shownTwice, starred)).toEqual(starred);
    expect(mergeGitHubStarPrompt(done, off)).toEqual(off);
  });

  it("lets the later switch choice win between Off and On, in either order", () => {
    const onLater = setStarPromptEnabled(true, Date.parse("2026-11-22T00:00:00.000Z"));
    expect(mergeGitHubStarPrompt(off, onLater)).toEqual(onLater);
    expect(mergeGitHubStarPrompt(onLater, off)).toEqual(onLater);
    const shownAfterOn = answerStarPrompt(onLater, "shown", Date.parse("2026-11-26T00:00:00.000Z"));
    expect(mergeGitHubStarPrompt(shownAfterOn, off)).toEqual(shownAfterOn);
    const offLater = setStarPromptEnabled(false, Date.parse("2026-11-28T00:00:00.000Z"));
    expect(mergeGitHubStarPrompt(shownAfterOn, offLater)).toEqual(offLater);
  });
});
