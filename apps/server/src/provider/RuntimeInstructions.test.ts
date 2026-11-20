import { describe, expect, it } from "vite-plus/test";
import {
  buildRuntimeInstructions,
  HEADLESS_BROWSER_ENVIRONMENT,
  headlessChildProcessEnvironment,
  responseStyleInstructions,
  STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS,
  STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS,
  STUDIO_HEADLESS_INSTRUCTIONS,
  STUDIO_HEAVY_CHECKS_INSTRUCTIONS,
  STUDIO_MEDIA_INSTRUCTIONS,
  STUDIO_OUTPUT_FORMATTING_INSTRUCTIONS,
  STUDIO_PRESENTATION_INSTRUCTIONS,
  STUDIO_REPORTS_INSTRUCTIONS,
  STUDIO_WRITING_INSTRUCTIONS,
  withHeadlessBrowserEnvironment,
} from "./RuntimeInstructions.ts";
import { ThreadToolkit } from "../mcp/toolkits/thread/tools.ts";
import { ADVISOR_GUIDANCE } from "@specweave-studio/shared/advisor";

describe("headless browser environment", () => {
  it("applies the headless variables over an inherited or provider value", () => {
    const environment = { PATH: "/usr/bin", PWDEBUG: "1", PLAYWRIGHT_HTML_OPEN: "always" };
    expect(withHeadlessBrowserEnvironment(environment)).toEqual({
      PATH: "/usr/bin",
      PWDEBUG: "0",
      PLAYWRIGHT_HTML_OPEN: "never",
    });
    // The caller's environment object is left as it was.
    expect(environment.PWDEBUG).toBe("1");
    expect(withHeadlessBrowserEnvironment(undefined)).toEqual(HEADLESS_BROWSER_ENVIRONMENT);
  });

  it("extends the inherited environment when a child process has none of its own", () => {
    // Effect replaces the child environment unless extendEnv is set, so an
    // absent env must not become a two-variable environment without PATH.
    expect(headlessChildProcessEnvironment({})).toEqual({
      env: { PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
      extendEnv: true,
    });
    expect(headlessChildProcessEnvironment({ extendEnv: false })).toEqual({
      env: { PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
      extendEnv: true,
    });
  });

  it("keeps an explicit child environment and its extendEnv choice", () => {
    expect(headlessChildProcessEnvironment({ env: { HOME: "/h", PWDEBUG: "console" } })).toEqual({
      env: { HOME: "/h", PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
      extendEnv: false,
    });
    expect(
      headlessChildProcessEnvironment({ env: { HOME: "/h" }, extendEnv: true }).extendEnv,
    ).toBe(true);
  });
});

describe("buildRuntimeInstructions", () => {
  it("asks only for the pull requests the server cannot detect", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    // ThreadPullRequestService finds the thread's own branch PR without the agent.
    expect(instructions).toContain(
      "tracks the pull request for this thread's own branch by itself",
    );
    expect(instructions).toContain("each stack layer, another repository");
    expect(instructions).toContain("link_pull_request");
    expect(instructions).toContain("watch_pull_request and end your turn instead of polling");
  });

  it("states the headless rule once and sets what an environment variable can", () => {
    for (const responseStyle of ["concise", "detailed"] as const) {
      const instructions = buildRuntimeInstructions({ harness: "Claude Code", responseStyle });
      expect(instructions.match(/<browser_automation>/g)).toHaveLength(1);
    }
    expect(STUDIO_HEADLESS_INSTRUCTIONS).toContain("headless: true");
    expect(STUDIO_HEADLESS_INSTRUCTIONS).toContain("without the user's approval");
    expect(HEADLESS_BROWSER_ENVIRONMENT).toEqual({ PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" });
  });

  it("sends full suites through the heavy-check gate in the one verification copy", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions.match(/<heavy_checks>/g)).toHaveLength(1);
    expect(instructions).toContain("specweave-studio checks run -- <command>");
    expect(instructions).toContain("specweave-studio checks copy <repository> --ref <ref>");
    expect(instructions).toContain("Never clone the repository per thread");
    // Every turn carries it.
    expect(
      STUDIO_HEAVY_CHECKS_INSTRUCTIONS.replaceAll(/<\/?heavy_checks>/g, "")
        .trim()
        .split(/\s+/).length,
    ).toBeLessThan(60);
  });

  it("does not police the product name: the text agents read already says SpecWithCode", () => {
    for (const responseStyle of ["concise", "detailed"] as const) {
      const instructions = buildRuntimeInstructions({ harness: "Codex", responseStyle });
      expect(instructions).not.toMatch(/\bStudio\b/);
      expect(instructions).toContain("You are running in SpecWithCode");
    }
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort;");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4);");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model;");
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
    expect(writing).toContain("Cut puffery, praise, closing offers, chatbot phrases");
    expect(writing).toContain("stock -ing tails");
    expect(writing).toContain("Avoid em dashes; use a period or comma.");
    expect(writing).toContain(
      "Concise means fewer sentences, not dropped articles, verbs or spaces.",
    );
    expect(writing).toContain("ask what makes this look machine-generated, and fix it");
  });

  it("keeps the writing rules within their per-turn budget", () => {
    // About 110 tokens. Every agent turn carries this block, so growth should be a deliberate choice.
    expect(STUDIO_WRITING_INSTRUCTIONS.length).toBeLessThanOrEqual(480);
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
    expect(instructions).toContain("not ISO timestamps");
    expect(instructions).toContain("in the user's timezone when known, otherwise the source's");
    expect(instructions).toContain("never guess one");
    expect(instructions).toContain("data and quoted errors exactly as they are");
  });

  it("follows Claude Code's Concise rules for users, workers and coordinators", () => {
    const concise = responseStyleInstructions();
    expect(concise).toContain("Lead with the result");
    expect(concise).toContain("Skip narration, restating the request and closing recaps");
    expect(concise).toContain("1-3 sentences");
    expect(concise).toContain("Give full detail when asked");
    // Worker report shape, not a replay.
    expect(concise).toContain("a few plain sentences and the path or link that proves it");
    // A line cap pushed long reports into run-together words (October 25, 2026).
    expect(concise).toContain("put more in a file, never compressed");
    expect(concise).not.toContain("1-3 line");
    expect(concise).toContain("only when needed");
    // reportDocument.ts reads this label to mark the thread Blocked.
    expect(concise).toContain("end with a paragraph opening **Blockers:**");
    // Only the user's own decisions count, so agent-settleable work never reads as Blocked.
    for (const style of ["concise", "detailed"] as const) {
      expect(responseStyleInstructions(style)).toContain(
        "A blocker is a decision only the user can make or a step only they can take outside the app",
      );
      // Steps and Blockers say where the user acts: the reader may be on another machine.
      expect(responseStyleInstructions(style)).toContain(
        'Start each step the user must take with its machine ("On <machine>: ...").',
      );
    }
    expect(concise).toContain("Ask workers and subagents you brief to report the same way");
  });

  it("never caps errors, security warnings or confirmations", () => {
    for (const style of ["concise", "detailed"] as const) {
      const instructions = responseStyleInstructions(style);
      expect(instructions).toContain(
        "Never shorten errors, failing tests, security warnings or confirmations before destructive actions",
      );
      expect(instructions).toContain("quote errors exactly");
      expect(instructions).toContain("give its full path");
    }
    expect(responseStyleInstructions("detailed")).toContain(
      "paragraphs that open with bold labels",
    );
  });

  it.each(["concise", "detailed"] as const)(
    "presents results in the form quickest to grasp in %s mode",
    (responseStyle) => {
      expect(responseStyleInstructions(responseStyle)).toContain(STUDIO_PRESENTATION_INSTRUCTIONS);
    },
  );

  it("keeps simple answers plain and saves visuals for structure and decisions", () => {
    const presentation = STUDIO_PRESENTATION_INSTRUCTIONS;
    expect(presentation).toContain("attention is scarce and tokens are cheap");
    expect(presentation).toContain("Simple answers stay plain text");
    expect(presentation).toContain("never add a visual for its own sake");
    // ChatMarkdown renders Mermaid fences inline.
    expect(presentation).toContain("Mermaid diagram");
    // show_visual diagrams sit whole in the reply.
    expect(presentation).toContain("show_visual or Mermaid diagram");
    expect(presentation).toContain("UI changes a screenshot");
    // A comparison written as a table of paragraphs was unreadable at any width (October 27).
    expect(presentation).toContain("comparisons a table of short cells, then each item's detail");
    expect(presentation).toContain("A decision the user must make");
    expect(presentation).toContain("html_render when available, preview first");
    expect(presentation).toContain("animated explainer video when asked");
    expect(presentation).toContain("walk them through it one step at a time");
    // The October 21 release evidence read "merged7f5f…" and "health200" as one paragraph.
    expect(presentation).toContain("separate paragraphs with a blank line");
    expect(presentation).toContain("keep a space between a label and its value (HTTP 200)");
    expect(presentation).toContain("put hashes, paths and commands in backticks");
    // About 200 tokens on every turn.
    expect(presentation.length).toBeLessThanOrEqual(920);
  });

  it.each(["concise", "detailed"] as const)(
    "keeps reports in SpecWithCode for every provider in %s mode",
    (responseStyle) => {
      for (const harness of ["Claude Code", "Codex", "Cursor", "OpenCode"]) {
        expect(buildRuntimeInstructions({ harness, responseStyle })).toContain(
          STUDIO_REPORTS_INSTRUCTIONS,
        );
      }
    },
  );

  it("saves documents as reports and never links provider-hosted pages", () => {
    const reports = STUDIO_REPORTS_INSTRUCTIONS;
    expect(reports).toContain("live in SpecWithCode");
    expect(reports).toContain("studio_report_save");
    expect(reports).toContain("the increment's reports/ folder");
    expect(reports).toContain("link the saved file");
    // November 13, 2026: a claude.ai artifact link from a Claude desktop session reached a reply.
    expect(reports).toContain("Never publish to or link a provider-hosted page");
    expect(reports).toContain("claude.ai artifacts or docs");
    expect(reports).toContain("import a document another tool made first");
    expect(reports).toContain("its source and original link");
    // About 90 tokens on every turn.
    expect(reports.length).toBeLessThanOrEqual(420);
  });

  it("keeps everything every turn carries within its budget", () => {
    // Bounded shared guidance includes 1130's assignment/goal and no-manual-relay rules.
    // The presentation block added about 190 tokens on purpose (October 21, 2026),
    // and the short-cell comparison rule about 10 more (October 27, 2026).
    // The heavy-check gate rule added about 60 (November 11, 2026).
    // The reports rule added about 100 (November 13, 2026): 5,509 then.
    // The closure protocol moved to studio_thread_record_delivery (November 14, 2026): 4,695.
    // The step-names-its-machine clause added about 20 tokens (1427, November 19, 2026): 4,770.
    for (const responseStyle of ["concise", "detailed"] as const) {
      const instructions = buildRuntimeInstructions({
        harness: "Claude Code",
        model: "claude-opus-5-5",
        responseStyle,
      });
      expect(instructions.length).toBeLessThanOrEqual(4_775);
    }
  });

  it("switches to detailed responses when the user chooses them", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex", responseStyle: "detailed" });
    expect(instructions).toContain(STUDIO_DETAILED_RESPONSE_STYLE_INSTRUCTIONS);
    expect(instructions).not.toContain(STUDIO_CONCISE_RESPONSE_STYLE_INSTRUCTIONS);
    expect(responseStyleInstructions("detailed")).toContain("Never shorten errors");
  });

  it("asks every harness for one embedded image or video and paths for the rest", () => {
    // A path in backticks is only a chip; on a phone it shows no picture of the work.
    expect(STUDIO_MEDIA_INSTRUCTIONS).toContain("one representative image or video");
    expect(STUDIO_MEDIA_INSTRUCTIONS).toContain("![caption](/absolute/path)");
    expect(STUDIO_MEDIA_INSTRUCTIONS).toContain("list the other files as paths");
    for (const harness of ["Claude Code", "Codex", "Cursor", "OpenCode"]) {
      expect(buildRuntimeInstructions({ harness })).toContain(
        `${STUDIO_MEDIA_INSTRUCTIONS}</runtime_info>`,
      );
    }
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness;");
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

it("keeps the closeout rule a worker acts on in both response styles", () => {
  for (const style of ["concise", "detailed"] as const) {
    const text = responseStyleInstructions(style);
    expect(text).toContain("Your work is finished when its owner accepts it or takes what remains");
    expect(text).toContain("never vouch for your own delivery");
    expect(text).toContain("Required CI and readiness gates remain required");
  }
});

// The closure protocol left the per-turn block on November 14, 2026: every
// worker and subagent paid about 200 tokens a turn for rules only the thread
// that owns a goal acts on. That thread reads them where it records delivery.
it("carries the goal owner's closure protocol in studio_thread_record_delivery", () => {
  const text = ThreadToolkit.tools.studio_thread_record_delivery.description ?? "";
  for (const rule of [
    "never ask the user to carry internal messages or handoff receipts",
    "An answered destination decision stays answered",
    "does not release a live owner's work",
    "keep it open through verified activation, cleanup and acceptance",
    "never discharges a parent obligation",
    "Give an external-session limit an owner and nextEvent",
    "Preserve permissions and Stop",
    "acknowledgment-only turns",
    "reuse one event-driven observer for a real dependency",
  ])
    expect(text).toContain(rule);
  for (const style of ["concise", "detailed"] as const)
    expect(responseStyleInstructions(style)).not.toContain("acknowledgment-only turns");
});

it("keeps the response style block near 320 tokens", () => {
  const block = (style: "concise" | "detailed") =>
    responseStyleInstructions(style).split("</response_style>")[0]!;
  // 2,093 characters before the closure protocol moved out; 1,262 then. The step-names-its-
  // machine clause (1427, November 19, 2026) brought it to 1,337.
  expect(block("concise").length).toBeLessThanOrEqual(1_340);
  expect(block("detailed").length).toBeLessThanOrEqual(1_350);
});

describe("advisor guidance", () => {
  const base = { harness: "Codex", model: "gpt-5.5" } as const;

  it("appends the guidance in an <advisor> block after the shared rules", () => {
    const text = buildRuntimeInstructions({ ...base, advisorGuidance: ADVISOR_GUIDANCE });
    expect(text).toContain(`<advisor>\n${ADVISOR_GUIDANCE}\n</advisor>`);
    expect(text.endsWith("</advisor>")).toBe(true);
    expect(text.indexOf("<advisor>")).toBeGreaterThan(
      text.indexOf(STUDIO_HEAVY_CHECKS_INSTRUCTIONS),
    );
  });

  it("adds nothing when the advisor is off", () => {
    const off = buildRuntimeInstructions(base);
    expect(off).not.toContain("<advisor>");
    expect(buildRuntimeInstructions({ ...base, advisorGuidance: undefined })).toBe(off);
    expect(buildRuntimeInstructions({ ...base, advisorGuidance: "  \n " })).toBe(off);
  });
});
