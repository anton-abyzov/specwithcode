// @effect-diagnostics nodeBuiltinImport:off - A test that writes an increment folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { readIncrementReview, readIncrementReviewPolicy } from "./incrementReview.ts";

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
