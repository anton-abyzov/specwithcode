import { describe, expect, it } from "@effect/vitest";
import cases from "@specweave-studio/shared/threadList.cases.json" with { type: "json" };

import { humanPromptText, humanPromptTitle, isHarnessMarkupTitle } from "./AgentSessionPrompt.ts";

describe("humanPromptText", () => {
  it.each([
    ["a Codex setup block", "<environment_context>\n<cwd>/tmp/p</cwd>\n</environment_context>", ""],
    [
      "the AGENTS.md block",
      "# AGENTS.md instructions for /tmp/p\n\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>",
      "",
    ],
    ["a wake line alone", '<wake reason="mention" current-time="2026-10-30T04:18:02Z">', ""],
    ["a session command", "<command-name>/clear</command-name>\n<command-args></command-args>", ""],
    [
      "setup followed by a prompt",
      "<environment_context>\n<cwd>/tmp/p</cwd>\n</environment_context>\n\nCreate a useful project.",
      "Create a useful project.",
    ],
    [
      "a wake line followed by a prompt",
      '<wake reason="mention" current-time="2026-10-30T04:18:02Z">\nPlan my week',
      "Plan my week",
    ],
    [
      "a prompt wrapped by an unknown tag",
      '<wake reason="mention">Log today\'s run</wake>',
      "Log today's run",
    ],
    [
      "a slash command with arguments",
      "<command-message>sw-do</command-message>\n<command-name>/sw-do</command-name>\n<command-args>fix the bug</command-args>",
      "/sw-do fix the bug",
    ],
    ["a reminder before a prompt", "<system-reminder>x</system-reminder>\nFix login", "Fix login"],
    [
      "pasted markup before a question",
      "<div>broken</div> why is this broken",
      "why is this broken",
    ],
  ])("reads %s", (_name, input, expected) => {
    expect(humanPromptText(input)).toBe(expected);
  });

  it.each([
    "<Button> does not render in Safari",
    "a < b and c > d",
    "Fix this:\n<environment_context>x</environment_context>",
    "## My request for Codex:\n\nFix the visible bug",
  ])("leaves a typed prompt alone: %s", (input) => {
    expect(humanPromptText(input)).toBe(input);
  });

  it("titles by the first typed line", () => {
    expect(
      humanPromptTitle("<environment_context>x</environment_context>\n\n  Build the app  \nplease"),
    ).toBe("Build the app");
    expect(humanPromptTitle("<environment_context>x</environment_context>")).toBe("");
    expect(humanPromptTitle("x".repeat(140))).toHaveLength(100);
  });
});

describe("isHarnessMarkupTitle", () => {
  it.each([
    "<environment_context>",
    '<wake reason="mention" current-time="2026-10-30T04:18:',
    "<command-name>/clear</command-name>",
    "# AGENTS.md instructions for /tmp/project",
    "<system-reminder>",
  ])("flags %s", (title) => {
    expect(isHarnessMarkupTitle(title)).toBe(true);
  });

  it.each(["Fix the login page", "<Button> does not render", "a < b", "Imported thread"])(
    "keeps %s",
    (title) => {
      expect(isHarnessMarkupTitle(title)).toBe(false);
    },
  );

  // The iPhone runs the same titles in ThreadListCasesTests.
  it.each(cases.titles)("agrees with the iPhone on $title", ({ title, markup }) => {
    expect(isHarnessMarkupTitle(title)).toBe(markup);
  });
});
