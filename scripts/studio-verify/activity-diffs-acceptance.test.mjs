import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTURE_PLAN } from "./activity-diffs-capture.mjs";
import { checkAcceptance, FEATURE_MERGE } from "./activity-diffs-acceptance.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "activity-acceptance-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const beforeDir = join(root, "before");
  const afterDir = join(root, "after");
  const scratchRepo = join(root, "repo");
  for (const directory of [beforeDir, afterDir, join(scratchRepo, "logs")])
    mkdirSync(directory, { recursive: true });
  const screenshots = CAPTURE_PLAN.map((entry) => {
    const [width, height] = entry.viewport.split("x").map(Number);
    // Only the PNG envelope is read by the manifest validator; rendering is separate evidence.
    const header = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    for (const directory of [beforeDir, afterDir])
      writeFileSync(join(directory, entry.file), header);
    return { ...entry, sha256: hash(header), savedWidth: width, savedHeight: height };
  });
  const common = {
    app: "/Applications/SpecWithCode.app",
    headless: true,
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
    screenshots,
  };
  const before = { ...common, phase: "before", bundleVersion: "1.0.74" };
  const output = "x".repeat(262144) + "😀tail";
  writeFileSync(join(scratchRepo, "logs/stream-trace.log"), output);
  const digest = hash(output);
  const after = {
    ...common,
    phase: "after",
    bundleVersion: "1.0.105",
    releaseTag: "v1.0.105",
    sourceCommit: "a".repeat(40),
    mergeCommit: FEATURE_MERGE,
    scratchRepo,
    technicalStatus: "pass for recorded checks; user acceptance pending",
    layoutChecks: ["light", "dark"].flatMap((theme) =>
      [1280, 720, 390].flatMap((width) =>
        ["edit", "readonly"].map((key) => ({
          theme,
          width,
          key,
          rowCount: 9,
          documentOverflow: 0,
          outsideViewport: [],
          hasChangedCard: key === "edit",
          failureChip: key === "edit",
        })),
      ),
    ),
    paging: {
      totalChars: output.length,
      sha256: digest,
      hasTransportMarker: false,
      pages: [
        {
          offset: 0,
          end: 262144,
          nextOffset: 262144,
          chars: 262144,
          revision: "same",
          totalLength: output.length,
        },
        {
          offset: 262144,
          end: output.length,
          nextOffset: null,
          chars: output.length - 262144,
          revision: "same",
          totalLength: output.length,
        },
      ],
    },
    copyFull: { chars: output.length, sha256: digest },
  };
  const acceptance = {
    status: "accepted",
    source: "user",
    decision: "Accept installed behavior",
    recordedAtUTC: "recorded",
  };
  const save = () => {
    writeFileSync(join(beforeDir, "receipt.json"), JSON.stringify(before));
    writeFileSync(join(afterDir, "receipt.json"), JSON.stringify(after));
    writeFileSync(join(afterDir, "acceptance.json"), JSON.stringify(acceptance));
  };
  save();
  const git = (args) =>
    args[0] === "rev-parse"
      ? { status: 0, stdout: `${after.sourceCommit}\n` }
      : { status: 0, stdout: "" };
  return {
    beforeDir,
    afterDir,
    before,
    after,
    acceptance,
    save,
    check: (override = git) => checkAcceptance({ beforeDir, afterDir, git: override }),
  };
}

test("accepts the full retained matrix, stable paged bytes and an explicit user decision", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.check(), {
    ok: true,
    beforeImages: 38,
    afterImages: 38,
    layoutCases: 12,
    outputChars: f.after.paging.totalChars,
    sha256: f.after.paging.sha256,
  });
});

test("does not substitute a later before bundle or a source-built after set", (t) => {
  const f = fixture(t);
  f.before.bundleVersion = "1.0.80";
  f.save();
  assert.throws(() => f.check(), /Before bundle must be 1.0.74/);
  f.before.bundleVersion = "1.0.74";
  f.after.app = "/repo/apps/server/dist/bin.mjs";
  f.save();
  assert.throws(() => f.check(), /installed app bundle/);
});

test("rejects an incomplete or mislabeled screenshot matrix", (t) => {
  const f = fixture(t);
  f.after.screenshots.pop();
  f.save();
  assert.throws(() => f.check(), /Capture plan mismatch/);
});

test("rejects changed PNG bytes, even when the capture-plan metadata still matches", (t) => {
  const f = fixture(t);
  const file = join(f.afterDir, f.after.screenshots[0].file);
  const bytes = readFileSync(file);
  bytes[12] = 1;
  writeFileSync(file, bytes);
  assert.throws(() => f.check(), /Screenshot hash mismatch/);
});

test("refuses a screenshot symlink outside the retained evidence directory", (t) => {
  const f = fixture(t);
  const name = f.after.screenshots[0].file;
  rmSync(join(f.afterDir, name));
  symlinkSync(join(f.beforeDir, name), join(f.afterDir, name));
  assert.throws(() => f.check(), /Screenshot escapes/);
});

test("requires the exact tag source and the feature merge as an ancestor", (t) => {
  const f = fixture(t);
  assert.throws(
    () => f.check(() => ({ status: 0, stdout: "wrong" })),
    /Release tag\/source mismatch/,
  );
  assert.throws(
    () =>
      f.check((args) =>
        args[0] === "rev-parse"
          ? { status: 0, stdout: f.after.sourceCommit }
          : { status: 1, stdout: "" },
      ),
    /does not contain/,
  );
});

test("keeps missing layouts, overflow and read-only card attribution from passing", (t) => {
  const f = fixture(t);
  const check = f.after.layoutChecks[0];
  check.documentOverflow = 2;
  f.save();
  assert.throws(() => f.check(), /overflow or missing/);
  check.documentOverflow = 0;
  f.after.layoutChecks.pop();
  f.save();
  assert.throws(() => f.check(), /Missing layout evidence/);
});

test("rejects unstable revisions and cut or incorrectly copied output", (t) => {
  const f = fixture(t);
  f.after.paging.pages[1].revision = "changed";
  f.save();
  assert.throws(() => f.check(), /boundaries or revisions/);
  f.after.paging.pages[1].revision = "same";
  f.after.copyFull.sha256 = "wrong";
  f.save();
  assert.throws(() => f.check(), /hash differs/);
});

test("requires a nonempty revision on every output page", (t) => {
  const f = fixture(t);
  for (const revision of [undefined, null, "", "   "]) {
    for (const page of f.after.paging.pages) page.revision = revision;
    f.save();
    assert.throws(() => f.check(), /revision is missing or invalid/);
  }
});

test("headless proof and actual user acceptance remain required", (t) => {
  const f = fixture(t);
  f.after.headless = false;
  f.save();
  assert.throws(() => f.check(), /explicitly headless/);
  f.after.headless = true;
  f.acceptance.status = "pending";
  f.save();
  assert.throws(() => f.check(), /User installed acceptance is missing/);
});
