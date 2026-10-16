import { assert, describe, it } from "@effect/vitest";

import {
  STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
  studioAcpPromptWithInstructions,
  studioOrchestrationPromptForFirstRun,
  studioOrchestrationSystemPrompt,
} from "./StudioOrchestrationInstructions.ts";

describe("SpecWithCode orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(
      STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "ordinary top-level SpecWithCode conversations",
    );
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `studio_thread_send` on `childThreadId`",
    );
  });

  it("briefs and relays delegated reports in the chosen response style", () => {
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "Reports from delegated work");
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "Follow the `<response_style>` rules");
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "Claude's Agent tool");
    // The style decides between a plain short result and a labeled report.
    assert.include(
      STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "ask for its final result in that style and pass the style on",
    );
    assert.notInclude(
      STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "so SpecWithCode shows it as a document",
    );
    assert.include(
      STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "A result that fits in a few lines stays a plain message.",
    );
    assert.include(
      STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "long inventories, tables and logs in a file, referenced by path",
    );
    assert.include(
      STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "SpecWithCode marks that thread Blocked",
    );
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "do not paste the whole report");
    assert.include(
      STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "quote any error, failing test or security warning in it exactly",
    );
    // The length rule lives in the response style so Detailed can relax it; a
    // runtime that sends no style block still gets the old 5-line rule.
    assert.include(
      STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "when none is given, keep a delegated report to the outcome in at most 5 short lines",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = studioOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasStudioMcp: true,
    });

    assert.include(injected, "<studio_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      studioOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasStudioMcp: true }),
      prompt,
    );
    assert.equal(
      studioOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasStudioMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the SpecWithCode MCP server is attached", () => {
    assert.equal(studioOrchestrationSystemPrompt(false), undefined);
    assert.equal(studioOrchestrationSystemPrompt(true), STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = studioAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasStudioMcp: true },
    });

    assert.include(injected, "SpecWithCode interaction mode: Default");
    assert.include(injected, "SpecWithCode collaborative browser");
    assert.include(injected, "SpecWithCode orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasStudioMcp: true } as const;

    assert.equal(
      studioAcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      studioAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "SpecWithCode interaction mode: Plan",
    );
    const withoutMcp = studioAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasStudioMcp: false },
    });
    assert.include(withoutMcp, "SpecWithCode interaction mode: Default");
    assert.notInclude(withoutMcp, "SpecWithCode collaborative browser");
    assert.notInclude(withoutMcp, "SpecWithCode orchestration");
  });
});
