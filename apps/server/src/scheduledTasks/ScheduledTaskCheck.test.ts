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
  it("pins a person's routine and follows the thread for an agent's", () => {
    expect(isModelPinned({ creationSource: "mcp" })).toBe(false);
    expect(isModelPinned({ creationSource: "mcp", modelPinned: true })).toBe(true);
    expect(isModelPinned({ creationSource: "web" })).toBe(true);
  });
});
