import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  resetDelegatedThreadMemoryForTests,
  resolveCollapseLongReports,
} from "./delegatedThreadMemory";

describe("resolveCollapseLongReports", () => {
  beforeEach(() => resetDelegatedThreadMemoryForTests());

  it("folds in a delegated thread and not in an ordinary one", () => {
    expect(
      resolveCollapseLongReports({
        displayThreadKey: "env:sub",
        activeThreadKey: "env:sub",
        activeIsDelegated: true,
        paintOnly: false,
      }),
    ).toBe(true);
    expect(
      resolveCollapseLongReports({
        displayThreadKey: "env:chat",
        activeThreadKey: "env:chat",
        activeIsDelegated: false,
        paintOnly: false,
      }),
    ).toBe(false);
  });

  it("keeps folding a delegated thread's timeline while it is still painted", () => {
    resolveCollapseLongReports({
      displayThreadKey: "env:sub",
      activeThreadKey: "env:sub",
      activeIsDelegated: true,
      paintOnly: false,
    });
    expect(
      resolveCollapseLongReports({
        displayThreadKey: "env:sub",
        activeThreadKey: "env:chat",
        activeIsDelegated: false,
        paintOnly: true,
      }),
    ).toBe(true);
  });

  it("does not fold an ordinary thread's held timeline when switching into a delegated one", () => {
    expect(
      resolveCollapseLongReports({
        displayThreadKey: "env:chat",
        activeThreadKey: "env:sub",
        activeIsDelegated: true,
        paintOnly: true,
      }),
    ).toBe(false);
  });

  it("keeps folding a known delegated thread before its details load again", () => {
    resolveCollapseLongReports({
      displayThreadKey: "env:sub",
      activeThreadKey: "env:sub",
      activeIsDelegated: true,
      paintOnly: false,
    });
    expect(
      resolveCollapseLongReports({
        displayThreadKey: "env:sub",
        activeThreadKey: "env:sub",
        activeIsDelegated: false,
        paintOnly: false,
      }),
    ).toBe(true);
  });
});
