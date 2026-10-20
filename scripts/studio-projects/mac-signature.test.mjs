import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { expectedRequirement, macSignatureProblems } from "./mac-signature.mjs";

const assert = NodeAssert;
const { test } = NodeTest;

const developerId = {
  codesign: `Executable=/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode
Identifier=com.specweave.studio
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=429 flags=0x10000(runtime) hashes=3+7 location=embedded
Authority=Developer ID Application: EasyChamp, Inc. (NMCB2JZ7QG)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Oct 15, 2026 at 10:00:00 PM
TeamIdentifier=NMCB2JZ7QG
`,
  verify: "",
  spctl: `/Applications/SpecWithCode.app: accepted
source=Notarized Developer ID
origin=Developer ID Application: EasyChamp, Inc. (NMCB2JZ7QG)
`,
  stapler: "Processing: /Applications/SpecWithCode.app\nThe validate action worked!\n",
};

// What SpecWithCode 1.0.30 shipped as.
const adHoc = {
  codesign: `Executable=/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode
Identifier=com.specweave.studio
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=429 flags=0x2(adhoc) hashes=3+7 location=embedded
Signature=adhoc
TeamIdentifier=not set
`,
  verify: "",
  spctl: "/Applications/SpecWithCode.app: rejected\n",
  stapler: "SpecWithCode.app does not have a ticket stapled to it.\n",
};

test("a notarized Developer ID build from the release team may ship", () => {
  assert.deepEqual(macSignatureProblems(developerId), []);
});

test("an ad-hoc build is refused because each update would prompt for the keychain", () => {
  const problems = macSignatureProblems(adHoc);
  assert.ok(problems.some((problem) => problem.includes("ad hoc")));
  assert.ok(problems.some((problem) => problem.includes("TeamIdentifier is not set")));
  assert.ok(problems.some((problem) => problem.includes("notarized")));
});

test("a Developer ID build from another team is refused", () => {
  const otherTeam = {
    ...developerId,
    codesign: developerId.codesign.replace(
      "TeamIdentifier=NMCB2JZ7QG",
      "TeamIdentifier=ABCDE12345",
    ),
  };
  assert.deepEqual(macSignatureProblems(otherTeam), [
    "TeamIdentifier is ABCDE12345, not NMCB2JZ7QG.",
  ]);
});

test("a local development signature is refused", () => {
  const development = {
    ...developerId,
    codesign: developerId.codesign
      .replace(
        /^Authority=Developer ID Application: .*$/m,
        "Authority=Apple Development: Someone (ABCDEFGHIJ)",
      )
      .replace("flags=0x10000(runtime)", "flags=0x0(none)"),
  };
  const problems = macSignatureProblems(development);
  assert.ok(
    problems.includes("The app is not signed with a Developer ID Application certificate."),
  );
  assert.ok(problems.includes("The hardened runtime is off, so the app cannot be notarized."));
});

test("a build that is not stapled is refused", () => {
  assert.deepEqual(macSignatureProblems({ ...developerId, stapler: "does not have a ticket" }), [
    "The notarization ticket is not stapled to the app.",
  ]);
});

const releaseRequirement = `Executable=/Applications/SpecWithCode.app/Contents/MacOS/SpecWithCode
designated => ${expectedRequirement()}
`;

test("the exact designated requirement and team-signed helpers may ship", () => {
  const nested = [
    {
      path: "Contents/Resources/voice/studio-voice",
      codesign: "Identifier=studio-voice\nTeamIdentifier=NMCB2JZ7QG\n",
    },
  ];
  assert.deepEqual(
    macSignatureProblems({ ...developerId, requirement: releaseRequirement, nested }),
    [],
  );
});

test("a changed designated requirement is refused because users would grant computer use again", () => {
  const hashPinned = 'designated => cdhash H"0123456789abcdef0123456789abcdef01234567"\n';
  const problems = macSignatureProblems({ ...developerId, requirement: hashPinned });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /designated requirement .* grant computer use again/);
});

test("an ad-hoc or other-team helper inside the app is refused", () => {
  const nested = [
    {
      path: "Contents/Resources/voice/studio-voice",
      codesign: "Identifier=studio-voice\nSignature=adhoc\nTeamIdentifier=not set\n",
    },
    {
      path: "Contents/Frameworks/SpecWithCode Helper.app/Contents/MacOS/SpecWithCode Helper",
      codesign: "Identifier=x\nTeamIdentifier=ABCDE12345\n",
    },
  ];
  assert.deepEqual(
    macSignatureProblems({ ...developerId, requirement: releaseRequirement, nested }),
    [
      "Contents/Resources/voice/studio-voice is signed ad hoc.",
      "Contents/Frameworks/SpecWithCode Helper.app/Contents/MacOS/SpecWithCode Helper has TeamIdentifier ABCDE12345, not NMCB2JZ7QG.",
    ],
  );
});
