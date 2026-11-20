#!/usr/bin/env node
// Drafts reviewed-lock-changes.json entries for a lock change that is already
// committed: every line the lock gained or lost against the reviewed record.
//
//   node scripts/studio-toolchain/propose-lock-changes.mjs --pr 123 \
//     [--commit <sha>] --reason "Why that commit changed the lock." ... > draft.json
//
// Each entry is attributed to the first --commit (default: HEAD) whose diff
// wrote or dropped its line, and takes the --reason given at the same position
// (the last one when there are fewer). Read the draft, append its entries to
// the record, then update LOCK_REVIEW_SHA256 in preservation-audit.mjs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCK_UPSTREAM,
  proposeLockChanges,
  reviewedLockTree,
  validateReviewedLockChanges,
} from "./preservation-audit.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const args = process.argv.slice(2);
const values = (flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));
const pr = Number(values("--pr")[0]);
const reasons = values("--reason");
const commits = values("--commit").map((commit) => git(["rev-parse", commit]).trim());
if (commits.length === 0) commits.push(git(["rev-parse", "HEAD"]).trim());
if (!Number.isInteger(pr) || pr <= 0 || reasons.length === 0) {
  console.error(
    "usage: propose-lock-changes.mjs --pr <number> [--commit <sha>] --reason <20+ chars> ...",
  );
  process.exit(2);
}

const record = JSON.parse(
  readFileSync(join(root, "scripts/studio-toolchain/reviewed-lock-changes.json"), "utf8"),
);
const expected = reviewedLockTree(git(["show", `${LOCK_UPSTREAM}:pnpm-lock.yaml`]), record.changes);
// The tree reader is private to the audit; a lock with no reviewed changes is read through it.
const actual = reviewedLockTree(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), [], {
  baseline: false,
});
const diffs = new Map(
  commits.map((commit) => [
    commit,
    git(["show", "--format=", "-U0", commit, "--", "pnpm-lock.yaml"]),
  ]),
);
const drafts = proposeLockChanges(expected, actual).map((change) => {
  const indent = "  ".repeat(change.parent.length);
  const [sign, line] =
    change.op === "remove" ? ["-", change.lines[0]] : ["+", change.after ?? change.lines[0]];
  const at = commits.findIndex((id) => diffs.get(id).includes(`\n${sign}${indent}${line}\n`));
  if (at < 0) throw new Error(`No --commit wrote: ${sign}${indent}${line}`);
  return { ...change, commit: commits[at], pr, reason: reasons[Math.min(at, reasons.length - 1)] };
});
validateReviewedLockChanges({ ...record, changes: [...record.changes, ...drafts] });
process.stdout.write(`${JSON.stringify(drafts, null, 2)}\n`);
