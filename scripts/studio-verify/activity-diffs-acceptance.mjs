#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BEFORE_VERSION, checkCapturePlan, gitRunner } from "./activity-diffs-capture.mjs";

export const FEATURE_MERGE = "2ca93c372d7fe227fd78526275d004be545b846e";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function checkImages(directory, receipt, requireHashes) {
  const plan = checkCapturePlan(receipt.screenshots ?? []);
  requireEvidence(plan.ok, `Capture plan mismatch: ${JSON.stringify(plan)}`);
  const root = realpathSync(directory);
  for (const shot of receipt.screenshots) {
    const path = realpathSync(resolve(root, shot.file));
    const within = relative(root, path);
    requireEvidence(
      within !== ".." && !within.startsWith(`..${sep}`) && !isAbsolute(within),
      `Screenshot escapes its evidence directory: ${shot.file}`,
    );
    const bytes = readFileSync(path);
    requireEvidence(
      bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE),
      `Invalid PNG: ${shot.file}`,
    );
    const [width, height] = shot.viewport.split("x").map(Number);
    const savedWidth = bytes.readUInt32BE(16);
    const savedHeight = bytes.readUInt32BE(20);
    requireEvidence(
      savedWidth > 0 &&
        savedHeight > 0 &&
        Math.abs(savedWidth / savedHeight - width / height) < 0.002,
      `PNG viewport aspect mismatch: ${shot.file}`,
    );
    if (requireHashes) {
      requireEvidence(shot.sha256 === sha256(bytes), `Screenshot hash mismatch: ${shot.file}`);
      requireEvidence(
        shot.savedWidth === savedWidth && shot.savedHeight === savedHeight,
        `Screenshot dimensions disagree with receipt: ${shot.file}`,
      );
    }
  }
  return receipt.screenshots.length;
}

/** Validates retained evidence; never starts a server, browser or provider. */
export function checkAcceptance({ beforeDir, afterDir, git = gitRunner(ROOT) }) {
  const before = json(resolve(beforeDir, "receipt.json"));
  const after = json(resolve(afterDir, "receipt.json"));
  for (const [phase, receipt] of [
    ["before", before],
    ["after", after],
  ]) {
    requireEvidence(receipt.phase === phase, `Expected ${phase} receipt`);
    requireEvidence(
      typeof receipt.app === "string" && isAbsolute(receipt.app) && receipt.app.endsWith(".app"),
      `${phase} evidence must identify an installed app bundle`,
    );
    requireEvidence(
      receipt.headless === true &&
        receipt.PWDEBUG === "0" &&
        receipt.PLAYWRIGHT_HTML_OPEN === "never",
      `${phase} evidence must be explicitly headless`,
    );
  }
  requireEvidence(
    before.bundleVersion === BEFORE_VERSION,
    `Before bundle must be ${BEFORE_VERSION}`,
  );
  requireEvidence(
    after.mergeCommit === FEATURE_MERGE,
    "After receipt names the wrong feature merge",
  );
  requireEvidence(
    after.releaseTag === `v${after.bundleVersion}`,
    "After release tag/version mismatch",
  );
  const tag = git(["rev-parse", "--verify", `${after.releaseTag}^{commit}`]);
  requireEvidence(
    tag.status === 0 && tag.stdout.trim() === after.sourceCommit,
    "Release tag/source mismatch",
  );
  requireEvidence(
    git(["merge-base", "--is-ancestor", FEATURE_MERGE, after.sourceCommit]).status === 0,
    "Installed release does not contain the feature merge",
  );
  const beforeImages = checkImages(beforeDir, before, false);
  const afterImages = checkImages(afterDir, after, true);
  requireEvidence(
    after.technicalStatus === "pass for recorded checks; user acceptance pending",
    "After technical checks did not pass",
  );
  const layouts = after.layoutChecks ?? [];
  const expected = new Set(
    ["light", "dark"].flatMap((theme) =>
      [1280, 720, 390].flatMap((width) =>
        ["edit", "readonly"].map((key) => `${theme}:${width}:${key}`),
      ),
    ),
  );
  for (const check of layouts) {
    requireEvidence(
      expected.delete(`${check.theme}:${check.width}:${check.key}`),
      "Unexpected or duplicate layout case",
    );
    requireEvidence(
      check.documentOverflow === 0 && check.outsideViewport?.length === 0 && check.rowCount > 0,
      "Layout evidence has overflow or missing tool rows",
    );
    requireEvidence(
      check.hasChangedCard === (check.key === "edit"),
      "Changed-files card attribution mismatch",
    );
    requireEvidence(check.failureChip === (check.key === "edit"), "Failure chip evidence mismatch");
  }
  requireEvidence(expected.size === 0, "Missing layout evidence");
  const paging = after.paging;
  requireEvidence(
    paging?.pages?.length > 1 && paging.totalChars > 262144,
    "Installed output paging is not proven",
  );
  let offset = 0;
  for (const [index, page] of paging.pages.entries()) {
    requireEvidence(
      typeof page.revision === "string" && page.revision.trim().length > 0,
      "Output page revision is missing or invalid",
    );
    requireEvidence(
      page.offset === offset &&
        page.end > offset &&
        page.chars === page.end - offset &&
        page.totalLength === paging.totalChars &&
        page.revision === paging.pages[0].revision &&
        page.nextOffset === (index === paging.pages.length - 1 ? null : page.end),
      "Output page boundaries or revisions disagree",
    );
    offset = page.end;
  }
  requireEvidence(
    offset === paging.totalChars && paging.hasTransportMarker === false,
    "Stored output was cut",
  );
  const sourceHash = sha256(readFileSync(resolve(after.scratchRepo, "logs/stream-trace.log")));
  requireEvidence(
    paging.sha256 === sourceHash &&
      after.copyFull?.sha256 === sourceHash &&
      after.copyFull.chars === paging.totalChars,
    "Full output/copy hash differs from the source log",
  );
  const acceptance = json(resolve(afterDir, "acceptance.json"));
  requireEvidence(
    acceptance.status === "accepted" &&
      acceptance.source === "user" &&
      acceptance.decision === "Accept installed behavior" &&
      acceptance.recordedAtUTC,
    "User installed acceptance is missing",
  );
  return {
    ok: true,
    beforeImages,
    afterImages,
    layoutCases: layouts.length,
    outputChars: offset,
    sha256: sourceHash,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const reportsDir = args.shift();
    requireEvidence(
      reportsDir && (args.length === 0 || (args.length === 2 && args[0] === "--after-dir")),
      "usage: activity-diffs-acceptance.mjs <reports-dir> [--after-dir <corrected-dir>]",
    );
    console.log(
      JSON.stringify(
        checkAcceptance({
          beforeDir: resolve(reportsDir, "installed-before"),
          afterDir: args.length ? resolve(args[1]) : resolve(reportsDir, "installed-after"),
        }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(String(error.message ?? error));
    process.exitCode = 1;
  }
}
