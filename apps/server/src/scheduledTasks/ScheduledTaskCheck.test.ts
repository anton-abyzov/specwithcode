import { describe, expect, it } from "vite-plus/test";

import { checkAllowedFor, isModelPinned, routineCoordinatorPrompt } from "./ScheduledTaskCheck.ts";

describe("checkAllowedFor", () => {
  it("allows a check only under full access outside plan mode", () => {
    expect(checkAllowedFor([{ runtimeMode: "full-access", interactionMode: "default" }])).toBe(
      true,
    );
    expect(checkAllowedFor([{ runtimeMode: "auto", interactionMode: "default" }])).toBe(false);
    expect(
      checkAllowedFor([{ runtimeMode: "approval-required", interactionMode: "default" }]),
    ).toBe(false);
    expect(checkAllowedFor([{ runtimeMode: "full-access", interactionMode: "plan" }])).toBe(false);
  });

  it("needs every mode to allow it", () => {
    expect(
      checkAllowedFor([
        { runtimeMode: "full-access", interactionMode: "default" },
        { runtimeMode: "auto-accept-edits", interactionMode: "default" },
      ]),
    ).toBe(false);
  });
});

describe("isModelPinned", () => {
  it("pins only a routine set to use a specific model", () => {
    expect(isModelPinned({})).toBe(false);
    expect(isModelPinned({ modelPinned: false })).toBe(false);
    expect(isModelPinned({ modelPinned: true })).toBe(true);
  });
});

describe("routineCoordinatorPrompt", () => {
  it("names the routine and where its threads should work", () => {
    expect(
      routineCoordinatorPrompt(
        { title: "Disk space watch", workspaceStrategy: { type: "root" } },
        "Check free disk space.",
      ),
    ).toBe(
      'Routine "Disk space watch" fired. Answer it yourself or start the threads it needs.\n\nCheck free disk space.',
    );
    expect(
      routineCoordinatorPrompt(
        {
          title: "Nightly review",
          workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
        },
        "Review yesterday's commits.",
      ),
    ).toContain("Run any thread it needs in a new worktree from main on origin.");
  });
});
