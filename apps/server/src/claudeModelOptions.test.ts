import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@specweave-studio/contracts";

import {
  CLAUDE_DISABLE_ADVISOR_ENV,
  compileClaudeModelSelection,
  describeBackgroundWork,
  describeDeferredClaudeSelection,
  resolveClaudeSessionAdvisor,
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

  it("passes Claude's own advisor as a flag setting or switches it off with a variable", () => {
    const plain = selection("claude-opus-5-5", [{ id: "effort", value: "high" }]);
    const none = compileClaudeModelSelection(plain);
    expect(none.settings).not.toHaveProperty("advisorModel");
    expect(none.environment).toEqual({});
    const model = compileClaudeModelSelection(plain, undefined, {
      kind: "model",
      model: "claude-fable-5-2",
    });
    expect(model.settings).toMatchObject({ advisorModel: "claude-fable-5-2" });
    expect(model.environment).toEqual({});
    const off = compileClaudeModelSelection(plain, undefined, { kind: "disable" });
    expect(off.settings).not.toHaveProperty("advisorModel");
    expect(off.environment).toEqual({ [CLAUDE_DISABLE_ADVISOR_ENV]: "1" });
  });

  it("keys the process on the advisor value, and only when one is passed", () => {
    const plain = selection("claude-opus-5-5", [{ id: "effort", value: "high" }]);
    const identity = (advisor?: Parameters<typeof compileClaudeModelSelection>[2]) =>
      compileClaudeModelSelection(plain, undefined, advisor).queryIdentity;
    // Unchanged when nothing is passed: a thread without the advisor keeps its process.
    expect(Object.keys(JSON.parse(identity()))).toEqual(["apiModelId", "effort", "settings"]);
    const fable = identity({ kind: "model", model: "claude-fable-5-2" });
    expect(identity({ kind: "model", model: "claude-fable-5-2" })).toBe(fable);
    expect(fable).not.toBe(identity());
    expect(identity({ kind: "model", model: "claude-opus-5-5" })).not.toBe(fable);
    expect(identity({ kind: "disable" })).not.toBe(fable);
    expect(identity({ kind: "disable" })).not.toBe(identity());
    expect(describeDeferredClaudeSelection(identity(), fable)).toBe(
      "Claude's built-in advisor on claude-fable-5-2 applies when background work finishes.",
    );
    expect(describeDeferredClaudeSelection(fable, identity({ kind: "disable" }))).toBe(
      "Claude's built-in advisor off applies when background work finishes.",
    );
  });

  it("routes by context size: past the limit to the app's advisor, back under half", () => {
    const route = (contextTokens: number | null, previousRoute: "built-in" | "studio" | null) =>
      resolveClaudeSessionAdvisor({
        claudeAdvisor: { kind: "model", model: "claude-fable-5-2", contextLimit: 1_000 },
        contextTokens,
        previousRoute,
      });
    expect(route(999, null)).toEqual({
      outcome: { kind: "model", model: "claude-fable-5-2" },
      route: "built-in",
    });
    expect(route(1_000, "built-in")).toEqual({ outcome: { kind: "disable" }, route: "studio" });
    expect(route(600, "studio").route).toBe("studio");
    expect(route(499, "studio").route).toBe("built-in");
    expect(route(null, "studio").route).toBe("studio");
    expect(
      resolveClaudeSessionAdvisor({
        claudeAdvisor: { kind: "disable" },
        contextTokens: 10,
        previousRoute: "built-in",
      }),
    ).toEqual({ outcome: { kind: "disable" }, route: null });
    expect(
      resolveClaudeSessionAdvisor({
        claudeAdvisor: undefined,
        contextTokens: 10,
        previousRoute: null,
      }),
    ).toEqual({ outcome: undefined, route: null });
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
