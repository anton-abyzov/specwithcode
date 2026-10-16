import { assert, describe, it } from "@effect/vitest";

import {
  STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
  studioAcpPromptWithInstructions,
  studioOrchestrationPromptForFirstRun,
  studioOrchestrationSystemPrompt,
} from "./StudioOrchestrationInstructions.ts";
import { DelegateTaskTool, ScheduleTaskTool } from "../mcp/toolkits/orchestrator/tools.ts";

describe("SpecWithCode orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "otherwise `delegate_task`");
    assert.include(
      STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "only when the user asks for separate threads",
    );
    assert.include(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "Never block-wait");
    assert.include(
      STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Never ask for, invent or repeat a secret",
    );
  });

  it("leaves how to call each tool to that tool's description", () => {
    // Moved out of the per-turn prose; the tool carries it to whoever calls it.
    assert.include(
      DelegateTaskTool.description,
      "call delegate_task again with the original brief",
    );
    assert.include(
      DelegateTaskTool.description,
      "not the target for starting another delegated review round",
    );
    assert.include(ScheduleTaskTool.description, "STRUCTURED OBJECT, never JSON text");
    assert.include(ScheduleTaskTool.description, "bindToCurrentThread=true");
    assert.notInclude(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "everyMs");
    assert.notInclude(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "workspaceStrategy");
    assert.notInclude(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "<browser_automation>");
    // About 270 tokens; it was about 1,900.
    assert.isAtMost(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS.length, 1_200);
  });

  it("tells only ACP agents about the terminal bridge", () => {
    assert.notInclude(STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS, "STUDIO_ACP_MCP_NODE");
    assert.include(
      studioAcpPromptWithInstructions({
        prompt: "Inspect the repository.",
        state: { interactionMode: "default", hasStudioMcp: true },
      }),
      "STUDIO_ACP_MCP_NODE",
    );
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
