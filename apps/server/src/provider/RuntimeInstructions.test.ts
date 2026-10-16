import { describe, expect, it } from "vite-plus/test";
import {
  buildRuntimeInstructions,
  responseStyleInstructions,
  STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS,
  STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS,
  STUDIO_OUTPUT_FORMATTING_INSTRUCTIONS,
  STUDIO_WRITING_INSTRUCTIONS,
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

  it.each(["concise", "detailed"] as const)(
    "includes the writing rules once for every harness in %s mode",
    (responseStyle) => {
      for (const harness of ["Claude Code", "Codex", "Cursor", "OpenCode", "Pi", "ACP"]) {
        const instructions = buildRuntimeInstructions({ harness, responseStyle });
        expect(instructions).toContain(STUDIO_WRITING_INSTRUCTIONS);
        expect(instructions.match(/<writing>/g)).toHaveLength(1);
      }
      expect(responseStyleInstructions(responseStyle)).toContain(STUDIO_WRITING_INSTRUCTIONS);
    },
  );

  it("asks for plain, specific prose without compressing it", () => {
    const writing = STUDIO_WRITING_INSTRUCTIONS;
    expect(writing).toContain("Take a position and say why");
    expect(writing).toContain("hedge only real uncertainty");
    expect(writing).toContain("Be specific: a number, file or command, not an adverb.");
    expect(writing).toContain("Say what a thing does");
    expect(writing).toContain("not how it feels");
    expect(writing).toContain("Cut puffery, praise, closing offers, chatbot phrases");
    expect(writing).toContain("stock -ing tails");
    expect(writing).toContain("Avoid em dashes; use a period or comma.");
    expect(writing).toContain("Vary sentence length");
    expect(writing).toContain(
      "Concise means fewer whole sentences, not dropped articles, verbs or arrows.",
    );
    expect(writing).toContain("ask what makes this look machine-generated, and fix it");
  });

  it("keeps the writing rules within their per-turn budget", () => {
    // About 150 tokens. Every agent turn carries this block, so growth should be a deliberate choice.
    expect(STUDIO_WRITING_INSTRUCTIONS.length).toBeLessThanOrEqual(640);
  });

  it.each(["concise", "detailed"] as const)(
    "follows its own punctuation rules in %s mode",
    (responseStyle) => {
      const instructions = buildRuntimeInstructions({ harness: "Codex", responseStyle });
      expect(instructions).not.toMatch(/[\u2013\u2014\u2015\u2018\u2019\u201C\u201D]/);
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
    expect(concise).toContain(
      "a plain message of 1-3 lines, not a replay of your steps or a report",
    );
    expect(concise).toContain("only when the result needs them");
    expect(concise).toContain("end with a paragraph opening **Blockers:**");
    // Other parents relay a short outcome. A project coordinator does not.
    expect(concise).toContain("Do not paste its report");
    expect(concise).toContain(
      "A project coordinator does not relay: the result stays in the worker's thread.",
    );
  });

  it("keeps short concise results plain and reserves reports and pages for results that need them", () => {
    const concise = responseStyleInstructions("concise");
    expect(concise).not.toContain("so SpecWithCode shows it as a report");
    expect(concise).toContain(
      "Build an HTML page only for screenshots, charts, tables or comparisons that prose cannot carry, or when the user asks for one.",
    );
    expect(responseStyleInstructions("detailed")).toContain("so SpecWithCode shows it as a report");
  });

  it("never caps errors, security warnings or a required answer", () => {
    const concise = responseStyleInstructions("concise");
    expect(concise).toContain(
      "These limits never apply to errors, failing tests or security warnings (quote them exactly)",
    );
    expect(concise).toContain("answer markers or output format your task explicitly requires");
    expect(concise).toContain(
      "quote any error, failing test or security warning it reports exactly",
    );
    const detailed = responseStyleInstructions("detailed");
    expect(detailed).toContain("may go beyond 5 lines");
    expect(detailed).toContain("each part a paragraph opening with its bold label");
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

describe("agent instructions", () => {
  it("leads with the Settings > Agents rules when there are any", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Cursor",
      agentInstructions: "  Never block-wait on another thread.  ",
    });
    expect(
      instructions.startsWith(
        "<agent_instructions>\nNever block-wait on another thread.\n</agent_instructions>",
      ),
    ).toBe(true);
    expect(buildRuntimeInstructions({ harness: "Cursor", agentInstructions: " " })).not.toContain(
      "<agent_instructions>",
    );
  });
});
