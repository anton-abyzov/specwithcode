import { describe, expect, it } from "vite-plus/test";

import {
  ELLIPSIS,
  formatJsonBlocks,
  workerMessagePresentation,
  workerMessageSizeLabel,
} from "./workerMessagePresentation";

// Synthetic text in the shape of real worker messages: run-together words, a
// routing ID, a tool's options object, bare paths.
const DENSE = `Need exactEXISTINGbackend/canonical ownerbinding, no newworker. Userrequests research/updateALLseason5v5/8v8subtypes+3persistentfamilies; categoryowner thread:delegated-task:example-owner has schema/catalogue readonlyauditsactive. Winter/Fallsuccessor explicitly505ONLY, excludes10canonical1009rows andallnewsubtype/family work. Original0952read-onlydisposition explicitlydoesNOTownhistoryAPI files; do NOTassignthembyassumption.1009threadposition745 canonicalacceptance came frommessage:mcp:0f3c9a1e-5b7d-4c2a-9e81-2d6f4b0a7c55:thread-send:plan-ack-2 but senderisnotverifiedthreadID. Asked1009to identify/forwardexistingcanonicalowner. Please bindexactexistingthreadRef androuteauditfindings for supportedAPI DRYRUNONLY afterschemaresults, preserve10rows exclusivity/awards/title/deductions. Allreleaseholdsunchanged.`;
const LAUNCH = `1040 repository registration now exists at revision20. Latest instruction requires asking you before a new top-level writer. Approve one studio_thread_launch for existing increment1040, native Codex gpt-6-astra, workspaceStrategy {type:'worktree',repository:'7d1e2c40-5b8a-4f3e-9a61-0c2b8e4d9f17',baseRef:'main',branch:'fix/1040-project-attention-counts',startFromOrigin:true}, reportBack:true? Current thread cannot rebind. This writer would own remaining implementation/tests/review/PR; I retain coordination, no duplicate edits. Plan /scratch/atlas/.specweave/increments/1040-fix-project-badges/spec.md; audit /scratch/atlas/evidence/project-attention-1040/audit.md. Preserve 1036 notification repair, 1037 navigation, 1039 review and the 1011 hold. No launch yet.`;

/** Every excerpt piece is cut from the text, never written. */
function expectVerbatim(excerpt: string, text: string) {
  const pieces = excerpt
    .split(` ${ELLIPSIS} `)
    .map((piece) => piece.replace(new RegExp(`\\s?${ELLIPSIS}$`), ""));
  for (const piece of pieces) expect(text).toContain(piece);
}

describe("workerMessagePresentation", () => {
  it("shows a short message whole", () => {
    expect(workerMessagePresentation("Done. The PR is green.").excerpt).toBeNull();
  });

  it("folds a dense wall to its opening sentences, words exactly as sent", () => {
    const presentation = workerMessagePresentation(DENSE);
    expect(presentation.excerpt).not.toBeNull();
    const excerpt = presentation.excerpt!;
    expect(
      excerpt.startsWith("Need exactEXISTINGbackend/canonical ownerbinding, no newworker."),
    ).toBe(true);
    expect(excerpt.endsWith(` ${ELLIPSIS}`)).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(300);
    expect(excerpt).not.toContain("message:mcp:");
    expectVerbatim(excerpt, DENSE);
    expect(presentation.characters).toBe(Array.from(DENSE).length);
    expect(presentation.lines).toBe(1);
  });

  it("keeps the question that asks for a decision, and the options object as written", () => {
    const excerpt = workerMessagePresentation(LAUNCH).excerpt!;
    expect(excerpt).toContain("1040 repository registration now exists at revision20.");
    expect(excerpt).toContain(
      "Approve one studio_thread_launch for existing increment1040, native Codex gpt-6-astra, workspaceStrategy {type:'worktree',",
    );
    expect(excerpt).toContain("reportBack:true?");
    expect(excerpt).not.toContain("Current thread cannot rebind");
    expectVerbatim(excerpt, LAUNCH);
  });

  it("prefers a Blockers line over an earlier question", () => {
    const text = [
      "Release check ran on the release branch and stopped at the feed signature step, after every other gate passed in order.",
      "The run log, the manifests and both key fingerprints are saved next to the receipt. ".repeat(
        4,
      ),
      "",
      "Should I wait for the key owner?",
      "",
      "**Blockers:** approve re-signing with the release key, or keep the hold until the key owner checks it (recommended). Nothing else changed.",
    ].join("\n");
    const excerpt = workerMessagePresentation(text).excerpt!;
    expect(excerpt).toContain(
      "**Blockers:** approve re-signing with the release key, or keep the hold until the key owner checks it (recommended).",
    );
    expect(excerpt).not.toContain("Should I wait");
    expectVerbatim(excerpt, text);
  });

  it("never cuts inside a link or code span", () => {
    const link = "[Record the tutorials](studio://thread/thread%3Adelegated-task%3Aexample)";
    const text = `${"word ".repeat(44)}${link} ${"tail ".repeat(140)}`;
    const excerpt = workerMessagePresentation(text).excerpt!;
    expect(excerpt.endsWith(ELLIPSIS)).toBe(true);
    expect(excerpt.includes("[Record") === excerpt.includes(link)).toBe(true);
    expectVerbatim(excerpt, text);
  });

  it("leads with prose, not a heading, code fence or JSON line", () => {
    const text = [
      "## Release check",
      "",
      "```text",
      "ok    lint         0.8s",
      "```",
      '{"status":"pass","checks":12}',
      "",
      `The release check passed on the exact head. ${"Every gate ran in order. ".repeat(30)}`,
    ].join("\n");
    const excerpt = workerMessagePresentation(text).excerpt!;
    expect(excerpt.startsWith("The release check passed on the exact head.")).toBe(true);
  });

  it("shows whole when the excerpt would already be most of it", () => {
    const list = Array.from({ length: 9 }, (_, index) => `- check ${index + 1} ok`).join("\n");
    expect(workerMessagePresentation(list).excerpt).toBeNull();
  });

  it("names how much the fold leaves out", () => {
    const presentation = workerMessagePresentation(DENSE);
    const shown = presentation.excerpt!.replace(new RegExp(`\\s?${ELLIPSIS}$`), "");
    expect(presentation.hidden).toBe(Array.from(DENSE).length - Array.from(shown).length);
    expect(workerMessageSizeLabel(presentation)).toBe(
      `${presentation.hidden.toLocaleString("en-US")} more characters`,
    );
    expect(workerMessageSizeLabel({ excerpt: "x", characters: 1150, lines: 12, hidden: 1 })).toBe(
      "1 more character",
    );
  });

  it("keeps a link whole when its label wraps onto the next line", () => {
    const text = [
      "Short opener here.",
      "See the [deployment",
      `checklist](https://example.com/check) for ${"each step it covers and ".repeat(12)}more.`,
      "",
      "x ".repeat(400).trim(),
    ].join("\n");
    const excerpt = workerMessagePresentation(text).excerpt!;
    expect(excerpt.startsWith("Short opener here.")).toBe(true);
    expect(excerpt.split("[").length).toBe(excerpt.split("]").length);
    expectVerbatim(excerpt, text);
  });
});

describe("formatJsonBlocks", () => {
  it("shows a block that parses as JSON as code, bytes unchanged", () => {
    const json = '{"status":"pass","checks":12,"failed":0}';
    const text = ["Summary the checker wrote:", "", json, "", "Done."].join("\n");
    const formatted = formatJsonBlocks(text);
    expect(formatted).toBe(
      ["Summary the checker wrote:", "", "```json", json, "```", "", "Done."].join("\n"),
    );
    expect(formatted.replace("```json\n", "").replace("\n```", "")).toBe(text);
  });

  it("leaves object-like prose, inline JSON and existing fences alone", () => {
    for (const text of [
      "Options as the tool takes them: {mode:'async', retries:2}.",
      "{mode:'async', retries:2}",
      'Inline {"a":1} stays prose.',
      ["```text", '{"a":1}', "```"].join("\n"),
      "[1, 2",
      "null",
    ])
      expect(formatJsonBlocks(text)).toBe(text);
  });
});
