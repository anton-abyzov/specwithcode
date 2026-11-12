import * as NodeAssert from "node:assert/strict";

const assert = NodeAssert;

// The rules the brand audit applies to licence text, notices and publishable
// keys, kept free of I/O so each can be tested against altered inputs.

const COPYRIGHT_LINE = /^Copyright \(c\) [^\n]+\n/m;

// The inherited licence has to appear in the notices once, byte for byte. More
// notices may follow it, each under its own second-level heading, so that no
// later text runs on as if it were part of the inherited licence.
export function assertInheritedNoticeRetained(notices, upstreamLicense) {
  assert.ok(upstreamLicense.startsWith("MIT License\n"), "Upstream licence is not the MIT text");
  const start = notices.indexOf("MIT License\n");
  assert.ok(start >= 0, "The inherited licence is missing from the notices");
  assert.equal(
    notices.slice(start, start + upstreamLicense.length),
    upstreamLicense,
    "The inherited licence in the notices differs from upstream's",
  );
  assert.equal(
    notices.split(upstreamLicense).length,
    2,
    "The inherited licence must appear in the notices exactly once",
  );
  const rest = notices.slice(start + upstreamLicense.length);
  assert.match(
    rest,
    /^(?:$|\n## \S)/,
    "Text after the inherited licence must start a new section of the notices",
  );
}

// The project's own terms: the MIT text unchanged, under the owner's copyright
// line alone. The inherited copyright stays in the notices, never in LICENSE.
export function assertProjectLicense(license, upstreamLicense, owner) {
  assert.equal(typeof license, "string", "LICENSE is missing");
  const upstreamCopyright = COPYRIGHT_LINE.exec(upstreamLicense)?.[0];
  assert.ok(upstreamCopyright, "Upstream licence has no copyright line");
  const copyrights = license.match(new RegExp(COPYRIGHT_LINE.source, "gm")) ?? [];
  assert.equal(copyrights.length, 1, "LICENSE must carry exactly one copyright line");
  assert.match(
    copyrights[0],
    new RegExp(`^Copyright \\(c\\) \\d{4}(?:-\\d{4})? ${owner}\\n$`),
    "LICENSE must name the project owner",
  );
  assert.notEqual(copyrights[0], upstreamCopyright, "LICENSE carries the inherited copyright");
  assert.equal(
    license.replace(copyrights[0], ""),
    upstreamLicense.replace(upstreamCopyright, ""),
    "LICENSE is not the unchanged MIT text",
  );
}

const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  // Swift packages keep their tests under Tests/.
  "Tests",
  "__tests__",
  "integration",
  "testkit",
  // Helpers and fixtures that only tests import.
  "testing",
  "testUtils",
]);

export const isTestPath = (path, isProtectedPath = () => false) =>
  isProtectedPath(path) ||
  /\.(?:test|spec)\.(?:[cm]?[jt]sx?|py)$/.test(path) ||
  path.split("/").some((part) => TEST_DIRECTORIES.has(part));

// A Clerk publishable key is "pk_<env>_" followed by its base64 frontend host
// and a closing "$". It is public by design, so the app's own key may sit in
// client source; a key for any other host may not, and a key for an upstream
// host may not sit anywhere, tests included.
export const OWNED_PUBLISHABLE_KEY_HOSTS = Object.freeze(["clerk.spec-weave.com"]);

export function publishableKeyFinding(path, encodedHost, isProtectedPath) {
  const host = Buffer.from(encodedHost, "base64").toString("latin1");
  const printable = /^[\x20-\x7e]+$/.test(host);
  if (printable && /t3/i.test(host)) return "key issued for an upstream host";
  if (isTestPath(path, isProtectedPath)) return null;
  if (printable && OWNED_PUBLISHABLE_KEY_HOSTS.includes(host.replace(/\$$/, ""))) return null;
  return "publishable key outside a test that is not for an owned host";
}
