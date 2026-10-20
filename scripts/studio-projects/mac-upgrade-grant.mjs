#!/usr/bin/env node
// Proves a desktop upgrade kept the user's macOS privacy grants. macOS keys the
// Accessibility and Screen Recording entries to the app's designated
// requirement, so a release signed by the same Developer ID team keeps them and
// anything else (ad hoc, Apple Development, another team or bundle id) loses
// them and makes the user approve the app again.
//
//   before <SpecWithCode.app> <state.json>  record the installed app's requirement and grants
//   after  <SpecWithCode.app> <state.json>  refuse when the new app fails that requirement or
//                                           a grant that was on is now off
//
// The probe launches the app's own executable in Node mode (no window, no
// single-instance lock) through Launch Services, so macOS attributes it to the
// app, and asks only the preflight APIs: no prompt, no capture, no input.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { RELEASE_TEAM_ID } from "./mac-signature.mjs";

export const GRANTS = ["accessibility", "screenRecording"];

const PROBE_SCRIPT = `const { execFileSync } = require("child_process");
const out = process.argv[process.argv.length - 1];
const jxa = 'ObjC.import("CoreGraphics");ObjC.import("ApplicationServices");' +
  'ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);' +
  'ObjC.bindFunction("AXIsProcessTrusted", ["bool", []]);' +
  'JSON.stringify({ screenRecording: $.CGPreflightScreenCaptureAccess(), accessibility: $.AXIsProcessTrusted() });';
let result;
try {
  result = JSON.parse(execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", jxa], { timeout: 15000 }).toString());
} catch (error) {
  result = { error: String((error && error.stderr) || error) };
}
result.execPath = process.execPath;
require("fs").writeFileSync(out, JSON.stringify(result));
`;

/** The requirement text from `codesign -d -r-`, without its `designated =>` prefix. */
export function parseRequirement(output) {
  return output.match(/^designated => (.+)$/m)?.[1]?.trim() ?? null;
}

/** True for a requirement that names a Developer ID team rather than one build's hash. */
export function isTeamRequirement(requirement, teamId = RELEASE_TEAM_ID) {
  return (
    typeof requirement === "string" &&
    requirement.includes("anchor apple generic") &&
    requirement.includes(`certificate leaf[subject.OU] = ${teamId}`)
  );
}

/** Problems that mean this upgrade made macOS forget the user's grants. */
export function upgradeGrantProblems(before, after) {
  const problems = [];
  if (before.requirement && isTeamRequirement(before.requirement) && !after.satisfiesPrevious)
    problems.push(
      `${after.version} does not satisfy ${before.version}'s designated requirement, so macOS treats it as a new app and drops its grants: ${after.requirementError ?? "requirement not met"}`,
    );
  if (after.requirement !== before.requirement && isTeamRequirement(before.requirement))
    problems.push(
      `The designated requirement changed from "${before.requirement}" to "${after.requirement}".`,
    );
  for (const grant of GRANTS) {
    if (before.permissions?.[grant] === true && after.permissions?.[grant] !== true)
      problems.push(
        `${grant} was allowed for ${before.version} and is ${after.permissions?.[grant] ?? "unknown"} for ${after.version}${after.permissions?.error ? ` (${after.permissions.error})` : ""}.`,
      );
  }
  return problems;
}

function run(command, args, timeout = 30_000) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", timeout });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function version(app) {
  return run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    NodePath.join(app, "Contents/Info.plist"),
  ]).output.trim();
}

function probePermissions(app) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "specwithcode-grant-"));
  const script = NodePath.join(dir, "probe.js");
  const out = NodePath.join(dir, "result.json");
  NodeFS.writeFileSync(script, PROBE_SCRIPT);
  try {
    const opened = run(
      "/usr/bin/open",
      ["-g", "-n", "-W", "-a", app, "--env", "ELECTRON_RUN_AS_NODE=1", "--args", script, out],
      60_000,
    );
    if (!NodeFS.existsSync(out))
      return {
        error: `the probe wrote nothing (open exited ${opened.status}): ${opened.output.trim()}`,
      };
    const result = JSON.parse(NodeFS.readFileSync(out, "utf8"));
    const expected = NodePath.join(app, "Contents/MacOS");
    if (typeof result.execPath !== "string" || !result.execPath.startsWith(`${expected}/`))
      return { error: `the probe ran as ${result.execPath}, not from ${expected}` };
    return result;
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

function inspect(app) {
  return {
    version: version(app),
    requirement: parseRequirement(run("/usr/bin/codesign", ["-d", "-r-", app]).output),
    permissions: probePermissions(app),
  };
}

function main([command, app, stateFile]) {
  if (!["before", "after"].includes(command) || !app || !stateFile) {
    process.stderr.write(
      "Usage: mac-upgrade-grant.mjs before|after <SpecWithCode.app> <state.json>\n",
    );
    return 2;
  }
  const resolved = NodePath.resolve(app);
  if (command === "before") {
    const state = inspect(resolved);
    NodeFS.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    process.stdout.write(
      `grants before: ${state.version} ${GRANTS.map((g) => `${g}=${state.permissions[g] ?? state.permissions.error}`).join(" ")}\n`,
    );
    return 0;
  }
  const before = JSON.parse(NodeFS.readFileSync(stateFile, "utf8"));
  const after = inspect(resolved);
  if (before.requirement) {
    const check = run("/usr/bin/codesign", ["--verify", `-R=${before.requirement}`, resolved]);
    after.satisfiesPrevious = check.status === 0;
    if (check.status !== 0) after.requirementError = check.output.trim();
  }
  const problems = upgradeGrantProblems(before, after);
  const summary = GRANTS.map(
    (g) => `${g} ${before.permissions?.[g] ?? "?"}->${after.permissions?.[g] ?? "?"}`,
  ).join(", ");
  if (problems.length === 0) {
    process.stdout.write(`grants kept: ${before.version} -> ${after.version}: ${summary}\n`);
    return 0;
  }
  process.stderr.write(
    `refused upgrade ${before.version} -> ${after.version} (${summary}):\n${problems.map((p) => `  - ${p}\n`).join("")}`,
  );
  return 1;
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
