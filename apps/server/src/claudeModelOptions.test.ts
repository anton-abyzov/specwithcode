import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@specweave-studio/contracts";

import { compileClaudeModelSelection } from "./claudeModelOptions.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-fable-5", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "ultracode" },
        ]),
      ),
    ).toMatchObject({
      apiModelId: "claude-fable-5[1m]",
      effort: "xhigh",
      settings: { ultracode: true },
    });
  });

  it("compiles the Ultracode toggle separately from effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-5-5", [
          { id: "effort", value: "medium" },
          { id: "ultracode", value: true },
        ]),
      ),
    ).toMatchObject({ effort: "medium", settings: { ultracode: true } });
    expect(
      compileClaudeModelSelection(selection("claude-opus-5-5", [{ id: "ultracode", value: false }]))
        .settings,
    ).toMatchObject({ ultracode: false });
    expect(
      compileClaudeModelSelection(selection("claude-opus-5-5", [{ id: "effort", value: "high" }]))
        .settings,
    ).not.toHaveProperty("ultracode");
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "ultracode", value: true }]),
      ).settings,
    ).not.toHaveProperty("ultracode");
  });

  it("leaves Ultracode out of the selection identity; the adapter keys it with the mode", () => {
    const identity = (options: NonNullable<ModelSelection["options"]>) =>
      compileClaudeModelSelection(selection("claude-opus-5-5", options)).queryIdentity;
    const unset = [{ id: "effort", value: "medium" }];
    expect(identity([...unset, { id: "ultracode", value: true }])).toBe(identity(unset));
    expect(identity([...unset, { id: "ultracode", value: false }])).toBe(identity(unset));
    expect(identity([{ id: "effort", value: "high" }])).not.toBe(identity(unset));
  });

  it("keeps an explicit toggle over a legacy Ultracode effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-5-5", [
          { id: "effort", value: "ultracode" },
          { id: "ultracode", value: false },
        ]),
      ),
    ).toMatchObject({ effort: "xhigh", settings: { ultracode: false } });
  });

  it("compiles fast mode only for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: true }]))
        .settings,
    ).toEqual({ fastMode: true });
    expect(
      compileClaudeModelSelection(selection("claude-opus-4-6", [{ id: "fastMode", value: false }]))
        .settings,
    ).toEqual({ fastMode: false });
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("compiles the thinking toggle for models that expose it", () => {
    expect(
      compileClaudeModelSelection(selection("claude-haiku-4-5", [{ id: "thinking", value: false }]))
        .settings,
    ).toEqual({ alwaysThinkingEnabled: false });
  });
});
