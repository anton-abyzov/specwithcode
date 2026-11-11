import { describe, expect, it } from "@effect/vitest";
import cases from "@specweave-studio/shared/threadList.cases.json" with { type: "json" };

import {
  humanPromptText,
  humanPromptTitle,
  isHarnessMarkupTitle,
  legacyImportTitle,
} from "./AgentSessionPrompt.ts";

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
      "a wake block and the relay inside a later one",
      '<wake reason="mention" current-time="2026-10-30T04:18:02Z">Check the queue</wake>\n<relay from="coordinator">Report back</relay>',
      "",
    ],
    ["a scheduled run", "<scheduled-task>Post the weekly digest</scheduled-task>", ""],
    [
      "an AGENTS.md block cut short",
      "# AGENTS.md instructions for /tmp/p\n\n<INSTRUCTIONS>\nRules that never end",
      "",
    ],
    [
      "the AGENTS.md block before a prompt",
      "# AGENTS.md instructions for /tmp/p\n\n<INSTRUCTIONS>\nRules\n</INSTRUCTIONS>\n\nShip it",
      "Ship it",
    ],
    [
      "an attached picture before a prompt",
      "<image name=[Image #1]>\n</image>\nWhat is wrong with this screen?",
      "What is wrong with this screen?",
    ],
    [
      "a slash command with arguments",
      "<command-message>sw-do</command-message>\n<command-name>/sw-do</command-name>\n<command-args>fix the bug</command-args>",
      "/sw-do fix the bug",
    ],
    ["a reminder before a prompt", "<system-reminder>x</system-reminder>\nFix login", "Fix login"],
  ])("reads %s", (_name, input, expected) => {
    expect(humanPromptText(input)).toBe(expected);
  });

  it.each([
    "<Button> does not render in Safari",
    "<Button onClick={go}>Save</Button> is not clickable",
    "<div>broken</div> why is this broken",
    // Tags a person types to structure a prompt are the prompt.
    "<instructions>Refactor the parser</instructions>",
    "<INSTRUCTIONS>Refactor the parser</INSTRUCTIONS>",
    "<permissions>read only</permissions>\nAudit the roles",
    "<task>Fix the login page</task>",
    "<T>",
    "<br>",
    "<image src=hero.png> does not load",
    "<wake> is the tag I mean",
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
    expect(humanPromptTitle("<instructions>Refactor the parser</instructions>")).toBe(
      "<instructions>Refactor the parser</instructions>",
    );
  });

  it("knows the title an earlier import stored", () => {
    expect(legacyImportTitle("\n<environment_context>\n<cwd>/tmp/p</cwd>")).toBe(
      "<environment_context>",
    );
    expect(legacyImportTitle(`<wake reason="mention" at="${"1".repeat(120)}">`)).toHaveLength(100);
    expect(legacyImportTitle("")).toBe("");
  });
});

describe("isHarnessMarkupTitle", () => {
  it.each([
    "<environment_context>",
    '<wake reason="mention" current-time="2026-10-30T04:18:',
    "<command-name>/clear</command-name>",
    "# AGENTS.md instructions for /tmp/project",
    "<system-reminder>",
    '<relay from="coordinator" thread="thr_1">Report back</relay>',
    "<task-notification>",
    "<scheduled-task>Post the weekly digest</scheduled-task>",
    "<wake",
  ])("flags %s", (title) => {
    expect(isHarnessMarkupTitle(title)).toBe(true);
  });

  it.each([
    "Fix the login page",
    "<Button> does not render",
    "a < b",
    "Imported thread",
    // A person can name a thread with a tag of their own.
    "<T>",
    "<Foo",
    "<instructions>Refactor the parser</instructions>",
    "<wakeup> handler never fires",
    "<Wake>",
  ])("keeps %s", (title) => {
    expect(isHarnessMarkupTitle(title)).toBe(false);
  });

  // The iPhone runs the same titles in ThreadListCasesTests.
  it.each(cases.titles)("agrees with the iPhone on $title", ({ title, markup }) => {
    expect(isHarnessMarkupTitle(title)).toBe(markup);
  });
});
