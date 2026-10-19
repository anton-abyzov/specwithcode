import { describe, expect, it } from "vite-plus/test";

import {
  markdownDocument,
  reportBlocker,
  reportDocument,
  reportSentences,
} from "./reportDocument.ts";
import { reportSummary, reportTitle } from "./threadReport.ts";

const WORKER_REPORT = [
  '**Outcome:** Thread rows now show the harness first, then the model. Native threads read "Claude Code · Opus 5.5".',
  "",
  "**Evidence:** commit `d7c074f0b` on local branch `feat/thread-harness-label`, not pushed. Headless screenshots are at `threads-{light,dark}.png`. `npx vp test run --project unit` on the 6 test files: 262/262 pass. The full suite has 5 failures (in `session-logic`, `coordinatorRecovery`), and the same 5 fail on clean `origin/main`; `tsc` shows the same 2 errors with and without the change.",
  "",
  "**Blockers:** none.",
].join("\n");

describe("reportDocument", () => {
  it("lays out an Outcome/Evidence/Blockers report as lead, list section and property", () => {
    const document = reportDocument(WORKER_REPORT)!;
    expect(document.lead).toBe(
      'Thread rows now show the harness first, then the model. Native threads read "Claude Code · Opus 5.5".',
    );
    expect(document.properties).toEqual([{ label: "Blockers", markdown: "None" }]);
    expect(document.sections).toHaveLength(1);
    expect(document.sections[0]!.label).toBe("Evidence");
    expect(document.sections[0]!.markdown.split("\n")).toEqual([
      "- Commit `d7c074f0b` on local branch `feat/thread-harness-label`, not pushed.",
      "- Headless screenshots are at `threads-{light,dark}.png`.",
      "- `npx vp test run --project unit` on the 6 test files: 262/262 pass.",
      "- The full suite has 5 failures (in `session-logic`, `coordinatorRecovery`), and the same 5 fail on clean `origin/main`",
      "- `tsc` shows the same 2 errors with and without the change.",
    ]);
  });

  it("keeps headings as sections, drops the title heading, and leaves lists as written", () => {
    const document = reportDocument(
      [
        "# Review cycle 2",
        "",
        "No critical findings remain.",
        "",
        "## Fixed",
        "",
        "- A",
        "- B",
      ].join("\n"),
    )!;
    expect(document.lead).toBe("No critical findings remain.");
    expect(document.properties).toEqual([]);
    expect(document.sections).toEqual([{ label: "Fixed", markdown: "- A\n- B" }]);
  });

  it("returns null for a report with no labeled parts", () => {
    expect(reportDocument("Just a long answer.\n\nWith two paragraphs.")).toBeNull();
  });

  it("does not split code fences into blocks", () => {
    const document = reportDocument(
      ["**Outcome:** done.", "", "**Log:**", "```", "a", "", "b", "```"].join("\n"),
    )!;
    expect(document.sections).toEqual([{ label: "Log", markdown: "```\na\n\nb\n```" }]);
  });
});

describe("reportDocument with frontmatter", () => {
  it("shows flat frontmatter as properties, lists as chips, and takes the title from it", () => {
    const text = [
      "---",
      "title: OG monitoring call",
      "date: 2026-10-12",
      "review_cycle: 2",
      "tags: [meeting, datadog]",
      "attendees:",
      "  - Anton",
      '  - "Olli"',
      "---",
      "",
      "# OG monitoring call",
      "",
      "Teams call about the operating model.",
      "",
      "## Covered",
      "",
      "- Why the migration paused",
    ].join("\n");
    expect(reportTitle(text, "Thread")).toBe("OG monitoring call");
    expect(reportSummary(text)).toBe("Teams call about the operating model.");
    expect(reportDocument(text)).toEqual({
      lead: "Teams call about the operating model.",
      properties: [
        { label: "Date", markdown: "2026-10-12" },
        { label: "Review cycle", markdown: "2" },
        { label: "Tags", markdown: "", chips: ["meeting", "datadog"] },
        { label: "Attendees", markdown: "", chips: ["Anton", "Olli"] },
      ],
      sections: [{ label: "Covered", markdown: "- Why the migration paused" }],
    });
  });

  it("leaves frontmatter it cannot show flat in the body", () => {
    const text = "---\nmeta:\n  nested: 1\n---\n\nBody.";
    expect(reportDocument(text)).toBeNull();
  });
});

describe("reportSentences", () => {
  it("does not split inside code spans, links or after abbreviations", () => {
    expect(
      reportSentences("Ran `a. B` and [x. Y](u). Fixed e.g. Foo too. Next step; Done"),
    ).toEqual(["Ran `a. B` and [x. Y](u).", "Fixed e.g. Foo too.", "Next step;", "Done"]);
  });
});

describe("reportBlocker", () => {
  it("returns the blocker a report names, as plain text", () => {
    expect(
      reportBlocker(
        "**Outcome:** built.\n\n**Blockers:** Decision needed: ship `1.0.20` today, or wait for the Windows signer?",
      ),
    ).toBe("Decision needed: ship 1.0.20 today, or wait for the Windows signer?");
    expect(reportBlocker("---\nblockers: [Apple notarization key expired]\n---\n\nBody")).toBe(
      "Apple notarization key expired",
    );
    expect(reportBlocker("## Blocked on\n\n- The staging token")).toBe("The staging token");
  });

  it("reads none, no blockers and missing parts as not blocked", () => {
    for (const text of [
      "**Blockers:** none.",
      "**Blockers:** None. The fixture was stale; I fixed it in the same commit.",
      "Blockers: n/a",
      "**Blockers:** no blockers remain.",
      "**Outcome:** done.",
      "Plain answer.",
      "**Blockers:** None — fixed in the same commit.",
      "**Blockers:** -",
      "Blocked: no.",
    ]) {
      expect(reportBlocker(text)).toBeNull();
    }
  });

  it("reads none followed by long notes as not blocked", () => {
    // The Full-window viewer overlay report: notes after `none.` ran past the old 80-character cap.
    expect(
      reportBlocker(
        [
          "**Checks:** `tsc` is clean, and 1,355 unit tests pass.",
          "**Blockers:** none. The Files/diff right panel and the subagent peek still open inside the pane; neither is a pop-up, so I left them. I also patched `useHandoffSourceChanges`, which crashed the headless test page on main.",
        ].join("\n\n"),
      ),
    ).toBeNull();
  });

  it("reads a blocker that opens with no as a blocker", () => {
    expect(reportBlocker("**Blockers:** No access to the staging token; can you grant it?")).toBe(
      "No access to the staging token; can you grant it?",
    );
    expect(reportBlocker("**Blockers:** Nonexistent signing key. Upload it or skip signing?")).toBe(
      "Nonexistent signing key. Upload it or skip signing?",
    );
  });
});

describe("markdownDocument", () => {
  // The opening of a research report as an agent wrote it (October 19, 2026).
  const RESEARCH = [
    "---",
    "title: Project joining, folder handoff and machine pairing",
    "date: October 19, 2026",
    "source: anton-abyzov/specwithcode origin/main 8358add5d9 (read-only checkout ~/Projects/github/studio-live-activity-base)",
    "installed: M4 1.0.54, M3 1.0.53",
    "status: research and design only, nothing implemented",
    "---",
    "",
    "# Project joining, folder handoff and machine pairing",
    "",
    "**Verdict.** Build three things.",
    "",
    "## 1. The session",
    "",
    "| Field | Value |",
    "|---|---|",
    "| App | Claude desktop |",
  ].join("\n");

  it("turns frontmatter into the title and properties and keeps the body as written", () => {
    expect(markdownDocument(RESEARCH)).toEqual({
      title: "Project joining, folder handoff and machine pairing",
      properties: [
        { label: "Date", markdown: "October 19, 2026" },
        {
          label: "Source",
          markdown:
            "anton-abyzov/specwithcode origin/main 8358add5d9 (read-only checkout ~/Projects/github/studio-live-activity-base)",
        },
        { label: "Installed", markdown: "M4 1.0.54, M3 1.0.53" },
        { label: "Status", markdown: "research and design only, nothing implemented" },
      ],
      body: [
        "**Verdict.** Build three things.",
        "",
        "## 1. The session",
        "",
        "| Field | Value |",
        "|---|---|",
        "| App | Claude desktop |",
      ].join("\n"),
    });
  });

  it("names the page from its opening heading and keeps a heading that differs", () => {
    expect(markdownDocument("---\ndate: today\n---\n\n# Notes\n\nBody.")).toMatchObject({
      title: "Notes",
      body: "Body.",
    });
    expect(markdownDocument("---\ntitle: A\n---\n\n# B\n\nBody.")).toMatchObject({
      title: "A",
      properties: [],
      body: "# B\n\nBody.",
    });
  });

  it("shows frontmatter too rich for a table as YAML, never as a rule and a heading", () => {
    expect(markdownDocument("---\nmeta:\n  nested: 1\n---\n\nBody.")).toEqual({
      title: null,
      properties: [],
      body: "~~~~yaml\nmeta:\n  nested: 1\n~~~~\n\nBody.",
    });
  });

  it("keeps a title's own characters and a heading's closing hash only after a space", () => {
    expect(
      markdownDocument("---\ndate: x\n---\n\n# The my_module API for Vec<T>\n\nBody."),
    ).toMatchObject({
      title: "The my_module API for Vec<T>",
      body: "Body.",
    });
    expect(markdownDocument("---\ndate: x\n---\n\n# Learn C#\n\nBody.").title).toBe("Learn C#");
    expect(markdownDocument("---\ndate: x\n---\n\n# Closed ##\n\nBody.").title).toBe("Closed");
    expect(
      markdownDocument("---\ntitle: snake_case_name\n---\n\n# **The** `snake_case_name`\n\nBody."),
    ).toMatchObject({ title: "snake_case_name", body: "# **The** `snake_case_name`\n\nBody." });
    expect(markdownDocument('---\ntitle: "`snake_case_name`"\n---\n\nBody.').title).toBe(
      "snake_case_name",
    );
  });

  it("keeps an indented code block that opens the body", () => {
    expect(markdownDocument("---\ndate: x\n---\n\n    indented code\n    more\n").body).toBe(
      "    indented code\n    more",
    );
  });

  it("leaves rules around prose as written", () => {
    for (const text of [
      "---\n\nNote: draft only\n\n---\n\n# Real\n\nText",
      "---\n\nJust an intro\n\n---",
      "---\nJust an intro\n---\n",
    ]) {
      expect(markdownDocument(text)).toEqual({ title: null, properties: [], body: text });
    }
  });

  it("leaves a file without frontmatter untouched", () => {
    const text = "# Title\n\n---\n\nBody.\n";
    expect(markdownDocument(text)).toEqual({ title: null, properties: [], body: text });
  });
});
