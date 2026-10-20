import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { expectedRequirement } from "./mac-signature.mjs";
import { isTeamRequirement, parseRequirement, upgradeGrantProblems } from "./mac-upgrade-grant.mjs";

const assert = NodeAssert;
const { test } = NodeTest;

const requirement = expectedRequirement();
const granted = { accessibility: true, screenRecording: true };
const before = { version: "1.0.59", requirement, permissions: granted };

test("parses the requirement codesign prints and recognises a team requirement", () => {
  assert.equal(parseRequirement(`Executable=/x\ndesignated => ${requirement}\n`), requirement);
  assert.ok(isTeamRequirement(requirement));
  assert.ok(!isTeamRequirement('cdhash H"0123"'));
});

test("a release signed by the same team keeps both grants", () => {
  const after = { version: "1.0.60", requirement, permissions: granted, satisfiesPrevious: true };
  assert.deepEqual(upgradeGrantProblems(before, after), []);
});

test("a release that fails the previous requirement is refused", () => {
  const after = {
    version: "1.0.61",
    requirement: 'cdhash H"0123"',
    permissions: { accessibility: false, screenRecording: false },
    satisfiesPrevious: false,
    requirementError: "test-requirement: code failed to satisfy specified code requirement(s)",
  };
  const problems = upgradeGrantProblems(before, after);
  assert.equal(problems.length, 4);
  assert.match(problems[0], /does not satisfy 1\.0\.59's designated requirement/);
  assert.match(problems[2], /accessibility was allowed for 1\.0\.59 and is false for 1\.0\.61/);
});

test("a grant the user never gave is not required after the upgrade", () => {
  const notGranted = { ...before, permissions: { accessibility: false, screenRecording: false } };
  const after = {
    version: "1.0.60",
    requirement,
    permissions: notGranted.permissions,
    satisfiesPrevious: true,
  };
  assert.deepEqual(upgradeGrantProblems(notGranted, after), []);
});

test("a probe that could not run counts as a lost grant", () => {
  const after = {
    version: "1.0.60",
    requirement,
    permissions: { error: "the probe wrote nothing" },
    satisfiesPrevious: true,
  };
  const problems = upgradeGrantProblems(before, after);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /the probe wrote nothing/);
});
