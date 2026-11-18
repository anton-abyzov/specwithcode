import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_OFF_HEADING,
  SPECWEAVE_NOT_ALLOWED_WRITE,
  boardOffersNotNow,
  boardSetupCopy,
  boardStoredFailure,
  incrementBoardNote,
  lastUserMessageAt,
  specweaveAnswersSupported,
  specweaveCardShown,
  specweaveCardState,
  specweavePollWhile,
  specweaveSetupFailureOutcome,
  specweaveSetupLabel,
  specweaveSnapshotToolKey,
  specweaveStateOf,
  specweaveStateReason,
} from "./specweaveSetup.logic";

describe("specweaveStateOf", () => {
  it("reads the state, then an older server's boolean, then nothing", () => {
    expect(specweaveStateOf({ specweave: false, specweaveState: "unfinished" })).toBe("unfinished");
    expect(specweaveStateOf({ specweave: true })).toBe("on");
    expect(specweaveStateOf({ specweave: false })).toBe("off");
    expect(specweaveStateOf({})).toBeUndefined();
    expect(specweaveStateOf(null)).toBeUndefined();
  });

  it("offers answers only where the server sends the state", () => {
    expect(specweaveAnswersSupported({ specweaveState: "off" })).toBe(true);
    expect(specweaveAnswersSupported({})).toBe(false);
    expect(boardOffersNotNow({ specweaveState: "off" })).toBe(true);
    expect(boardOffersNotNow({ specweaveState: "off", specweaveDeclined: true })).toBe(false);
    expect(boardOffersNotNow({})).toBe(false);
  });
});

describe("specweaveSetupLabel", () => {
  it("names Git when the folder has none", () => {
    expect(specweaveSetupLabel("set_up", true)).toBe("Set up SpecWeave");
    expect(specweaveSetupLabel("set_up", undefined)).toBe("Set up SpecWeave");
    expect(specweaveSetupLabel("set_up", false)).toBe("Set up Git and SpecWeave");
    expect(specweaveSetupLabel("finish", true)).toBe("Finish setup");
    expect(specweaveSetupLabel("finish", false)).toBe("Set up Git and finish");
  });
});

describe("specweaveCardState", () => {
  const request = (state: Parameters<typeof specweaveCardState>[0]["request"]["state"]) => ({
    state,
  });

  it("keeps a settled card final, whatever this window saw", () => {
    for (const state of ["on", "declined"] as const)
      expect(
        specweaveCardState({
          request: request(state),
          local: { state: "failed", detail: "x" },
          canWrite: true,
        }),
      ).toEqual({ state });
  });

  it("shows this window's own press until the server's card catches up", () => {
    expect(
      specweaveCardState({ request: request("asking"), local: { state: "setting_up" }, canWrite: true }),
    ).toEqual({ state: "setting_up" });
    expect(
      specweaveCardState({
        request: request("asking"),
        local: { state: "node_missing", detail: "no node" },
        canWrite: true,
      }),
    ).toEqual({ state: "node_missing", detail: "no node" });
  });

  it("reads Not allowed in a window that cannot change files", () => {
    expect(specweaveCardState({ request: request("asking"), local: null, canWrite: false })).toEqual({
      state: "not_allowed",
      detail: SPECWEAVE_NOT_ALLOWED_WRITE,
    });
    // A setup another window started still reads Setting up here.
    expect(
      specweaveCardState({ request: request("setting_up"), local: null, canWrite: false }),
    ).toEqual({ state: "setting_up", detail: undefined });
  });

  it("passes the server's reason through", () => {
    expect(
      specweaveCardState({
        request: { state: "failed", detail: "inside another repository" },
        local: null,
        canWrite: true,
      }),
    ).toEqual({ state: "failed", detail: "inside another repository" });
  });
});

describe("specweaveSetupFailureOutcome", () => {
  it("tells Node.js missing, not allowed and a plain failure apart", () => {
    expect(specweaveSetupFailureOutcome({ needs: "node", detail: "Node.js was not found" })).toEqual({
      state: "node_missing",
      detail: "Node.js was not found",
    });
    expect(
      specweaveSetupFailureOutcome({ _tag: "EnvironmentAuthorizationError", message: "no scope" }),
    ).toEqual({ state: "not_allowed", detail: SPECWEAVE_NOT_ALLOWED_WRITE });
    expect(specweaveSetupFailureOutcome(new Error("git init failed"))).toEqual({
      state: "failed",
      detail: "git init failed",
    });
    expect(specweaveSetupFailureOutcome(undefined).state).toBe("failed");
  });

  it("gives every state that needs one a reason", () => {
    expect(specweaveStateReason({ state: "failed" })).toBe(
      "SpecWeave could not be set up in this folder.",
    );
    expect(specweaveStateReason({ state: "node_missing", detail: "x" })).toContain("Node.js");
    expect(specweaveStateReason({ state: "not_allowed", detail: "team rules" })).toBe("team rules");
    expect(specweaveStateReason({ state: "asking" })).toBeNull();
    expect(specweaveStateReason({ state: "on" })).toBeNull();
  });
});

describe("specweaveCardShown", () => {
  const card = {
    threadId: "t1",
    state: "asking" as const,
    updatedAt: "2026-11-18T10:00:00.000Z",
  };

  it("shows only in the thread that asked", () => {
    expect(specweaveCardShown({ request: card, threadId: "t1", lastUserMessageAt: null })).toBe(true);
    expect(specweaveCardShown({ request: card, threadId: "t2", lastUserMessageAt: null })).toBe(false);
    expect(specweaveCardShown({ request: undefined, threadId: "t1", lastUserMessageAt: null })).toBe(
      false,
    );
  });

  it("keeps an open card however the conversation moves", () => {
    expect(
      specweaveCardShown({
        request: card,
        threadId: "t1",
        lastUserMessageAt: "2026-11-18T11:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("lets a settled card go once the person writes again", () => {
    const on = { ...card, state: "on" as const };
    expect(
      specweaveCardShown({ request: on, threadId: "t1", lastUserMessageAt: "2026-11-18T09:00:00.000Z" }),
    ).toBe(true);
    expect(
      specweaveCardShown({ request: on, threadId: "t1", lastUserMessageAt: "2026-11-18T11:00:00.000Z" }),
    ).toBe(false);
  });

  it("polls only while Setting up", () => {
    expect(specweavePollWhile("setting_up")).toBe(true);
    expect(specweavePollWhile("asking")).toBe(false);
    expect(specweavePollWhile(undefined)).toBe(false);
  });
});

describe("specweaveSnapshotToolKey", () => {
  const tool = (id: string, toolName: string, status = "completed") => ({
    kind: "work",
    id,
    entry: { structuredPayload: { type: "dynamic_tool", toolName, status } },
  });

  it("changes when a launch tool or the setup request finishes", () => {
    expect(specweaveSnapshotToolKey([])).toBe("");
    expect(
      specweaveSnapshotToolKey([
        tool("a", "mcp__studio-code__delegate_task"),
        tool("b", "Bash"),
        tool("c", "mcp__studio-code__request_specweave_setup"),
      ]),
    ).toBe("2:c");
    for (const name of ["create_threads", "studio_thread_launch"])
      expect(specweaveSnapshotToolKey([tool("x", `mcp__studio-code__${name}`)])).toBe("1:x");
  });

  it("waits for a call that is still running", () => {
    expect(
      specweaveSnapshotToolKey([tool("a", "mcp__studio-code__delegate_task", "running")]),
    ).toBe("");
  });

  it("finds the newest message the person sent", () => {
    expect(
      lastUserMessageAt([
        { kind: "message", createdAt: "2026-11-18T09:00:00Z", message: { role: "user" } },
        { kind: "message", createdAt: "2026-11-18T10:00:00Z", message: { role: "assistant" } },
        { kind: "work", createdAt: "2026-11-18T11:00:00Z" },
      ]),
    ).toBe("2026-11-18T09:00:00Z");
    expect(lastUserMessageAt([])).toBeNull();
  });
});

describe("boardSetupCopy", () => {
  it("explains the board when SpecWeave is off", () => {
    expect(boardSetupCopy({ kind: "off", gitRepository: true })).toEqual({
      heading: BOARD_OFF_HEADING,
      text: "Plans each piece of work as a short spec with tasks in your repository, and gives the project a board.",
      titles: [],
      button: "Set up SpecWeave",
    });
    expect(boardSetupCopy({ kind: "off", gitRepository: false }).button).toBe(
      "Set up Git and SpecWeave",
    );
  });

  it("counts and names the plans written before setup", () => {
    const copy = boardSetupCopy({
      kind: "unfinished",
      unfinished: { count: 4, titles: ["One", "Two", "Three", "Four"] },
      gitRepository: false,
    });
    expect(copy.heading).toBe("4 plans here are not on the board yet");
    expect(copy.text).toBe(
      "They were written before SpecWeave was set up in this project. Finish setup and they show as cards.",
    );
    expect(copy.titles).toEqual(["One", "Two", "Three"]);
    expect(copy.button).toBe("Set up Git and finish");
    expect(
      boardSetupCopy({ kind: "unfinished", unfinished: { count: 1, titles: ["One"] }, gitRepository: true })
        .heading,
    ).toBe("1 plan here is not on the board yet");
  });

  it("starts from a failure stored on the server", () => {
    expect(boardStoredFailure(undefined)).toBeNull();
    expect(
      boardStoredFailure({ detail: "no node", needsNode: true, failedAt: "2026-11-18T10:00:00Z" }),
    ).toEqual({ state: "node_missing", detail: "no node" });
    expect(boardStoredFailure({ detail: "refused", failedAt: "2026-11-18T10:00:00Z" })).toEqual({
      state: "failed",
      detail: "refused",
    });
  });
});

describe("incrementBoardNote", () => {
  it("marks an increment only while setup is unfinished", () => {
    expect(incrementBoardNote("unfinished")).toBe("Not on the board yet");
    expect(incrementBoardNote("on")).toBeNull();
    expect(incrementBoardNote("off")).toBeNull();
    expect(incrementBoardNote(undefined)).toBeNull();
  });
});
