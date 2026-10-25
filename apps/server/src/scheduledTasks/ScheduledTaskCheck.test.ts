import { describe, expect, it } from "vite-plus/test";

import { checkAllowedFor, isModelPinned } from "./ScheduledTaskCheck.ts";

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
