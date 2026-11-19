// 1398 T-08: the first feature guide end to end with the fake agent, and the pieces it stands on.
//   node --test scripts/studio-projects/first-feature.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeChild from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, it } from "node:test";

import {
  FEATURE_ID,
  FIRST_FEATURE_REQUEST,
  fakeSpecweaveSource,
  runFirstFeature,
  writeFeatureIncrement,
} from "./first-feature.mjs";

const ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const scratch = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "first-feature-unit-"));

describe("the pieces", () => {
  it("sends the guide's own request, AC-22's sentence word for word", () => {
    const logic = NodeFS.readFileSync(
      NodePath.join(ROOT, "apps/web/src/components/studio/firstFeature/firstFeature.logic.ts"),
      "utf8",
    );
    const constant = /export const FIRST_FEATURE_REQUEST =\s*"([^"]+)"/u.exec(logic)?.[1];
    NodeAssert.equal(constant, FIRST_FEATURE_REQUEST);
    NodeAssert.equal(
      FIRST_FEATURE_REQUEST,
      "Build a dark mode switch for this page as a new increment with no Review section: plan it, do every task, then verify, review and close it.",
    );
  });

  it("leaves the feature closed, every task done, with one review from a second family", () => {
    const root = scratch();
    try {
      const folder = writeFeatureIncrement(root, "2026-11-18T12:00:00.000Z");
      NodeAssert.equal(folder, NodePath.join(root, ".specweave", "increments", FEATURE_ID));
      NodeAssert.equal(
        JSON.parse(NodeFS.readFileSync(NodePath.join(folder, "metadata.json"), "utf8")).status,
        "completed",
      );
      const ledger = NodeFS.readFileSync(NodePath.join(folder, "ledger.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      NodeAssert.deepEqual(
        ledger.map((entry) => [entry.t, entry.e]),
        [
          ["T-01", "done"],
          ["T-02", "done"],
        ],
      );
      const review = NodeFS.readFileSync(
        NodePath.join(folder, "reports/reviews/review-muse-wonder-full-1.0-1.md"),
        "utf8",
      );
      NodeAssert.match(
        review,
        /^<!-- specweave review: reviewer=muse-wonder-full-1.0 model=muse-wonder-full-1.0 family=meta author=claude at=2026-11-18T12:00:00.000Z -->\n/u,
      );
      NodeAssert.match(review, /\nVerdict: ship\n/u);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("turns SpecWeave on the way `specweave init` does, offline", () => {
    const root = scratch();
    try {
      const bin = NodePath.join(root, "specweave");
      NodeFS.writeFileSync(bin, fakeSpecweaveSource(), { mode: 0o755 });
      NodeChild.execFileSync(process.execPath, [bin, "init", "--quick", "--adapter", "claude"], {
        cwd: root,
      });
      NodeAssert.ok(NodeFS.statSync(NodePath.join(root, ".specweave", "config.json")).isFile());
      NodeAssert.ok(NodeFS.statSync(NodePath.join(root, ".specweave", "increments")).isDirectory());
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("end to end with the fake agent (AC-25)", () => {
  it(
    "goes from the offer to a sample, through the three steps, to a Done card whose review is listed",
    { timeout: 300_000 },
    async () => {
      const receipt = await runFirstFeature();
      NodeAssert.equal(receipt.ok, true);
      NodeAssert.deepEqual(
        receipt.steps.map((entry) => entry.name),
        [
          "offer",
          "sample made",
          "step 1: SpecWeave on",
          "step 2: card in Done",
          "step 3: review listed",
          "finished, offer gone, sample removed",
        ],
      );
      NodeAssert.equal(NodeFS.existsSync(receipt.home), false, "the private home is removed");
    },
  );
});
