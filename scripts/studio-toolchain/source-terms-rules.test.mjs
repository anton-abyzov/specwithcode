import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  assertInheritedNoticeRetained,
  assertProjectLicense,
  isTestPath,
  publishableKeyFinding,
} from "./source-terms-rules.mjs";

const assert = NodeAssert;
const { test } = NodeTest;

const body = [
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  'of this software, to deal in the Software without restriction. THE SOFTWARE IS PROVIDED "AS IS".',
  "",
].join("\n");
const upstreamLicense = `MIT License\n\nCopyright (c) 2026 Upstream Inc.\n${body}`;
const projectLicense = `MIT License\n\nCopyright (c) 2026 Project Owner\n${body}`;
const intro =
  "# Third-party notices\n\nReleased under the MIT License in LICENSE.\n\n## Inherited code\n\n";
const key = (host) => Buffer.from(host).toString("base64");

test("the inherited licence may close the notices or be followed by a new section", () => {
  assertInheritedNoticeRetained(intro + upstreamLicense, upstreamLicense);
  assertInheritedNoticeRetained(
    `${intro}${upstreamLicense}\n## Linux voice\n\nBundled tools keep their own terms.\n`,
    upstreamLicense,
  );
});

test("an altered inherited licence is rejected", () => {
  for (const altered of [
    upstreamLicense.replace("Upstream Inc.", "Project Owner"),
    upstreamLicense.replace("free of charge", "for a fee"),
    upstreamLicense.replace('"AS IS"', "AS IS"),
    upstreamLicense.replace("MIT License\n\n", "MIT License\n"),
  ]) {
    assert.throws(
      () => assertInheritedNoticeRetained(`${intro}${altered}\n## Next\n`, upstreamLicense),
      /differs from upstream's/,
    );
  }
});

test("an inherited licence that does not start its own paragraph is rejected", () => {
  for (const lead of ["This is not the ", "## Inherited code\nNot the ", ""]) {
    assert.throws(
      () => assertInheritedNoticeRetained(`${lead}${upstreamLicense}\n## Next\n`, upstreamLicense),
      /must start its own paragraph/,
      JSON.stringify(lead),
    );
  }
});

test("a missing or repeated inherited licence is rejected", () => {
  assert.throws(() => assertInheritedNoticeRetained(intro, upstreamLicense), /missing/);
  assert.throws(
    () =>
      assertInheritedNoticeRetained(
        `${intro}${upstreamLicense}\n## Again\n\n${upstreamLicense}`,
        upstreamLicense,
      ),
    /exactly once/,
  );
});

test("text that runs on after the inherited licence is rejected", () => {
  for (const tail of [
    "Also covers the project.\n",
    "\nAlso covers the project.\n",
    "\n### Sub\n",
    "## Next\n",
  ]) {
    assert.throws(
      () => assertInheritedNoticeRetained(intro + upstreamLicense + tail, upstreamLicense),
      /must start a new section/,
    );
  }
});

test("the project licence is the MIT text under the owner's copyright alone", () => {
  assertProjectLicense(projectLicense, upstreamLicense, "Project Owner");
  assertProjectLicense(
    projectLicense.replace("2026 Project", "2026-2027 Project"),
    upstreamLicense,
    "Project Owner",
  );
});

test("a missing, reworded or misattributed project licence is rejected", () => {
  const rejects = (license, message) =>
    assert.throws(() => assertProjectLicense(license, upstreamLicense, "Project Owner"), message);
  rejects(undefined, /LICENSE is missing/);
  rejects(upstreamLicense, /must name the project owner/);
  rejects(
    projectLicense.replace("Copyright", "Copyright (c) 2026 Upstream Inc.\nCopyright"),
    /exactly one copyright line/,
  );
  rejects(projectLicense.replace("free of charge", "for a fee"), /unchanged MIT text/);
  rejects(`${projectLicense}\nAdditional terms apply.\n`, /unchanged MIT text/);
  rejects(
    `${upstreamLicense.replace("Copyright (c) 2026 Upstream Inc.\n", "")}Copyright (c) 2026 Project Owner\n`,
    /must open with the MIT title and the copyright line/,
  );
  rejects(
    projectLicense.replace("MIT License", "Proprietary License"),
    /must open with the MIT title/,
  );
  rejects(projectLicense.replace("Project Owner", "Someone Else"), /must name the project owner/);
});

test("Swift test targets and testing helpers count as tests, sources do not", () => {
  for (const path of [
    "apps/ios/Kit/Tests/TransportTests/ConnectTests.swift",
    "infra/relay/src/testing/fixtures.ts",
    "apps/web/src/auth.test.ts",
    "apps/server/integration/run.ts",
  ]) {
    assert.equal(isTestPath(path), true, path);
  }
  for (const path of [
    "apps/ios/Kit/Sources/Transport/ConnectConfig.swift",
    "apps/web/src/latest.ts",
    "apps/web/src/Testimonials.tsx",
  ]) {
    assert.equal(isTestPath(path), false, path);
  }
  assert.equal(
    isTestPath("apps/a/fixtures/x.json", (p) => p.includes("/fixtures/")),
    true,
  );
});

test("the app's own key may sit in client source", () => {
  assert.equal(
    publishableKeyFinding("apps/ios/Kit/Sources/ConnectConfig.swift", key("clerk.spec-weave.com$")),
    null,
  );
});

test("a key for another host is rejected outside tests and allowed inside them", () => {
  for (const host of ["clerk.example.com$", "clerk.spec-weave.com.example.com$", "x", "test"]) {
    assert.match(
      publishableKeyFinding("apps/web/src/config.ts", key(host)),
      /not for an owned host/,
      host,
    );
    assert.equal(publishableKeyFinding("apps/web/src/config.test.ts", key(host)), null, host);
  }
});

test("a key for an upstream host is rejected everywhere", () => {
  for (const path of [
    "apps/web/src/config.ts",
    "apps/web/src/config.test.ts",
    "apps/ios/Kit/Tests/ConnectTests.swift",
  ]) {
    assert.equal(
      publishableKeyFinding(path, key("clerk.t3.example$")),
      "key issued for an upstream host",
      path,
    );
  }
});
