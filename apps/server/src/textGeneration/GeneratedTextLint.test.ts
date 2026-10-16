import { describe, expect, it } from "vite-plus/test";

import { cleanGeneratedText, lintGeneratedText } from "./GeneratedTextLint.ts";

const kinds = (text: string) => lintGeneratedText(text).map((issue) => issue.kind);

describe("lintGeneratedText", () => {
  it("flags em dashes, en dashes, curly quotes, chatbot phrases and agent credits", () => {
    const text = [
      "Fix the login loop — it retried forever",
      "Pages 1–3 use “smart” and ‘single’ quotes",
      "Certainly! I hope this helps.",
      "As an AI language model, I cannot run tests.",
      "",
      "Co-authored-by: Claude <noreply@anthropic.com>",
      "Claude-Session: https://claude.ai/code/session_01ExampleSessionId",
      "\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)",
    ].join("\n");
    expect(lintGeneratedText(text)).toEqual([
      { kind: "em-dash", text: "—", line: 1 },
      { kind: "en-dash", text: "–", line: 2 },
      { kind: "curly-quote", text: "‘", line: 2 },
      { kind: "curly-quote", text: "’", line: 2 },
      { kind: "curly-quote", text: "“", line: 2 },
      { kind: "curly-quote", text: "”", line: 2 },
      { kind: "chatbot-phrase", text: "Certainly!", line: 3 },
      { kind: "chatbot-phrase", text: "I hope this helps", line: 3 },
      { kind: "chatbot-phrase", text: "As an AI language model", line: 4 },
      {
        kind: "ai-attribution",
        text: "Co-authored-by: Claude <noreply@anthropic.com>",
        line: 6,
      },
      {
        kind: "ai-attribution",
        text: "Claude-Session: https://claude.ai/code/session_01ExampleSessionId",
        line: 7,
      },
      {
        kind: "ai-attribution",
        text: "\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)",
        line: 8,
      },
    ]);
  });

  it("ignores code, quotes and human co-authors", () => {
    const text = [
      "Run `echo —` before the release.",
      "",
      "```text",
      "Co-authored-by: Claude <noreply@anthropic.com> — “quoted”",
      "```",
      "",
      "    indented — example",
      "> Upstream wrote “this” — verbatim.",
      "",
      "Co-authored-by: Alice <alice@example.com>",
    ].join("\n");
    expect(lintGeneratedText(text)).toEqual([]);
  });

  it("passes plain text", () => {
    expect(kinds("Add retry limit to the login loop\n\n- Stop after 3 attempts.")).toEqual([]);
  });
});

describe("cleanGeneratedText", () => {
  it("removes agent credits from commit and pull request bodies", () => {
    const body = [
      "## Summary",
      "- Stop the login loop after 3 attempts.",
      "",
      "Co-authored-by: Alice <alice@example.com>",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
      "Claude-Session: https://claude.ai/code/session_01ExampleSessionId",
      "",
      "\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)",
      "",
      "https://claude.ai/code/session_01ExampleSessionId",
    ].join("\n");
    expect(cleanGeneratedText(body)).toBe(
      [
        "## Summary",
        "- Stop the login loop after 3 attempts.",
        "",
        "Co-authored-by: Alice <alice@example.com>",
      ].join("\n"),
    );
  });

  it.each([
    ["Fix the login loop — it retried forever", "Fix the login loop, it retried forever"],
    ["Fix the login loop—it retried forever", "Fix the login loop, it retried forever"],
    ["Keep the fix — a one-line change — small", "Keep the fix, a one-line change, small"],
    ["Settings – Agents", "Settings, Agents"],
    ["Pages 1–3 and 2020 — 2024", "Pages 1-3 and 2020-2024"],
    ["Jan–Mar", "Jan-Mar"],
    ["Wait —", "Wait"],
    ["Done. — Next step", "Done. Next step"],
    ["— first item", "- first item"],
    ["Run `npm test` — then ship", "Run `npm test`, then ship"],
    ["Use “smart” and ‘single’ quotes", "Use \"smart\" and 'single' quotes"],
    ["It’s fixed", "It's fixed"],
    ["\u{1F916} Add retry limit", "Add retry limit"],
    ["Certainly! Add retry limit", "Add retry limit"],
    ["| e2e | — |", "| e2e | - |"],
    ["| lint | – |", "| lint | - |"],
    ["| — skipped on Windows |", "| skipped on Windows |"],
    ["Retry once (— at most)", "Retry once (at most)"],
    [
      "See [the result](https://en.wikipedia.org/wiki/Michelson–Morley_experiment) — it held",
      "See [the result](https://en.wikipedia.org/wiki/Michelson–Morley_experiment), it held",
    ],
  ])("normalises %j", (input, expected) => {
    expect(cleanGeneratedText(input)).toBe(expected);
    expect(lintGeneratedText(expected)).toEqual([]);
  });

  it("drops chatbot sign-off lines and the blank lines around them", () => {
    expect(
      cleanGeneratedText(
        [
          "## Summary",
          "- Add a retry limit.",
          "",
          "I hope this helps!",
          "",
          "## Testing",
          "- `pnpm test`",
          "",
          "Let me know if you have any questions.",
          "Happy coding! \u{1F389}",
        ].join("\n"),
      ),
    ).toBe(["## Summary", "- Add a retry limit.", "", "## Testing", "- `pnpm test`"].join("\n"));
  });

  it("keeps a line that starts like a sign-off but carries a caveat", () => {
    const text = [
      "- Let me know if the Windows build fails, I could not test it there.",
      "Let me know if CI flakes on macOS; the retry is untested.",
    ].join("\n");
    expect(cleanGeneratedText(text)).toBe(text);
  });

  it("drops a line holding only a robot emoji without leaving a double blank line", () => {
    expect(cleanGeneratedText("Add retry limit\n\n\u{1F916}\n\nStop after 3 attempts.")).toBe(
      "Add retry limit\n\nStop after 3 attempts.",
    );
  });

  it("keeps code, quotes and chatbot phrases inside a sentence", () => {
    const text = [
      "Explain why `a — b` fails and let me know if the fix holds.",
      "",
      "```diff",
      "-const label = “Old” — x;",
      '+const label = "New";',
      "```",
      "",
      "> The issue says “it hangs” — verbatim.",
    ].join("\n");
    expect(cleanGeneratedText(text)).toBe(text);
    expect(kinds(cleanGeneratedText(text))).toEqual(["chatbot-phrase"]);
  });

  it("returns clean text unchanged, including CRLF endings", () => {
    const text = "Add retry limit\r\n\r\n- Stop after 3 attempts.";
    expect(cleanGeneratedText(text)).toBe(text);
    expect(
      cleanGeneratedText("Fix — now\r\n\r\nBody\r\nCo-authored-by: Claude <noreply@anthropic.com>"),
    ).toBe("Fix, now\r\n\r\nBody");
  });

  it("returns an empty string when only credits remain", () => {
    expect(
      cleanGeneratedText(
        "\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-authored-by: Claude <noreply@anthropic.com>",
      ),
    ).toBe("");
  });
});
