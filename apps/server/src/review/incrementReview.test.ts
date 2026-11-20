// @effect-diagnostics nodeBuiltinImport:off - A test that writes an increment folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  readIncrementReview,
  readIncrementReviewPolicy,
  readIncrementReviews,
} from "./incrementReview.ts";

let folder: string;
const SPEC =
  "# 1324 Demo\n\n## Review\n- Reviewer: openai (gpt-6.1-sol)\n- Depth: deep\n- Required: yes\n\n## Tasks\n";
const LEDGER =
  '{"t":"T-01","e":"done","by":"claude@m4","at":"2026-11-13T20:00:00Z","evidence":"abc"}\n';

function report(rel: string, text: string, mtime: number) {
  const path = NodePath.join(folder, "reports", rel);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, text);
  NodeFS.utimesSync(path, mtime / 1000, mtime / 1000);
  return path;
}

beforeEach(() => {
  folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "inc-review-"));
  NodeFS.writeFileSync(NodePath.join(folder, "spec.md"), SPEC);
});
afterEach(() => NodeFS.rmSync(folder, { recursive: true, force: true }));

describe("readIncrementReview", () => {
  it("says the required OpenAI review is missing when only a Claude review is on file", async () => {
    report(
      "review.md",
      "# Review: 1324\nVerdict: ship · risk: low\n",
      Date.parse("2026-11-13T20:30:00Z"),
    );
    const review = await readIncrementReview({ incrementPath: folder, spec: SPEC, ledger: LEDGER });
    expect(review).toMatchObject({
      policy: { family: "openai", model: "gpt-6.1-sol", depth: "deep", required: true },
      latest: { model: null, family: "unknown", head: null, verdict: "ship" },
      authorFamily: "claude",
      policySatisfied: false,
    });
  });

  it("shows the newest record and counts a ship review by the policy's model", async () => {
    report(
      "reviews/review-gpt-6.1-sol-1.md",
      "<!-- specweave review: reviewer=gpt-6.1-sol model=gpt-6.1-sol family=openai author=claude depth=deep repo=repositories/acme/app head=3f9a2c1d00 at=2026-11-13T21:00:00Z -->\n# Review: 1324\nVerdict: ship\n",
      Date.parse("2026-11-13T21:00:00Z"),
    );
    const sonnet = report(
      "reviews/review-claude-sonnet-5-5-1.md",
      "<!-- specweave review: reviewer=claude-sonnet-5-5 model=claude-sonnet-5-5 family=claude author=claude head=4444444 at=2026-11-13T21:10:00Z -->\n# Review: 1324\nVerdict: fix first\n",
      Date.parse("2026-11-13T21:10:00Z"),
    );
    const review = await readIncrementReview({ incrementPath: folder, spec: SPEC, ledger: LEDGER });
    expect(review?.latest).toMatchObject({
      model: "claude-sonnet-5-5",
      family: "claude",
      head: "4444444",
      verdict: "fix first",
      reportPath: sonnet,
    });
    expect(review?.policySatisfied).toBe(true);
  });

  it("orders records by their own time, so an older ship never hides a newer fix first", async () => {
    const checkout = Date.parse("2026-11-13T12:00:00Z");
    const header = (at: string) =>
      `<!-- specweave review: reviewer=gpt-6.1-sol model=gpt-6.1-sol family=openai author=claude depth=deep head=3f9a2c1d00 at=${at} -->\n# Review: 1324\n`;
    report(
      "reviews/review-gpt-6.1-sol-1.md",
      `${header("2026-11-13T09:00:00Z")}Verdict: ship\n`,
      checkout,
    );
    const second = report(
      "reviews/review-gpt-6.1-sol-2.md",
      `${header("2026-11-13T10:00:00Z")}Verdict: fix first\n`,
      checkout,
    );
    const review = await readIncrementReview({ incrementPath: folder, spec: SPEC, ledger: LEDGER });
    expect(review?.latest).toMatchObject({ verdict: "fix first", reportPath: second });
    expect(review?.policySatisfied).toBe(false);
  });

  it("applies the project's review config under the spec", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "inc-root-"));
    try {
      const increment = NodePath.join(root, ".specweave", "increments", "1324-demo");
      NodeFS.mkdirSync(increment, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(root, ".specweave", "config.json"),
        JSON.stringify({ review: { policy: { reviewer: "openai", required: true } } }),
      );
      NodeFS.writeFileSync(
        NodePath.join(increment, "spec.md"),
        "# 1324\n\n## Review\n- Depth: deep\n",
      );
      expect(await readIncrementReviewPolicy(NodePath.join(increment, "spec.md"))).toEqual({
        family: "openai",
        depth: "deep",
        required: true,
      });
      const review = await readIncrementReview({
        incrementPath: increment,
        spec: "# 1324\n\n## Review\n- Depth: deep\n",
        ledger: LEDGER,
      });
      expect(review?.policy).toEqual({
        family: "openai",
        model: null,
        depth: "deep",
        required: true,
      });
      expect(review?.policySatisfied).toBe(false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("takes the repositories from a legacy tasks.md when there is one (Sol round 3)", async () => {
    report(
      "reviews/review-gpt-6.1-sol-1.md",
      "<!-- specweave review: reviewer=gpt-6.1-sol model=gpt-6.1-sol family=openai author=claude depth=deep repo=repositories/acme/api head=3f9a2c1d00 at=2026-11-13T21:00:00Z -->\n# Review: 1324\nVerdict: ship\n",
      Date.parse("2026-11-13T21:00:00Z"),
    );
    const tasks =
      "### T-01 API\n- AC: AC-01 | Files: repositories/acme/api/a.ts | Test: t\n\n### T-02 App\n- AC: AC-01 | Files: repositories/acme/app/b.ts | Test: t\n";
    const withLegacy = await readIncrementReview({
      incrementPath: folder,
      spec: SPEC,
      ledger: LEDGER,
      tasks,
    });
    expect(withLegacy?.policySatisfied).toBe(false);
    const apiOnly = await readIncrementReview({
      incrementPath: folder,
      spec: SPEC,
      ledger: LEDGER,
      tasks: "### T-01 API\n- AC: AC-01 | Files: repositories/acme/api/a.ts | Test: t\n",
    });
    expect(apiOnly?.policySatisfied).toBe(true);
  });

  it("is null with no policy and no review, and reads the policy alone", async () => {
    expect(
      await readIncrementReview({ incrementPath: folder, spec: "# T\n", ledger: null }),
    ).toBeNull();
    expect(await readIncrementReviewPolicy(NodePath.join(folder, "spec.md"))).toEqual({
      family: "openai",
      model: "gpt-6.1-sol",
      depth: "deep",
      required: true,
    });
    expect(await readIncrementReviewPolicy(NodePath.join(folder, "missing.md"))).toBeNull();
  });
});

describe("readIncrementReviews", () => {
  const header = (fields: string) => `<!-- specweave review: ${fields} -->\n# Review: 1324\n`;

  it("lists every recorded review newest first, with canonical families", async () => {
    report(
      "reviews/review-gpt-6.1-sol-1.md",
      `${header("reviewer=gpt-6.1-sol model=gpt-6.1-sol family=OpenAI author=anthropic at=2026-11-13T21:00:00Z")}Verdict: fix first\n`,
      Date.parse("2026-11-13T21:00:00Z"),
    );
    report(
      "reviews/review-muse-wonder-full-1.0-1.md",
      `${header("reviewer=muse-wonder-full-1.0 model=muse-wonder-full-1.0 family=meta at=2026-11-13T22:00:00Z")}Verdict: ship\n`,
      Date.parse("2026-11-13T22:00:00Z"),
    );
    report("review.md", "# Review: 1324\nVerdict: ship\n", Date.parse("2026-11-13T20:00:00Z"));
    // Not a review record: ignored.
    report("notes.md", "Verdict: ship\n", Date.parse("2026-11-13T23:00:00Z"));

    expect(await readIncrementReviews(folder, "claude")).toEqual([
      {
        model: "muse-wonder-full-1.0",
        family: "meta",
        author: "claude",
        verdict: "ship",
        at: "2026-11-13T22:00:00Z",
      },
      {
        model: "gpt-6.1-sol",
        family: "openai",
        author: "claude",
        verdict: "fix first",
        at: "2026-11-13T21:00:00Z",
      },
      {
        model: null,
        family: "unknown",
        author: "claude",
        verdict: "ship",
        at: "2026-11-13T20:00:00.000Z",
      },
    ]);
  });

  it("is empty without a reports folder or a review in it", async () => {
    expect(await readIncrementReviews(folder, "claude")).toEqual([]);
    report("notes.md", "Verdict: ship\n", Date.parse("2026-11-13T23:00:00Z"));
    expect(await readIncrementReviews(folder, "claude")).toEqual([]);
  });

  it("reads again when a review is added or changed, and lists at most ten", async () => {
    const at = (minute: number) => `2026-11-13T21:${String(minute).padStart(2, "0")}:00Z`;
    const write = (index: number, verdict: string) =>
      report(
        `reviews/review-gpt-6.1-sol-${index}.md`,
        `${header(`reviewer=gpt-6.1-sol family=openai author=claude at=${at(index)}`)}Verdict: ${verdict}\n`,
        Date.parse(at(index)),
      );
    write(1, "fix first");
    expect((await readIncrementReviews(folder, null)).map((review) => review.verdict)).toEqual([
      "fix first",
    ]);
    write(2, "ship");
    expect((await readIncrementReviews(folder, null)).map((review) => review.verdict)).toEqual([
      "ship",
      "fix first",
    ]);
    // Same file, new content and size.
    write(1, "ship");
    expect((await readIncrementReviews(folder, null)).map((review) => review.verdict)).toEqual([
      "ship",
      "ship",
    ]);
    for (let index = 3; index <= 12; index++) write(index, "ship");
    const reviews = await readIncrementReviews(folder, null);
    expect(reviews).toHaveLength(10);
    expect(reviews[0]?.at).toBe(at(12));
  });

  it("feeds the plan card's latest review from the same records", async () => {
    report(
      "reviews/review-gpt-6.1-sol-1.md",
      `${header("reviewer=gpt-6.1-sol model=gpt-6.1-sol family=openai author=claude at=2026-11-13T21:00:00Z")}Verdict: ship\n`,
      Date.parse("2026-11-13T21:00:00Z"),
    );
    const [first] = await readIncrementReviews(folder, "claude");
    const review = await readIncrementReview({ incrementPath: folder, spec: SPEC, ledger: LEDGER });
    expect(review?.latest).toMatchObject({
      model: first?.model,
      family: first?.family,
      verdict: first?.verdict,
      at: first?.at,
    });
  });
});
