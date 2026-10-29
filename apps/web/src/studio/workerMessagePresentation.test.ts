import { MOBILE_CARRY_FORWARD } from "../../tests/agent-messages/internalReceipts";
import { relayAttentionText } from "./workerMessagePresentation";
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
    .split(new RegExp(`\\s${ELLIPSIS} `))
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
    // The ellipsis keeps to the line of the word before it.
    expect(excerpt.endsWith(`\u00A0${ELLIPSIS}`)).toBe(true);
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
    expect(
      workerMessageSizeLabel({
        excerpt: "x",
        clamp: false,
        characters: 1150,
        lines: 12,
        hidden: 1,
      }),
    ).toBe("1 more character");
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

// The shape of the October 25, 2026 coordinator screenshot: one paragraph of
// run-together words, long absolute paths and a disk error, about 1,400 characters.
const ENOSPC_REPORT = `Exactspec /Users/fixture/Projects/atlas/.worktrees/format-clarity-20261023/console-ui/e2e/control-desk-0611.spec.ts:74. OnlyWebKit1440/light retry0failed fullpagescreenshot with exactError: ENOSPC: no space left on device, write; precedingbehavior/overflow/errors assertionsPASS.35passed/1failed. NoE2Especeditjustified. Needownercheck instead for /Users/fixture/Projects/atlas/.worktrees/format-clarity-20261023/console-ui/scripts/ci/e2e-runtime.mjs (postverifiedrestore redundant same-runarchivecleanup+freebytes/inodes evidence) and/or /Users/fixture/Projects/atlas/.worktrees/format-clarity-20261023/console-ui/.github/workflows/e2e.yml. Exactstorageconsumerunproven; don't claimarchivecausedit. RetainedJSON /Volumes/Work/atlas-code/1018-runtime/followup489/layout-diagnosis/playwright-report/control-desk/results.json andoriginalartifactzip. Unitfailurecurrentoffsetreadcontractconfirmed; boundedSeptemberclockpinvalid/testonly, historicaleventoffsetannotation boundedonly. Nosourceedit, no newworkerlaunch, nofreshCI. Remaining: owner reviewofruntimecleanup, exactstorageconsumer, rerunafterbytesfreed. Keepreleaseholds; nopublish, nodeploy. Evidence /Users/fixture/.local/share/atlas/incident-repair-receipts/20261024T230931Z-arena-acceptance/pr373-runtime-source-contract.md and /Users/fixture/.local/share/atlas/incident-repair-receipts/20261024T230931Z-arena-acceptance/pr374-about-correction.md retained.`;

describe("workerMessagePresentation by timeline detail (1068)", () => {
  it("folds sooner in Concise: over 280 characters or 3 lines", () => {
    const short = "Done. The PR is green and the review is clear. ".repeat(5).trim();
    expect(Array.from(short).length).toBeLessThanOrEqual(280);
    expect(workerMessagePresentation(short, short, "concise").excerpt).toBeNull();
    const longer = `${short} The release waits on CI, and nothing else is pending today.`;
    expect(workerMessagePresentation(longer, longer, "normal").excerpt).toBeNull();
    expect(workerMessagePresentation(longer, longer, "concise").excerpt).not.toBeNull();
    const fourLines = [
      "Checked the release branch.",
      "Every gate passed in order except the feed signature step at the end of the run.",
      "The run log, both manifests and the key fingerprints are saved beside the receipt.",
      "Nothing was published, and the release holds stay in place until the owner decides.",
    ].join("\n");
    expect(workerMessagePresentation(fourLines, fourLines, "concise").excerpt).not.toBeNull();
  });

  it("leads the screenshot-shaped report with under 160 characters, exactly as sent", () => {
    const concise = workerMessagePresentation(ENOSPC_REPORT, ENOSPC_REPORT, "concise");
    const normal = workerMessagePresentation(ENOSPC_REPORT, ENOSPC_REPORT, "normal");
    expect(concise.excerpt).not.toBeNull();
    expect(normal.excerpt).not.toBeNull();
    // Its first sentence is the lead at both levels; the second would pass either budget.
    expect(concise.excerpt!.length).toBeLessThanOrEqual(normal.excerpt!.length);
    expect(concise.excerpt!.length).toBeLessThanOrEqual(160 + 2);
    expect(
      concise.excerpt!.startsWith(
        "Exactspec /Users/fixture/Projects/atlas/.worktrees/format-clarity-20261023/console-ui/e2e/control-desk-0611.spec.ts:74.",
      ),
    ).toBe(true);
    expect(concise.excerpt).not.toContain("ENOSPC");
    expectVerbatim(concise.excerpt!, ENOSPC_REPORT);
    expect(concise.hidden).toBeGreaterThan(concise.characters - 200);
    expect(concise.characters).toBe(Array.from(ENOSPC_REPORT).length);
  });

  it("cuts a first sentence longer than the Concise lead at a space, never inside a word", () => {
    const sentence = `${"Thereleaseworker checked every gate on the branch ".repeat(6)}and stopped.`;
    const text = `${sentence} Then it waited for CI to start on the exact head.`;
    const excerpt = workerMessagePresentation(text, text, "concise").excerpt!;
    expect(excerpt.endsWith(ELLIPSIS)).toBe(true);
    const shown = excerpt.slice(0, -ELLIPSIS.length);
    expect(shown.length).toBeLessThanOrEqual(160);
    expect(text.startsWith(shown)).toBe(true);
    expect(text[shown.length]).toBe(" ");
  });

  it("still shows the sentence that asks for a decision in Concise", () => {
    const text = `${ENOSPC_REPORT}\n\n**Blockers:** free 20 GB on the work volume, or move the archive? Recommended: free space first.`;
    const excerpt = workerMessagePresentation(text, text, "concise").excerpt!;
    expect(excerpt).toContain("**Blockers:** free 20 GB on the work volume, or move the archive?");
    expectVerbatim(excerpt, text);
  });

  it("cuts an opening link Concise cannot cut within 160 characters where Normal would", () => {
    const link =
      "[pr373-runtime-source-contract.md](/Users/fixture/.local/share/atlas/incident-repair-receipts/20261024T230931Z-arena-acceptance/followup489/layout-diagnosis/pr373-runtime-source-contract.md)";
    const text = `${link} is the frozen contract for the public About route and every cache path it names. ${ENOSPC_REPORT}`;
    const normal = workerMessagePresentation(text, text, "normal");
    const concise = workerMessagePresentation(text, text, "concise");
    // The link alone passes the Concise lead, so no space within 160 characters is outside it.
    expect(link.length).toBeGreaterThan(160);
    expect(normal.excerpt).not.toBeNull();
    expect(concise.excerpt).not.toBeNull();
    expect(concise.excerpt!.startsWith(link)).toBe(true);
    expectVerbatim(concise.excerpt!, text);
  });

  it("clips a long message with no opening to cut, and names its whole size", () => {
    const fence = [
      "```text",
      ...Array.from({ length: 40 }, (_, i) => `ok    gate-${i}    unit and headless 0.${i}s`),
      "```",
    ].join("\n");
    const json = JSON.stringify(
      { status: "pass", checks: Array.from({ length: 40 }, (_, i) => `gate-${i}-passed`) },
      null,
      2,
    );
    for (const text of [fence, json])
      for (const detail of ["concise", "normal"] as const) {
        const presentation = workerMessagePresentation(text, text, detail);
        expect(presentation.excerpt).toBeNull();
        expect(presentation.clamp).toBe(true);
        expect(workerMessageSizeLabel(presentation)).toBe(
          `${Array.from(text).length.toLocaleString("en-US")} characters`,
        );
      }
    // A short one, or one whose excerpt would be most of it, shows whole: no clip.
    expect(workerMessagePresentation("Done. The PR is green.").clamp).toBe(false);
    expect(workerMessagePresentation(DENSE).clamp).toBe(false);
    // Small JSON over the line budget only stays whole: 1043's Normal, and Concise too.
    const small = JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }, null, 2);
    expect(small.split("\n").length).toBeGreaterThan(8);
    for (const detail of ["concise", "normal"] as const)
      expect(workerMessagePresentation(small, small, detail)).toMatchObject({
        excerpt: null,
        clamp: false,
      });
  });

  it("keeps a short labeled receipt whole in Concise: blank lines do not count", () => {
    for (const text of [
      "**Outcome:** merged #702.\n\n**Evidence:** CI green on 57c282f4f2.\n\n**Blockers:** none.",
      "Merged #702.\n\nCI green on f047ca4.\n\nNothing deployed.",
      "Done.\n\nPR: https://github.com/a/b/pull/702\n\nNothing deployed; release holds stay.",
    ])
      expect(workerMessagePresentation(text, text, "concise").excerpt).toBeNull();
  });

  it("does not fold Concise to one word when the only early space is near the start", () => {
    const text = `Exactspec /Users/fixture/Projects/atlas/.worktrees/format-clarity-20261023/console-ui/e2e/control-desk-0611.spec.ts:74OnlyWebKit1440/lightretry0failedfullpagescreenshotwithexactError: ENOSPC. ${"More detail follows in this report about the run and its evidence files. ".repeat(6)}`;
    const concise = workerMessagePresentation(text, text, "concise").excerpt!;
    expect(concise.startsWith("Exactspec /Users/fixture/")).toBe(true);
    expect(concise.length).toBeGreaterThan(80);
    expectVerbatim(concise, text);
  });

  it("never cuts inside bold text", () => {
    const text = `Every gate passed in order except the feed signature step, **which stopped on a key mismatch and left the run log and both manifests beside the receipt for the owner to read before anything else**. ${ENOSPC_REPORT}`;
    const excerpt = workerMessagePresentation(text, text, "concise").excerpt!;
    const shown = excerpt.replace(new RegExp(`\\s?${ELLIPSIS}$`), "");
    expect((shown.match(/\*\*/g) ?? []).length % 2).toBe(0);
    expectVerbatim(excerpt, text);
    // Underscores inside a word are not bold, so they do not hold the cut back.
    const snake = `Checked the gate__runner log line by line and found that every step after the restore ran in order and passed, except the last one, which waited on the signing key from the release owner. ${ENOSPC_REPORT}`;
    expect(workerMessagePresentation(snake, snake, "concise").excerpt!.length).toBeGreaterThan(120);
  });

  it("reads an unmatched ** or __ as literal text, so it never holds the cut back", () => {
    const tail = ` ${"Further detail about each gate and the evidence follows here for the release owner. ".repeat(6)}`;
    const leads = (text: string, detail: "concise" | "normal") =>
      workerMessagePresentation(text, text, detail).excerpt;
    // A glob in a first sentence over 280: Normal cuts at 240 characters, as 1043 does.
    const glob = `Ran vp test over apps/web/src/**/*.test.ts with the isolated toolchain on Node 22.20 and every file passed except the clamp case, which still fades a fenced block that already fits inside its box, so the fold shows a footer over nothing at 360 px and at 1280 px in light and dark themes alike today.${tail}`;
    expect(leads(glob, "normal")!.length).toBeGreaterThan(200);
    expectVerbatim(leads(glob, "normal")!, glob);
    for (const text of [
      `Patched build_index(**kwargs) so the indexer forwards every option to the store, then reran the import over the whole fixture vault and compared each manifest against the receipts saved before the change, and all of them matched.${tail}`,
      `Resolved the fixture root from __dirname so the runner works from any working directory, then reran the headless capture at 360 px and 1280 px in light and dark and saved every screenshot beside the receipt for the release owner.${tail}`,
      `Retries now back off at 2 ** attempt seconds with jitter, capped at five minutes, and the queue keeps each request's original order while it waits so a slow provider no longer reorders the sends that came after it in the thread.${tail}`,
      `build_index(**kwargs) now forwards every option to the store, then reran the import over the whole fixture vault and compared each manifest against the receipts saved before the change, and all of them matched.${tail}`,
    ]) {
      const concise = leads(text, "concise");
      expect(concise).not.toBeNull();
      expect(concise!.length).toBeGreaterThan(120);
      expectVerbatim(concise!, text);
    }
  });

  it("never pairs bold across list items, as CommonMark does not", () => {
    const rest =
      "\n\nFurther detail about each gate and the evidence follows here for the release owner. ".repeat(
        5,
      );
    const bullets = `- Ran apps/web/src/**/*.test.ts on Node 22.20 with the isolated toolchain and every suite passed on this head, including the fold and clamp suites that failed on the earlier head\n- The server suites ran over the whole fixture store and every one passed except apps/server/src/**/*.test.ts, which failed on ENOSPC while writing coverage\n- Nothing deployed${rest}`;
    for (const detail of ["normal", "concise"] as const) {
      const excerpt = workerMessagePresentation(bullets, bullets, detail).excerpt!;
      expect(excerpt.length).toBeGreaterThan(120);
      expectVerbatim(excerpt, bullets);
    }
    // Normal shows the whole first bullet, as 1043 does.
    expect(workerMessagePresentation(bullets, bullets, "normal").excerpt).toContain("earlier head");
    const intoList = `Ran the focused suites over apps/web/src/**/*.test.ts on Node 22.20 and every one passed except the clamp case, which still fades a fenced block that already fits inside its box at 360 px and 1280 px, so I left it for the owner\n- apps/server/src/**/*.test.ts passed on the second run after the disk was cleared\n- packages passed${rest}`;
    expect(workerMessagePresentation(intoList, intoList, "normal").excerpt!.length).toBeGreaterThan(
      200,
    );
    // A nested item is a list item too, however deep its indent.
    const nested = `Ran the focused suites on this head.\n- Web\n  - apps/web/src/**/*.test.ts passed on Node 22.20 with the isolated toolchain, including the fold and clamp suites that failed on the earlier head\n    - apps/web/src/**/*.browser.ts was skipped because the headless runner is not installed on this machine\n- Server\n  - apps/server/src/**/*.test.ts failed on ENOSPC while writing coverage${rest}`;
    const lead = workerMessagePresentation(nested, nested, "normal").excerpt!;
    expect(lead).toContain("failed on the earlier head");
    expectVerbatim(lead, nested);
  });

  it("cuts plainly when bold leaves no room, so the Blockers line still shows", () => {
    const filler =
      "The build, the typecheck and the four focused suites all passed on this head without retries. ".repeat(
        4,
      );
    const bold = `**Blocked: the release cannot ship until the signing key is rotated, because the feed signature step failed on a key mismatch and left the run log, both manifests and the receipt beside the owner's checklist, and the Monday release window opens at nine, so the rotation has to land before then.**`;
    expect(bold.length).toBeGreaterThan(240);
    const text = `${bold}\n\n${filler}\n\nBlockers: rotate the signing key or skip the feed step.\n\n${filler}`;
    for (const detail of ["normal", "concise"] as const) {
      const shown = workerMessagePresentation(text, text, detail);
      expect(shown.clamp).toBe(false);
      expect(shown.excerpt!.startsWith("**Blocked: the release cannot ship")).toBe(true);
      expect(shown.excerpt).toContain("Blockers: rotate the signing key or skip the feed step.");
      expectVerbatim(shown.excerpt!, text);
    }
    // A Blockers sentence inside that bold run shows once, after the lead, never the lead again.
    const inside = `**Status of the release: ${"the feed step waits on the key ".repeat(9)}today. Blockers: rotate the signing key.**\n\n${filler}`;
    for (const detail of ["normal", "concise"] as const) {
      const excerpt = workerMessagePresentation(inside, inside, detail).excerpt!;
      expect(excerpt.split("**Status of the release").length).toBe(2);
      expect(excerpt).toContain(`${ELLIPSIS} Blockers: rotate the signing key.**`);
      expectVerbatim(excerpt, inside);
    }
  });

  it("ends a lead of whole sentences outside a bold run that spans them", () => {
    const tail =
      "Further detail about each gate and the evidence follows here for the release owner. ".repeat(
        6,
      );
    const text = `**Blocked on the signing key. The feed signature step stopped on a key mismatch, and the release owner has to rotate the key before anything is published or deployed.**\n\n${tail}`;
    const excerpt = workerMessagePresentation(text, text, "concise").excerpt!;
    expect(excerpt.startsWith("**Blocked on the signing key. The feed")).toBe(true);
    expect((excerpt.match(/\*\*/g) ?? []).length).toBe(2);
    expectVerbatim(excerpt, text);
    // Bold that opens after the first sentence and closes past the budget is left out whole.
    const later = `Checked the release branch. **Blocked on the signing key. The feed signature step stopped on a key mismatch, and the owner has to rotate the key before anything ships.** ${tail}`;
    expect(later.indexOf(".** ")).toBeGreaterThan(160);
    expect(workerMessagePresentation(later, later, "concise").excerpt).toBe(
      `Checked the release branch.\u00A0${ELLIPSIS}`,
    );
  });

  it("folds Verbose as Normal does; the body opens it instead", () => {
    expect(workerMessagePresentation(DENSE, DENSE, "verbose")).toEqual(
      workerMessagePresentation(DENSE, DENSE, "normal"),
    );
    expect(workerMessagePresentation(DENSE)).toEqual(
      workerMessagePresentation(DENSE, DENSE, "normal"),
    );
  });
});

describe("folded relay attention", () => {
  it.each([
    "## Approve deployment?",
    "**Confirm the destination before I continue.**",
    "1. Confirm the destination before I continue.",
    "- Confirm the destination before I continue.",
    "Deployment failed. Please log in to continue.",
  ])("preserves requests regardless of Markdown: %s", (text) =>
    expect(relayAttentionText(text)).toBe(text),
  );
  it("keeps the actual request without its internal receipt lead", () => {
    expect(
      relayAttentionText(
        "CI passed at 8b9b6da6ceccdca502e74454143d114324b36421. Approve deployment?",
      ),
    ).toBe("Approve deployment?");
    expect(relayAttentionText("No blockers. Receipt: /scratch/checks.json")).toBeNull();
    expect(relayAttentionText("**Blockers:** none. CI passed.")).toBeNull();
  });
  it("does not promote code or JSON log questions into requests", () => {
    expect(relayAttentionText('```sh\necho "Approve?"\n```')).toBeNull();
    expect(relayAttentionText('{"log":"Approve?"}')).toBeNull();
  });
});

describe("0957 carry-forward presentation", () => {
  it("keeps operational transport words folded", () => {
    expect(relayAttentionText(MOBILE_CARRY_FORWARD)).toBeNull();
    expect(
      relayAttentionText("No user action required. No need to retry. Do not retry the held run."),
    ).toBeNull();
  });
  it.each([
    "Please reconnect the machine.",
    "You need to log in to continue.",
    "Can you provide the destination?",
    "Permission denied. Grant access before continuing.",
  ])("retains user action: %s", (text) => expect(relayAttentionText(text)).toBe(text));
});
