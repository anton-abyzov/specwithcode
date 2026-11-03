import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  OrchestrationV2Command,
  type OrchestrationV2Run,
  RunId,
} from "@specweave-studio/contracts";

import {
  acceptsPromptSuggestion,
  latestPromptSuggestionRun,
  normalizePromptSuggestion,
  PROMPT_SUGGESTION_MAX_LENGTH,
} from "./PromptSuggestions.ts";

const first = RunId.make("run:first");
const second = RunId.make("run:second");
const runs = (overrides: Partial<OrchestrationV2Run> = {}) =>
  [
    { id: second, ordinal: 2, status: "completed", ...overrides },
    { id: first, ordinal: 1, status: "completed" },
  ] as unknown as ReadonlyArray<OrchestrationV2Run>;
const generated = { text: "run the tests", source: "generated" } as const;
const provider = { text: "commit it", source: "provider" } as const;

describe("prompt suggestions", () => {
  it("belong to the latest run by ordinal", () => {
    expect(latestPromptSuggestionRun(runs())?.id).toBe(second);
    expect(latestPromptSuggestionRun([])).toBeUndefined();
  });
  it("record only on the latest completed run", () => {
    expect(acceptsPromptSuggestion(runs(), second, generated)).toBe(true);
    expect(acceptsPromptSuggestion(runs(), first, generated)).toBe(false);
    for (const status of ["running", "queued", "failed", "interrupted", "cancelled"] as const)
      expect(acceptsPromptSuggestion(runs({ status }), second, generated)).toBe(false);
  });
  it("keep the provider's own over a generated one", () => {
    expect(acceptsPromptSuggestion(runs({ promptSuggestion: provider }), second, generated)).toBe(
      false,
    );
    expect(acceptsPromptSuggestion(runs({ promptSuggestion: generated }), second, provider)).toBe(
      true,
    );
    expect(acceptsPromptSuggestion(runs({ promptSuggestion: generated }), second, generated)).toBe(
      false,
    );
  });
  it("normalize to one short line", () => {
    expect(normalizePromptSuggestion('  "Run the\n tests"  ')).toBe("Run the tests");
    expect(normalizePromptSuggestion("Suggestion: open a PR")).toBe("open a PR");
    expect(normalizePromptSuggestion("   ")).toBeNull();
    const long = normalizePromptSuggestion("word ".repeat(200))!;
    expect(long.length).toBeLessThanOrEqual(PROMPT_SUGGESTION_MAX_LENGTH);
    expect(long.endsWith("word")).toBe(true);
  });
  it("keeps the record command off the public wire", () => {
    const decoded = Schema.decodeUnknownExit(OrchestrationV2Command)({
      type: "run.prompt-suggestion.record",
      commandId: "command:external",
      threadId: "thread:external",
      runId: second,
      promptSuggestion: provider,
    });
    expect(decoded._tag).toBe("Failure");
  });
});
