import { describe, expect, it } from "vite-plus/test";
import {
  buildRuntimeInstructions,
  responseStyleInstructions,
  STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS,
  STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS,
  STUDIO_OUTPUT_FORMATTING_INSTRUCTIONS,
} from "./RuntimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the studio-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it("asks every harness for concise responses by default", () => {
    for (const harness of ["Claude Code", "Codex", "Cursor", "OpenCode"]) {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain(STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS);
      expect(instructions).not.toContain(STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS);
    }
  });

  it.each(["concise", "detailed"] as const)(
    "includes common formatting once for every harness in %s mode",
    (responseStyle) => {
      for (const harness of [
        "Claude Code",
        "Claude Managed Agents beta",
        "Codex",
        "Cursor",
        "OpenCode",
        "Pi",
        "ACP",
      ]) {
        const instructions = buildRuntimeInstructions({ harness, responseStyle });
        expect(instructions).toContain(STUDIO_OUTPUT_FORMATTING_INSTRUCTIONS);
        expect(instructions.match(/<output_formatting>/g)).toHaveLength(1);
      }
      // Pi injects a style constant directly rather than buildRuntimeInstructions.
      expect(responseStyleInstructions(responseStyle)).toContain(
        STUDIO_OUTPUT_FORMATTING_INSTRUCTIONS,
      );
    },
  );

  it("requires readable dates without guessing or changing literal data", () => {
    const instructions = STUDIO_OUTPUT_FORMATTING_INSTRUCTIONS;
    expect(instructions).toContain("month name, day and year");
    expect(instructions).toContain("not raw ISO timestamps");
    expect(instructions).toContain("12/24-hour preference");
    expect(instructions).toContain("include the timezone");
    expect(instructions).toContain("retain the source timezone");
    expect(instructions).toContain("never infer a timezone");
    expect(instructions).toContain("Preserve date-only calendar dates");
    expect(instructions).toContain("Do not guess invalid or ambiguous dates");
    expect(instructions).toContain("explicit exact-output requests take precedence");
    expect(instructions).toContain("raw machine exports such as JSON or CSV exactly");
    expect(instructions).toContain("Quote errors verbatim when required");
    expect(instructions).toContain("give a readable date separately");
  });

  it("keeps structured output readable and missing data distinct from zero", () => {
    const instructions = STUDIO_OUTPUT_FORMATTING_INSTRUCTIONS;
    expect(instructions).toContain("real Markdown bullets or numbered steps");
    expect(instructions).toContain("blank line before the list");
    expect(instructions).toContain("header row, separator row and consistent columns");
    expect(instructions).toContain("Label units and currencies");
    expect(instructions).toContain("right-align numeric columns");
    expect(instructions).toContain("appropriate digit grouping and consistent precision");
    expect(instructions).toContain("currency codes when the symbol is ambiguous");
    expect(instructions).toContain("Do not invent units, currencies or precision");
    expect(instructions).toContain(
      "Distinguish unknown, unavailable and not applicable from zero or an empty value",
    );
  });

  it("follows Claude Code's Concise rules for users, workers and coordinators", () => {
    const concise = responseStyleInstructions();
    expect(concise).toContain(
      "Keep your responses short and direct while doing the work just as thoroughly.",
    );
    expect(concise).toContain("Lead with the result");
    expect(concise).toContain("do not restate the request, your plan or the steps you took");
    expect(concise).toContain("1-3 sentences");
    expect(concise).toContain("without hedging boilerplate");
    expect(concise).toContain("Give full detail when the user asks for it");
    expect(concise).toContain("Never trade correctness for brevity");
    // Worker report shape, not a replay.
    expect(concise).toContain("Outcome");
    expect(concise).toContain("Evidence");
    expect(concise).toContain("Blockers");
    expect(concise).toContain("at most 5 lines, not a replay of your steps");
    // Other parents relay a short outcome. A project coordinator does not.
    expect(concise).toContain("Do not paste its report");
    expect(concise).toContain(
      "A project coordinator does not relay: the result stays in the worker's thread.",
    );
  });

  it("never caps errors, security warnings or a required answer", () => {
    const concise = responseStyleInstructions("concise");
    expect(concise).toContain(
      "The 5-line cap never applies to errors, failing tests or security warnings (quote them exactly)",
    );
    expect(concise).toContain("answer markers or output format your task explicitly requires");
    expect(concise).toContain(
      "quote any error, failing test or security warning it reports exactly",
    );
    const detailed = responseStyleInstructions("detailed");
    expect(detailed).toContain("may go beyond 5 lines");
    expect(detailed).toContain("quote errors exactly");
    expect(detailed).not.toContain("explain what you did and why");
  });

  it("switches to detailed responses when the user chooses them", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex", responseStyle: "detailed" });
    expect(instructions).toContain(STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS);
    expect(instructions).not.toContain(STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS);
    expect(responseStyleInstructions("detailed")).toContain("stay complete");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});
