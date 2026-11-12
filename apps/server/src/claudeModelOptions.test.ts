import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@specweave-studio/contracts";

import {
  compileClaudeModelSelection,
  describeBackgroundWork,
  describeDeferredClaudeSelection,
} from "./claudeModelOptions.ts";

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

  it("names what waits for background work", () => {
    const identity = (model: string, options: NonNullable<ModelSelection["options"]>) =>
      compileClaudeModelSelection(selection(model, options)).queryIdentity;
    const high = identity("claude-opus-5-5", [{ id: "effort", value: "high" }]);
    expect(
      describeDeferredClaudeSelection(
        high,
        identity("claude-opus-5-5", [{ id: "effort", value: "xhigh" }]),
      ),
    ).toBe("Effort xhigh applies when background work finishes.");
    expect(
      describeDeferredClaudeSelection(
        high,
        identity("claude-opus-5-5", [
          { id: "effort", value: "xhigh" },
          { id: "fastMode", value: true },
        ]),
      ),
    ).toBe("Effort xhigh and fast mode on apply when background work finishes.");
    expect(describeDeferredClaudeSelection(high, high)).toBe(
      "The new model options apply when background work finishes.",
    );
    const xhigh = identity("claude-opus-5-5", [{ id: "effort", value: "xhigh" }]);
    expect(
      describeDeferredClaudeSelection(
        high,
        xhigh,
        describeBackgroundWork([
          { kind: "subagent", description: "Build redesigned Machines join card" },
        ]),
      ),
    ).toBe('Effort xhigh applies when subagent "Build redesigned Machines join card" finishes.');
    expect(
      describeDeferredClaudeSelection(
        high,
        xhigh,
        describeBackgroundWork([{ kind: "subagent", description: "Review" }, { kind: "command" }]),
      ),
    ).toBe('Effort xhigh applies when subagent "Review" and a command finish.');
  });

  it("keeps control characters out of a background work name", () => {
    expect(
      describeBackgroundWork([{ kind: "command", description: "a\tb\u001b[31mc\rsecond" }]),
    ).toEqual({ label: 'command "a b [31mc"', count: 1 });
    expect(
      describeBackgroundWork([{ kind: "subagent", description: "first\u2028second" }]),
    ).toEqual({ label: 'subagent "first"', count: 1 });
  });

  it("names background work by kind, first line and count", () => {
    expect(describeBackgroundWork([])).toBeNull();
    expect(describeBackgroundWork([{ kind: "mystery", description: " " }])).toEqual({
      label: "a background task",
      count: 1,
    });
    expect(
      describeBackgroundWork([
        { kind: "command", description: 'echo "hi"\nsecond line' },
        { kind: "monitor", description: "x".repeat(200) },
        { kind: "workflow", description: "Ship" },
        { kind: "subagent", description: "Fourth" },
        { kind: "subagent", description: "Fifth" },
      ]),
    ).toEqual({
      label: `command "echo 'hi'", monitor "${"x".repeat(79)}…", workflow "Ship" and 2 more`,
      count: 5,
    });
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
