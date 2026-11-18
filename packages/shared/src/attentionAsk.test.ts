import { describe, expect, it } from "vite-plus/test";
import { blockerAsk, capAsk, pendingQuestionPrompt } from "./attentionAsk.ts";

// Shapes of the Blockers parts and cards that sat under Needs you on November 18, 2026.
describe("blockerAsk", () => {
  it("keeps the question and drops the option list", () => {
    expect(
      blockerAsk(
        "Do you accept this plan? The options are:\n\n1. **Accept as proposed (recommended).** Both phases go ahead.\n2. **Review first.**",
      ),
    ).toBe("Do you accept this plan?");
  });

  it("drops a short lead-in and markdown", () => {
    expect(
      blockerAsk(
        "Still yours from the last report: which banner layout (A, B or C; I recommend A) and a yes for the paid font. A test phone is needed later.",
      ),
    ).toBe("Which banner layout (A, B or C; I recommend A) and a yes for the paid font.");
    expect(blockerAsk("Merge [PR 597](https://github.com/x/y/pull/597) or wait for `main`?")).toBe(
      "Merge PR 597 or wait for main?",
    );
  });

  it("keeps a version number whole and caps a long ask at a word", () => {
    expect(blockerAsk("Ship 1.0.35 today, or wait for the SQLite fix?")).toBe(
      "Ship 1.0.35 today, or wait for the SQLite fix?",
    );
    const long = capAsk(`Decide ${"which machine ".repeat(20)}`, 40);
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith("machine…")).toBe(true);
    expect(blockerAsk("   ")).toBeNull();
  });

  it("reads the first item of a Blockers part that is only a list", () => {
    expect(blockerAsk("- **Pick a banner layout.** A is ready.\n- Approve the paid font.")).toBe(
      "Pick a banner layout.",
    );
  });
});

describe("pendingQuestionPrompt", () => {
  it("names the header and its options", () => {
    expect(
      pendingQuestionPrompt([
        {
          header: "Release",
          question: "The checks passed. Ship now, or wait for the review?",
          options: [{ label: "Ship now" }, { label: "Wait for review" }],
        },
      ]),
    ).toBe("Release: Ship now or Wait for review");
  });

  it("counts several questions by header", () => {
    expect(
      pendingQuestionPrompt([
        { header: "Theme", question: "Which theme?", options: [{ label: "Light" }] },
        { header: "Font size", question: "Keep it?", options: [{ label: "Keep" }] },
      ]),
    ).toBe("2 questions: Theme, Font size");
  });

  it("uses the asking sentence when the header is the default", () => {
    expect(
      pendingQuestionPrompt([
        {
          header: "Question",
          question: "The build passed. Release now or wait for review?",
          options: [{ label: "Release" }, { label: "Wait" }, { label: "Cancel" }],
        },
      ]),
    ).toBe("Release now or wait for review? Release, Wait or Cancel");
    expect(pendingQuestionPrompt([])).toBeNull();
  });
});
