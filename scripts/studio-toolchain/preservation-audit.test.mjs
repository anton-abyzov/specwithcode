import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  LOCK_REVIEW_SHA256,
  LOCK_UPSTREAM,
  canonicalLockSections,
  loadReviewedLockChanges,
  validateReviewedLockChanges,
  verifyPreservedLock,
  verifyReviewedPatches,
} from "./preservation-audit.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const upstream = "10f39eb9ac80c9a4b7f5097575dd2addc3b6f631";
const original = git(["show", `${upstream}:pnpm-lock.yaml`]);
// The reviewed lock just before the SDK promotion; its registry data is the identity-mapped upstream's.
const prior = git(["show", "f0b6d13fb273ae3285861878c43b822731926023:pnpm-lock.yaml"]);
const registry = ["packages:", "snapshots:"];
const current = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "apps/server/package.json"), "utf8"));
const recordPath = "scripts/studio-toolchain/reviewed-lock-changes.json";
const record = loadReviewedLockChanges(root);
const reviewed = record.changes;
const entry =
  "      '@modelcontextprotocol/sdk':\n        specifier: 1.29.0\n        version: 1.29.0(zod@4.6.5)\n";
const runtimeHeader = "  apps/server:\n    dependencies:\n";
const smolToml = "      smol-toml:\n        specifier: 1.8.0\n        version: 1.8.0\n";
const museIntegrity =
  "sha512-/6pblfm1gN96L4c6DZpNIl4TQn+x/PQJ4H0xoqNyJ6Kb+HmSm4FdflydB2MM0iCnPz6Wx2l2r95mmrGDTtvVhw==";
const postcssValueParserIntegrity =
  "sha512-1NNCs6uurfkVbeXG4S8JFT9t19m45ICnif8zWLd5oPSZ50QnwMfK+H3jv408d4jw/7Bttv5axS5IiHoLaVNHeQ==";
const pptxgenjsIntegrity =
  "sha512-TeJISr8wouAuXw4C1F/mC33xbZs/FuEG6nH9FG1Zj+nuPcGMP5YRHl6X+j3HSUnS1f3at6k75ZZXPMZlA5Lj9A==";
const patchedBuilder =
  "app-builder-lib: 26.15.6(patch_hash=4688f96749e3d76cf27bc535d874470bf264610a331db13644df7715d699acf1)(dmg-builder@26.15.6)(electron-builder-squirrel-windows@26.15.6)";

function change(value, before, after) {
  assert.ok(value.includes(before), "Mutation must affect an existing byte sequence");
  const result = value.replace(before, after);
  assert.notEqual(result, value);
  return result;
}
const verify = (lock, changes = reviewed) => verifyPreservedLock(original, lock, manifest, changes);
function refused(lock) {
  assert.throws(() => verify(lock), /Pinned lock data/);
}
// Inserts a block right after the header line of one server importer section.
function intoServer(lock, section, block) {
  const header = `    ${section}:\n`;
  const at = lock.indexOf(header, lock.indexOf(runtimeHeader)) + header.length;
  return lock.slice(0, at) + block + lock.slice(at);
}
const integrities = (lock) => lock.match(/integrity: .+/g);

test("accepts the actual lock: identity map, exact SDK promotion and reviewed changes only", () => {
  verify(current);
  assert.equal(current.split(entry).length, 2, "The SDK runtime record appears exactly once");
  // Every upstream registry integrity is still present, in order, and the only
  // added ones are the reviewed registry records.
  const added = reviewed.filter((c) => c.integrity).map((c) => `integrity: ${c.integrity}}`);
  assert.deepEqual(added, [
    `integrity: ${museIntegrity}}`,
    `integrity: ${postcssValueParserIntegrity}}`,
    `integrity: ${pptxgenjsIntegrity}}`,
  ]);
  assert.deepEqual(
    integrities(current).filter((line) => !added.includes(line)),
    integrities(original),
  );
  assert.equal(integrities(current).length, integrities(original).length + added.length);
  // Registry records and snapshots, compared with the reviewed f0b6d13fb lock
  // directly rather than through the identity map, differ only by reviewed changes.
  assert.equal(
    canonicalLockSections(current, registry),
    canonicalLockSections(prior, registry, reviewed),
  );
});

test("compares registry data with the reviewed f0b6d13fb lock without trusting the identity map", () => {
  // An identity map widened to rewrite registry data would change the baseline
  // and the lock alike, so only the direct comparison can refuse it.
  const widened = (lock) => change(lock, "integrity: sha512-", "integrity: sha512-altered");
  verifyPreservedLock(widened(original), widened(current), manifest, reviewed);
  assert.notEqual(
    canonicalLockSections(widened(current), registry),
    canonicalLockSections(prior, registry, reviewed),
  );
});

test("without the reviewed record the merged lock changes are refused and named", () => {
  assert.throws(
    () => verify(current, []),
    (error) =>
      /Pinned lock data may change only/.test(error.message) &&
      error.message.includes("+ importers: > apps/chrome-extension: {}"),
  );
});

test("accepts pnpm re-sorting sibling blocks, but not moving a block to another parent", () => {
  verify(intoServer(change(current, smolToml, ""), "dependencies", smolToml));
  verify(current.replaceAll("\n\n", "\n"));
  refused(intoServer(change(current, smolToml, ""), "devDependencies", smolToml));
});

for (const [name, mutate] of [
  [
    "SDK requested version",
    (s) => change(s, entry, entry.replace("specifier: 1.29.0", "specifier: ^1.29.0")),
  ],
  [
    "SDK resolved version",
    (s) => change(s, entry, entry.replace("version: 1.29.0", "version: 1.30.0")),
  ],
  ["SDK peer resolution", (s) => change(s, entry, entry.replace("zod@4.6.5", "zod@4.6.6"))],
  ["registry integrity", (s) => change(s, "integrity: sha512-", "integrity: sha512-altered")],
  [
    "reviewed registry integrity",
    (s) =>
      change(
        s,
        `integrity: ${museIntegrity}`,
        `integrity: ${museIntegrity.replace("/6pbl", "/7pbl")}`,
      ),
  ],
  [
    "reviewed package version",
    (s) =>
      change(
        s,
        "specifier: 1.4.11\n        version: 1.4.11(",
        "specifier: 1.4.12\n        version: 1.4.12(",
      ),
  ],
  ["other importer dependency", (s) => change(s, "version: 4.0.1", "version: 4.0.2")],
  ["upstream snapshot resolution", (s) => change(s, "      zod: 4.4.3\n", "      zod: 4.5.4\n")],
  [
    "half-reverted reviewed patch reference",
    (s) => change(s, patchedBuilder, patchedBuilder.replace(/\(patch_hash=[0-9a-f]+\)/, "")),
  ],
  [
    "extra importer",
    (s) => change(s, "importers:\n", "importers:\n\n  unreviewed:\n    dependencies: {}\n"),
  ],
  ["extra registry data", (s) => s + "\nunreviewed: true\n"],
  ["omitted SDK runtime record", (s) => change(s, entry, "")],
  ["duplicate SDK runtime record", (s) => change(s, entry, entry + entry)],
  [
    "SDK promotion to a different importer",
    (s) =>
      change(
        change(s, entry, ""),
        "  apps/web:\n    dependencies:\n",
        "  apps/web:\n    dependencies:\n" + entry,
      ),
  ],
  [
    "block layout",
    (s) => change(s, "\n  apps/chrome-extension: {}\n", "\n   apps/chrome-extension: {}\n"),
  ],
])
  test(`rejects changed ${name}`, () => refused(mutate(current)));

test("rejects an unreviewed new package, even with a complete registry record", () => {
  let lock = intoServer(
    current,
    "dependencies",
    "      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n",
  );
  refused(lock);
  lock = change(
    lock,
    "\npackages:\n\n",
    `\npackages:\n\n  left-pad@1.3.0:\n    resolution: {integrity: sha512-${"A".repeat(86)}==}\n\n`,
  );
  lock = change(lock, "\nsnapshots:\n\n", "\nsnapshots:\n\n  left-pad@1.3.0: {}\n\n");
  refused(lock);
  // An unreviewed dependency on a package upstream already pins is refused too.
  refused(
    change(
      current,
      "  apps/web:\n    dependencies:\n",
      "  apps/web:\n    dependencies:\n" + smolToml,
    ),
  );
});

test("rejects retaining the SDK in server devDependencies, even with the runtime copy", () => {
  refused(intoServer(current, "devDependencies", entry));
  refused(intoServer(change(current, entry, ""), "devDependencies", entry));
});

test("rejects a baseline whose SDK version or original section changed", () => {
  const version = change(original, entry, entry.replace("specifier: 1.29.0", "specifier: ^1.29.0"));
  assert.throws(
    () => verifyPreservedLock(version, current, manifest, reviewed),
    /Pinned SDK version\/resolution or development placement changed/,
  );
  const moved = change(change(original, entry, ""), runtimeHeader, runtimeHeader + entry);
  assert.throws(
    () => verifyPreservedLock(moved, current, manifest, reviewed),
    /development placement changed/,
  );
});

test("rejects duplicate baseline server sections or SDK records", () => {
  assert.throws(
    () => verifyPreservedLock(original + "\n" + runtimeHeader + entry, current, manifest, reviewed),
    /exactly one pinned server importer/,
  );
  assert.throws(
    () => verifyPreservedLock(change(original, entry, entry + entry), current, manifest, reviewed),
    /one pinned server MCP SDK record/,
  );
});

for (const version of [undefined, "^1.29.0", "1.30.0"]) {
  test(`rejects server manifest runtime version ${version}`, () => {
    const changed = structuredClone(manifest);
    changed.dependencies["@modelcontextprotocol/sdk"] = version;
    assert.throws(
      () => verifyPreservedLock(original, current, changed, reviewed),
      /retain its pinned version/,
    );
  });
}
test("rejects a duplicate server manifest development entry", () => {
  const changed = structuredClone(manifest);
  changed.devDependencies["@modelcontextprotocol/sdk"] = "1.29.0";
  assert.throws(
    () => verifyPreservedLock(original, current, changed, reviewed),
    /must not remain a development dependency/,
  );
});

test("the reviewed record is pinned by digest and bound to the upstream baseline", () => {
  const bytes = readFileSync(join(root, recordPath));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), LOCK_REVIEW_SHA256);
  assert.equal(record.upstreamCommit, LOCK_UPSTREAM);
  assert.equal(LOCK_UPSTREAM, upstream);
  const temp = mkdtempSync(join(tmpdir(), "lock-review-"));
  try {
    mkdirSync(join(temp, dirname(recordPath)), { recursive: true });
    const edited = JSON.parse(bytes.toString("utf8"));
    edited.changes.find((c) => c.integrity).reason += " ";
    writeFileSync(join(temp, recordPath), JSON.stringify(edited, null, 2) + "\n");
    assert.throws(() => loadReviewedLockChanges(temp), /differs from its pinned digest/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("every reviewed change was written by the merged commit it names", () => {
  const diffs = new Map();
  for (const c of reviewed) {
    git(["merge-base", "--is-ancestor", c.commit, "HEAD"]);
    if (!diffs.has(c.commit))
      diffs.set(c.commit, git(["show", "--format=", "-U0", c.commit, "--", "pnpm-lock.yaml"]));
    const indent = "  ".repeat(c.parent.length);
    const written = (c.op === "add" ? c.lines : [c.after]).map((line) => indent + line);
    assert.ok(
      written.some((line) => diffs.get(c.commit).includes(`\n+${line}\n`)),
      `${c.commit} did not write ${written[0]}`,
    );
  }
});

test("reviewed patch entries pin their patch file bytes", () => {
  assert.equal(verifyReviewedPatches(root, reviewed), 3);
  const patch = reviewed.find((c) => c.patchFile);
  const temp = mkdtempSync(join(tmpdir(), "lock-patch-"));
  try {
    mkdirSync(join(temp, "patches"));
    writeFileSync(
      join(temp, patch.patchFile),
      readFileSync(join(root, patch.patchFile), "utf8") + "\n",
    );
    assert.throws(() => verifyReviewedPatches(temp, reviewed), /Reviewed patch payload changed/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("accepts an override only when it cuts one dependency edge", () => {
  const cut = reviewed.find((c) => c.parent[0] === "overrides:");
  assert.ok(cut, "The pptxgenjs edge cuts are reviewed overrides");
  for (const line of ["pptxgenjs>image-size: 2.0.4", "image-size: '-'", "'@a/b': 1.0.0"]) {
    const changes = reviewed.map((c) => (c === cut ? { ...c, lines: [line] } : c));
    assert.throws(
      () => validateReviewedLockChanges({ ...record, changes }),
      /overrides: is not reviewable/,
      line,
    );
  }
  const twoLines = reviewed.map((c) => (c === cut ? { ...c, lines: [...c.lines, c.lines[0]] } : c));
  assert.throws(
    () => validateReviewedLockChanges({ ...record, changes: twoLines }),
    /not reviewable/,
  );
});

const muse = reviewed.find((c) => c.integrity);
const routerZod = reviewed.find((c) => c.before === "zod: 4.4.3");
for (const [name, edit, message] of [
  [
    "an integrity that differs from its record",
    (c) => (c === muse ? { ...c, integrity: c.integrity.replace("/6pbl", "/7pbl") } : c),
    /exactly its stated integrity/,
  ],
  [
    "a registry record without its integrity",
    (c) => (c === muse ? { ...c, integrity: undefined } : c),
    /integrity/,
  ],
  [
    "a non-registry resolution",
    (c) =>
      c === muse
        ? { ...c, lines: [...c.lines, "  resolution: {tarball: https://example.invalid/x.tgz}"] }
        : c,
    /exactly its stated integrity/,
  ],
  [
    "a rewrite of registry metadata",
    (c) => (c === routerZod ? { ...c, parent: ["packages:"] } : c),
    /registry metadata can only be added/,
  ],
  [
    "a rewritten integrity",
    (c) => (c === routerZod ? { ...c, after: "resolution: {integrity: sha512-x}" } : c),
    /resolution data belongs to a registry record/,
  ],
  [
    "an unreviewable section",
    (c) => (c === routerZod ? { ...c, parent: ["overrides:"] } : c),
    /not reviewable/,
  ],
  ["an unknown op", (c) => (c === routerZod ? { ...c, op: "remove" } : c), /unknown op/],
  [
    "an extra field",
    (c) => (c === routerZod ? { ...c, approvedBy: "anyone" } : c),
    /unexpected field/,
  ],
  [
    "an abbreviated commit",
    (c) => (c === routerZod ? { ...c, commit: c.commit.slice(0, 9) } : c),
    /full sha/,
  ],
  [
    "a patch entry without its file",
    (c) => (c.patchFile ? { ...c, patchFile: undefined } : c),
    /patchFile/,
  ],
  [
    "a rewritten patch hash",
    (c) =>
      c.patchFile
        ? {
            op: "replace",
            parent: c.parent,
            before: c.lines[0],
            after: c.lines[0].replace(/[0-9a-f]{64}$/, "0".repeat(64)),
            commit: c.commit,
            pr: c.pr,
            reason: c.reason,
          }
        : c,
    /patch entries can only be added/,
  ],
  [
    "a registry record that is not name@version",
    (c) =>
      c === muse
        ? {
            ...c,
            package: "@muse-code/sdk@file:../sdk",
            lines: ["'@muse-code/sdk@file:../sdk':", ...c.lines.slice(1)],
          }
        : c,
    /exact name@version/,
  ],
])
  test(`rejects a reviewed record with ${name}`, () => {
    const changes = reviewed.map(edit);
    assert.throws(() => validateReviewedLockChanges({ ...record, changes }), message);
    assert.throws(() => verify(current, changes), message);
  });

test("rejects reviewed changes that no longer apply to the baseline", () => {
  const stale = reviewed.map((c) => (c === routerZod ? { ...c, before: "zod: 4.4.2" } : c));
  assert.throws(() => verify(current, stale), /no longer applies/);
  // Re-adding a registry record upstream already has, under quotes, is no override.
  const existing = {
    ...muse,
    package: "zod@4.6.5",
    lines: ["'zod@4.6.5':", `  resolution: {integrity: ${muse.integrity}}`],
  };
  assert.throws(() => verify(current, [...reviewed, existing]), /already exists/);
  assert.throws(
    () => validateReviewedLockChanges({ ...record, upstreamCommit: record.changes[0].commit }),
    /baseline commit/,
  );
});
