import { scopeThreadRef, scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import { EnvironmentId, ThreadId, RunId } from "@specweave-studio/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadDiffPanelSelection, useDiffPanelStore } from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      pendingLinkedOpenThreadKey: null,
    }),
  );

  it("defaults each thread to Changes without requiring git status", () => {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("defaults to Changes before a thread is selected", () => {
    expect(selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, null)).toEqual({
      kind: "branch",
      baseRef: null,
    });
  });

  it("keeps a custom base when a generic open selects Changes again", () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectGitScope(THREAD_REF, "branch");
    store.selectTurn(THREAD_REF, RunId.make("turn-1"));
    store.selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
  });

  it("preserves an explicit branch selection", () => {
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("clears incompatible selection fields when changing scopes", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/app.ts");
    store.selectGitScope(THREAD_REF, "unstaged");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });

    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, " origin/main ");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("clears a thread's turn and file when selecting working tree without changing another thread's branch base", () => {
    const otherThreadRef = scopeThreadRef(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-2"),
    );
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/release");
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/app.ts");
    store.selectBranchBaseRef(otherThreadRef, "origin/main");

    store.selectGitScope(THREAD_REF, "unstaged");

    const { byThreadKey } = useDiffPanelStore.getState();
    expect(selectThreadDiffPanelSelection(byThreadKey, THREAD_REF)).toEqual({ kind: "unstaged" });
    expect(selectThreadDiffPanelSelection(byThreadKey, otherThreadRef)).toEqual({
      kind: "branch",
      baseRef: "origin/main",
    });

    store.selectGitScope(THREAD_REF, "branch");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/release" });
  });

  it("increments the reveal request when opening the same turn file again", () => {
    const turnId = RunId.make("turn-1");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId,
      filePath: "src/app.ts",
      revealRequestId: 2,
      origin: "menu",
    });
  });

  it("restores the selected branch base after visiting another scope", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("reconciles a missing turn selection to the latest available turn", () => {
    const missingTurnId = RunId.make("turn-missing");
    const latestTurnId = RunId.make("turn-latest");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, missingTurnId, "src/app.ts");
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [latestTurnId]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId: latestTurnId,
      filePath: "src/app.ts",
      revealRequestId: 1,
      origin: "menu",
    });
  });

  it("records an Open diff link with its subagent attribution", () => {
    const turnId = RunId.make("turn-2");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "/repo/src/app.ts", {
      sourceThreadId: THREAD_REF.threadId,
      attributedTo: { title: "Refactor parser", running: true },
    });

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId,
      filePath: "/repo/src/app.ts",
      revealRequestId: 1,
      origin: "link",
      attributedTo: { title: "Refactor parser", running: true },
    });
  });

  it("never moves a link's turn to the latest turn when its run has no diff", () => {
    const failedTurnId = RunId.make("turn-failed");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, failedTurnId, "src/app.ts", {});
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [RunId.make("turn-latest")]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toMatchObject({ kind: "turn", turnId: failedTurnId, origin: "link" });
  });

  it("drops the attribution of an earlier link when the turn menu picks a turn", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, RunId.make("turn-1"), "src/app.ts", {
      attributedTo: { title: "Refactor parser" },
    });
    store.selectTurn(THREAD_REF, RunId.make("turn-2"));

    const selection = selectThreadDiffPanelSelection(
      useDiffPanelStore.getState().byThreadKey,
      THREAD_REF,
    );
    expect(selection).toMatchObject({ kind: "turn", origin: "menu" });
    expect(selection).not.toHaveProperty("attributedTo");
  });

  it("gives turns stored before links were told apart the menu's origin", async () => {
    const storage = useDiffPanelStore.persist.getOptions().storage!;
    // Written after the store's own last write, as an older version left it.
    await storage.setItem("studio:diff-panel-state:v1", {
      version: 2,
      state: {
        byThreadKey: {
          [scopedThreadKey(THREAD_REF)]: {
            kind: "turn",
            turnId: RunId.make("turn-old"),
            filePath: "src/app.ts",
            revealRequestId: 3,
          },
        },
        branchBaseRefByThreadKey: {},
      },
    });

    await useDiffPanelStore.persist.rehydrate();

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId: RunId.make("turn-old"),
      filePath: "src/app.ts",
      revealRequestId: 3,
      origin: "menu",
    });
  });

  it("keeps a link's turn only for the one diff opening marked before navigating", () => {
    const otherThreadRef = scopeThreadRef(
      EnvironmentId.make("environment-1"),
      ThreadId.make("thread-2"),
    );
    const store = useDiffPanelStore.getState();
    store.markLinkedOpen(THREAD_REF);

    expect(store.takeLinkedOpen(otherThreadRef)).toBe(false);
    expect(store.takeLinkedOpen(THREAD_REF)).toBe(true);
    expect(store.takeLinkedOpen(THREAD_REF)).toBe(false);
  });
});
