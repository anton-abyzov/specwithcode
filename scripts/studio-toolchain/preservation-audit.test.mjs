import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import nodeTest from "node:test";
import {
  LOCK_REVIEW_SHA256,
  LOCK_UPSTREAM,
  PORTED_INHERITED_PATCHES,
  canonicalLockSections,
  loadReviewedLockChanges,
  validateReviewedLockChanges,
  verifyInheritedPatches,
  verifyPreservedLock,
  verifyReviewedPatches,
} from "./preservation-audit.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const upstream = "10f39eb9ac80c9a4b7f5097575dd2addc3b6f631";
// The reviewed lock just before the SDK promotion; its registry data is the identity-mapped upstream's.
const priorCommit = "f0b6d13fb273ae3285861878c43b822731926023";
const hasCommit = (commit) => {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
// Both baselines are outside the public history (the upstream repository and the archived
// development repository, anton-abyzov/specwithcode-dev); a clone without them skips this audit.
const missing = [upstream, priorCommit].filter((commit) => !hasCommit(commit));
const test = (name, ...rest) =>
  missing.length === 0
    ? nodeTest(name, ...rest)
    : nodeTest(
        name,
        { skip: `baseline commits not in this clone: ${missing.join(", ")}` },
        () => {},
      );
const original = missing.length === 0 ? git(["show", `${upstream}:pnpm-lock.yaml`]) : "";
const prior = missing.length === 0 ? git(["show", `${priorCommit}:pnpm-lock.yaml`]) : "";
const registry = ["packages:", "snapshots:"];
const current = readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(root, "apps/server/package.json"), "utf8"));
const recordPath = "scripts/studio-toolchain/reviewed-lock-changes.json";
const record = loadReviewedLockChanges(root);
const reviewed = record.changes;
// Upstream's development record of the SDK, and the runtime record the reviewed lock has now.
const baselineEntry =
  "      '@modelcontextprotocol/sdk':\n        specifier: 1.29.0\n        version: 1.29.0(zod@4.6.5)\n";
const entry =
  "      '@modelcontextprotocol/sdk':\n        specifier: 1.32.2\n        version: 1.32.2(zod@4.6.7)\n";
const runtimeHeader = "  apps/server:\n    dependencies:\n";
const smolToml = "      smol-toml:\n        specifier: 1.9.1\n        version: 1.9.1\n";
const museIntegrity =
  "sha512-/6pblfm1gN96L4c6DZpNIl4TQn+x/PQJ4H0xoqNyJ6Kb+HmSm4FdflydB2MM0iCnPz6Wx2l2r95mmrGDTtvVhw==";
const postcssValueParserIntegrity =
  "sha512-1NNCs6uurfkVbeXG4S8JFT9t19m45ICnif8zWLd5oPSZ50QnwMfK+H3jv408d4jw/7Bttv5axS5IiHoLaVNHeQ==";
const pptxgenjsIntegrity =
  "sha512-TeJISr8wouAuXw4C1F/mC33xbZs/FuEG6nH9FG1Zj+nuPcGMP5YRHl6X+j3HSUnS1f3at6k75ZZXPMZlA5Lj9A==";
const axeCoreIntegrity =
  "sha512-9WTZxEjsZ7b13TH8JPmbV2z8CHbl80/2hm3XPEG4JgNdQLK81IBRXmSxHfMAOkSqQeRxT/0dwNDz2GOm3zzpcQ==";
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
  // Every upstream registry integrity is still present, in order, unless a
  // reviewed removal names it, and the only added ones are the reviewed
  // registry records.
  const stated = (op) =>
    reviewed.filter((c) => c.op === op && c.integrity).map((c) => `integrity: ${c.integrity}}`);
  const added = stated("add");
  const removed = stated("remove");
  assert.deepEqual(added.slice(0, 4), [
    `integrity: ${museIntegrity}}`,
    `integrity: ${postcssValueParserIntegrity}}`,
    `integrity: ${pptxgenjsIntegrity}}`,
    `integrity: ${axeCoreIntegrity}}`,
  ]);
  assert.equal(new Set(added).size, added.length, "A registry record is added once");
  assert.equal(new Set(removed).size, removed.length, "A registry record is removed once");
  for (const line of removed)
    assert.ok(integrities(original).includes(line), `Removed a record upstream never had: ${line}`);
  // A record that left and came back unchanged counts as neither.
  const gone = removed.filter((line) => !added.includes(line));
  const fresh = added.filter((line) => !removed.includes(line));
  assert.deepEqual(
    integrities(current).filter((line) => !fresh.includes(line)),
    integrities(original).filter((line) => !gone.includes(line)),
  );
  assert.equal(
    integrities(current).length,
    integrities(original).length - gone.length + fresh.length,
  );
  // Registry records and snapshots, compared with the reviewed f0b6d13fb lock
  // directly rather than through the identity map, differ only by reviewed changes.
  assert.equal(
    canonicalLockSections(current, registry),
    canonicalLockSections(prior, registry, reviewed),
  );
});

test("ignores registry deprecation notes, which pnpm adds and drops on a refresh", () => {
  const note =
    "    deprecated: |-\n      Deprecated for a test.\n        Second line of the note.\n";
  const at = current.indexOf("    resolution: {integrity: ", current.indexOf("\npackages:\n"));
  const lineEnd = current.indexOf("\n", at) + 1;
  const end = current.indexOf("\n", lineEnd) + 1;
  const noted = current.slice(0, end) + note + current.slice(end);
  assert.notEqual(noted, current);
  verify(noted);
  verify(noted.replace(note, "    deprecated: Single-line note\n"));
  assert.equal(canonicalLockSections(noted, registry), canonicalLockSections(current, registry));
  // The resolution of the entry that carries the note is still compared.
  const resolution = current.slice(at, lineEnd);
  refused(noted.replace(resolution, resolution.replace("sha512-", "sha512-A")));
});

test("compares a dependency, snapshot edge or override named deprecated", () => {
  // Only a field of a packages: entry is advice; these are resolution data.
  refused(
    intoServer(
      current,
      "dependencies",
      "      deprecated:\n        specifier: link:../evil\n        version: link:../evil\n",
    ),
  );
  const snapshots = current.indexOf("\nsnapshots:\n");
  const edges =
    current.indexOf("\n    dependencies:\n", snapshots) + "\n    dependencies:\n".length;
  refused(current.slice(0, edges) + "      deprecated: 1.0.0\n" + current.slice(edges));
  refused(change(current, "\noverrides:\n", "\noverrides:\n  deprecated: 9.9.9\n"));
  // Nor is a line that only starts with the word.
  const at = current.indexOf("    resolution: {integrity: ", current.indexOf("\npackages:\n"));
  const end = current.indexOf("\n", current.indexOf("\n", at) + 1) + 1;
  refused(current.slice(0, end) + "    deprecated:x: 1\n" + current.slice(end));
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
  // With no record the SDK is still upstream's, so the manifest check comes first.
  assert.throws(() => verify(current, []), /retain its pinned version/);
  const upstreamManifest = structuredClone(manifest);
  upstreamManifest.dependencies["@modelcontextprotocol/sdk"] = "1.29.0";
  assert.throws(
    () => verifyPreservedLock(original, current, upstreamManifest, []),
    (error) =>
      /Pinned lock data may change only/.test(error.message) &&
      error.message.includes("+ patchedDependencies: > '@legendapp/list@3.3.5':"),
  );
  // The diagnostic clips large diffs. Isolate the importer to keep proving it
  // is named even when a newly reviewed patch precedes it in the full report.
  assert.throws(
    () =>
      verify(
        current,
        reviewed.filter((c) => !c.lines?.includes("apps/chrome-extension: {}")),
      ),
    (error) => error.message.includes("+ importers: > apps/chrome-extension: {}"),
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
    (s) => change(s, entry, entry.replace("specifier: 1.32.2", "specifier: ^1.32.2")),
  ],
  [
    "SDK resolved version",
    (s) => change(s, entry, entry.replace("version: 1.32.2", "version: 1.33.0")),
  ],
  ["SDK back at the upstream version", (s) => change(s, entry, baselineEntry)],
  ["SDK peer resolution", (s) => change(s, entry, entry.replace("zod@4.6.7", "zod@4.6.8"))],
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
  ["upstream snapshot resolution", (s) => change(s, "      zod: 3.25.76\n", "      zod: 4.5.4\n")],
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
  const version = change(
    original,
    baselineEntry,
    baselineEntry.replace("specifier: 1.29.0", "specifier: ^1.29.0"),
  );
  assert.throws(
    () => verifyPreservedLock(version, current, manifest, reviewed),
    /Pinned SDK version\/resolution or development placement changed/,
  );
  const moved = change(
    change(original, baselineEntry, ""),
    runtimeHeader,
    runtimeHeader + baselineEntry,
  );
  assert.throws(
    () => verifyPreservedLock(moved, current, manifest, reviewed),
    /development placement changed/,
  );
});

test("rejects duplicate baseline server sections or SDK records", () => {
  assert.throws(
    () =>
      verifyPreservedLock(
        original + "\n" + runtimeHeader + baselineEntry,
        current,
        manifest,
        reviewed,
      ),
    /exactly one pinned server importer/,
  );
  assert.throws(
    () =>
      verifyPreservedLock(
        change(original, baselineEntry, baselineEntry + baselineEntry),
        current,
        manifest,
        reviewed,
      ),
    /one pinned server MCP SDK record/,
  );
});

for (const version of [undefined, "^1.32.2", "1.29.0", "1.33.0"]) {
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
  changed.devDependencies["@modelcontextprotocol/sdk"] = "1.32.2";
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

// A depth-1 checkout (the platform test runners) has no history to walk; ci.yml checks out all of it.
const shallow = git(["rev-parse", "--is-shallow-repository"]).trim() === "true";

// Changes reviewed before the public history began name commits of the archived development
// repository, anton-abyzov/specwithcode-dev. They are outside this history, and a clone has them
// only when it fetched that repository too, so only what it holds is checked against its commit.
// A change reviewed from now on names a commit of this history.
const DEVELOPMENT_COMMITS = new Set([
  "168cbd47aecc359eefe47fb6f36f95cbd96900d9",
  "209ffb29ba2112dc68ff007198a07a396c7062d3",
  "32a51ee859475bf355785a028766ff6551f64a18",
  "4cb13e1c74540ff17abda8ea023c1f19cba731c2",
  "518b2844dc986efd81feb027093418fbd16f0edd",
  "64316bf4f428ad3bd20682c13449f05e163bf025",
  "7cc4119124c4f195556cede29c9889963afb5f3c",
  "88218f891bb650cc56304bb675112cb0dfb62756",
  "a3906b9ff60f06bfb578db94a9abeee6b417ea94",
  "a5bc1179ab7a14ec697af126525c9a62707eff8c",
  "b9313e8c63bcc3c82f47bd76b545db262955ce58",
  "c43122baf030e06e39eea71e3eb8b72e47982776",
  "dd3426484f69f0e472dbc6dd2e30413b6297adbf",
  "dd8d2f1a0db62540e17014ebb95afdf746832949",
  "ed675af1ba58ef49a8136dfd82cfc0e9267fa1d3",
  "f3071151947cc4e80740cd534631bfd41dcb41ff",
  "f6c38688e03c4257580057d3c0d182b936dce96b",
]);
const present = (commit) => {
  try {
    git(["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};
const reviewedHere = reviewed.filter(
  (c) => !DEVELOPMENT_COMMITS.has(c.commit) || present(c.commit),
);

test(
  "every reviewed change names a commit merged into this branch",
  { skip: shallow && "shallow checkout has no history to walk" },
  () => {
    for (const c of reviewed) {
      if (!DEVELOPMENT_COMMITS.has(c.commit))
        git(["merge-base", "--is-ancestor", c.commit, "HEAD"]);
    }
  },
);

test("every reviewed change was written by the merged commit it names", () => {
  const diffs = new Map();
  for (const c of reviewedHere) {
    if (!diffs.has(c.commit))
      diffs.set(c.commit, git(["show", "--format=", "-U0", c.commit, "--", "pnpm-lock.yaml"]));
    const indent = "  ".repeat(c.parent.length);
    // A removal's commit dropped the block's first line; any other change's commit wrote a line of it.
    const sign = c.op === "remove" ? "-" : "+";
    const touched = (
      c.op === "replace" ? [c.after] : c.op === "remove" ? [c.lines[0]] : c.lines
    ).map((line) => indent + line);
    assert.ok(
      touched.some((line) => diffs.get(c.commit).includes(`\n${sign}${line}\n`)),
      `${c.commit} did not ${c.op === "remove" ? "drop" : "write"} ${touched[0]}`,
    );
  }
});

test("reviewed patch entries pin their patch file bytes", () => {
  assert.equal(verifyReviewedPatches(root, reviewed), 5);
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
const viteOverride = reviewed.find(
  (c) => c.parent[0] === "overrides:" && c.before?.startsWith("vite: "),
);
const vitePlusOverride = reviewed.find(
  (c) => c.parent[0] === "overrides:" && c.before?.startsWith("vite-plus: "),
);
const removedZod = reviewed.find((c) => c.op === "remove" && c.package === "zod@4.6.5");
const removedSnapshot = reviewed.find((c) => c.op === "remove" && c.parent[0] === "snapshots:");
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
    (c) => (c === routerZod ? { ...c, parent: ["settings:"] } : c),
    /not reviewable/,
  ],
  [
    "an override pointed at another package",
    (c) => (c === viteOverride ? { ...c, after: "vite: npm:@voidzero-dev/other-core@1.6.0" } : c),
    /overrides: is not reviewable/,
  ],
  [
    "an override moved to a range",
    (c) => (c === vitePlusOverride ? { ...c, after: "vite-plus: ^1.6.0" } : c),
    /overrides: is not reviewable/,
  ],
  [
    "an override moved under another key",
    (c) => (c === vitePlusOverride ? { ...c, after: "vite-minus: 1.6.0" } : c),
    /overrides: is not reviewable/,
  ],
  [
    "a removed override",
    (c) =>
      c === vitePlusOverride
        ? {
            op: "remove",
            parent: c.parent,
            lines: [c.before],
            commit: c.commit,
            pr: c.pr,
            reason: c.reason,
          }
        : c,
    /not reviewable for a removal/,
  ],
  [
    "a removed patch entry",
    (c) =>
      c.patchFile && c.op === "add"
        ? {
            op: "remove",
            parent: c.parent,
            lines: c.lines,
            commit: c.commit,
            pr: c.pr,
            reason: c.reason,
          }
        : c,
    /not reviewable for a removal/,
  ],
  [
    "a removed registry record without its integrity",
    (c) => (c === removedZod ? { ...c, integrity: undefined } : c),
    /integrity/,
  ],
  [
    "a removed registry record whose stated integrity differs from its lines",
    (c) => (c === removedZod ? { ...c, integrity: muse.integrity } : c),
    /exactly its stated integrity/,
  ],
  [
    "a removal that states more than its block's first line",
    (c) => (c === removedSnapshot ? { ...c, lines: [...c.lines, "  dependencies:"] } : c),
    /a removal names one block/,
  ],
  ["an unknown op", (c) => (c === routerZod ? { ...c, op: "delete" } : c), /unknown op/],
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
    "a rewritten patch hash without its pinned file",
    (c) =>
      c.patchFile && c.op === "add"
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
    /patchFile/,
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

test("a version change is accepted only with every reviewed removal, replacement and addition", () => {
  assert.ok(viteOverride && vitePlusOverride && removedZod && removedSnapshot);
  // A line pnpm pruned, with no reviewed removal for it, is still expected.
  assert.throws(
    () =>
      verify(
        current,
        reviewed.filter((c) => c !== removedZod),
      ),
    (error) =>
      /Pinned lock data may change only/.test(error.message) &&
      error.message.includes("- packages: > zod@4.6.5:"),
  );
  // A removal applies only to the record with the integrity it states.
  const other = museIntegrity;
  const wrong = reviewed.map((c) =>
    c === removedZod
      ? { ...c, integrity: other, lines: [c.lines[0], `  resolution: {integrity: ${other}}`] }
      : c,
  );
  assert.throws(() => verify(current, wrong), /no longer applies.*does not have resolution/s);
  // The server SDK leaves upstream's version only through the reviewed record.
  const sdkRecord = "'@modelcontextprotocol/sdk':";
  const withoutSdk = reviewed.filter((c) => !(c.op === "replace" && c.parent.at(-1) === sdkRecord));
  assert.equal(reviewed.length - withoutSdk.length, 2, "specifier and version are reviewed");
  assert.throws(() => verify(current, withoutSdk), /retain its pinned version/);
  // An override the lock already has may move to another exact version, and nothing else.
  for (const c of [viteOverride, vitePlusOverride]) {
    assert.equal(c.op, "replace");
    assert.match(c.after, /(?:^vite-plus: |@)1\.6\.0$/);
  }
  assert.throws(
    () =>
      verify(
        current,
        reviewed.filter((c) => c !== vitePlusOverride),
      ),
    /Pinned lock data may change only/,
  );
});

test("rejects reviewed changes that no longer apply to the baseline", () => {
  const stale = reviewed.map((c) => (c === routerZod ? { ...c, before: "zod: 4.4.2" } : c));
  assert.throws(() => verify(current, stale), /no longer applies/);
  // Re-adding a registry record upstream already has, under quotes, is no override.
  const existing = {
    ...muse,
    package: "zod@3.25.76",
    lines: ["'zod@3.25.76':", `  resolution: {integrity: ${muse.integrity}}`],
  };
  assert.throws(() => verify(current, [...reviewed, existing]), /already exists/);
  // Nor can a removed record come back under its name with other bytes.
  const returned = {
    ...muse,
    package: "zod@4.6.5",
    lines: ["'zod@4.6.5':", `  resolution: {integrity: ${muse.integrity}}`],
  };
  assert.throws(
    () => verify(current, [...reviewed, returned]),
    /returns with another integrity than the one removed/,
  );
  assert.throws(
    () => validateReviewedLockChanges({ ...record, upstreamCommit: record.changes[0].commit }),
    /baseline commit/,
  );
});

test("existing patch replacements retain their package key and exact pinned payload", () => {
  const patch = reviewed.find((c) => c.op === "replace" && c.patchFile);
  assert.ok(patch, "The existing LegendList patch replacement is reviewed");
  for (const [edit, message] of [
    [{ after: patch.after.replace("@3.3.5", "@3.3.6") }, /keep its package key/],
    [{ before: patch.before.replace(/[0-9a-f]{64}$/, "not-a-hash") }, /patch entry/],
    [{ parent: [...patch.parent, "nested:"] }, /patch entry/],
    [{ patchFile: undefined }, /patchFile/],
  ]) {
    const changes = reviewed.map((c) => (c === patch ? { ...c, ...edit } : c));
    assert.throws(() => validateReviewedLockChanges({ ...record, changes }), message);
  }
  const temp = mkdtempSync(join(tmpdir(), "lock-replaced-patch-"));
  try {
    mkdirSync(join(temp, "patches"));
    const bytes = readFileSync(join(root, patch.patchFile));
    writeFileSync(join(temp, patch.patchFile), bytes);
    assert.equal(verifyReviewedPatches(temp, [patch]), 1);
    writeFileSync(join(temp, patch.patchFile), Buffer.concat([bytes, Buffer.from("\n")]));
    assert.throws(() => verifyReviewedPatches(temp, [patch]), /Reviewed patch payload changed/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// Inherited patches: upstream's bytes, a reviewed replacement, or a port to a reviewed successor.
function patchTree(t, files) {
  const temp = mkdtempSync(join(tmpdir(), "inherited-patches-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  mkdirSync(join(temp, "patches"));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(temp, path), text);
  return temp;
}
const inherited = new Map([
  ["patches/kept@1.0.0.patch", "kept\n"],
  ["patches/replaced@1.0.0.patch", "upstream\n"],
  ["patches/old@1.0.0.patch", "old\n"],
]);
const patchChanges = [
  { op: "replace", patchFile: "patches/replaced@1.0.0.patch" },
  { op: "add", patchFile: "patches/old@2.0.0.patch" },
];
const portedPatches = new Map([["patches/old@1.0.0.patch", "patches/old@2.0.0.patch"]]);
const patchFiles = {
  "patches/kept@1.0.0.patch": "kept\n",
  "patches/replaced@1.0.0.patch": "reviewed replacement\n",
  "patches/old@2.0.0.patch": "ported\n",
};

nodeTest("inherited patches pass unchanged, replaced under review or ported", (t) => {
  const temp = patchTree(t, patchFiles);
  assert.deepEqual(verifyInheritedPatches(temp, inherited, patchChanges, portedPatches), {
    unchanged: 1,
    replaced: 1,
    ported: 1,
  });
});

nodeTest("an inherited patch cannot change or disappear without a reviewed lock change", (t) => {
  const run = (files, changes = patchChanges, ported = portedPatches) =>
    verifyInheritedPatches(patchTree(t, files), inherited, changes, ported);
  assert.throws(
    () => run({ ...patchFiles, "patches/kept@1.0.0.patch": "edited\n" }),
    /Inherited patch payload changed: patches\/kept/,
  );
  const { "patches/kept@1.0.0.patch": _kept, ...withoutKept } = patchFiles;
  assert.throws(() => run(withoutKept), /Inherited patch removed: patches\/kept/);
  // A replacement that is not reviewed, or reviewed only as an addition, is a change.
  assert.throws(() => run(patchFiles, [patchChanges[1]]), /payload changed: patches\/replaced/);
  assert.throws(
    () => run(patchFiles, [{ ...patchChanges[0], op: "add" }, patchChanges[1]]),
    /payload changed: patches\/replaced/,
  );
  const { "patches/replaced@1.0.0.patch": _replaced, ...withoutReplaced } = patchFiles;
  assert.throws(() => run(withoutReplaced), /Inherited patch removed: patches\/replaced/);
});

nodeTest("a ported patch must be gone and succeeded by a reviewed patch", (t) => {
  const run = (files, changes = patchChanges, ported = portedPatches) =>
    verifyInheritedPatches(patchTree(t, files), inherited, changes, ported);
  assert.throws(
    () => run({ ...patchFiles, "patches/old@1.0.0.patch": "old\n" }),
    /Ported inherited patch is still present/,
  );
  assert.throws(() => run(patchFiles, [patchChanges[0]]), /no reviewed successor/);
  assert.throws(
    () =>
      run(
        patchFiles,
        patchChanges,
        new Map([["patches/old@1.0.0.patch", "patches/kept@1.0.0.patch"]]),
      ),
    /successor is inherited/,
  );
  // Without the port entry the missing file is a removal.
  assert.throws(
    () => run(patchFiles, patchChanges, new Map()),
    /Inherited patch removed: patches\/old/,
  );
});

test("the committed ports name reviewed successors that this checkout carries", () => {
  const reviewedAdds = new Set(
    reviewed.filter((c) => c.op === "add" && c.patchFile).map((c) => c.patchFile),
  );
  const upstreamPatches = git(["ls-tree", "-r", "--name-only", upstream, "--", "patches/"])
    .trim()
    .split("\n");
  for (const [before, after] of PORTED_INHERITED_PATCHES) {
    assert.ok(upstreamPatches.includes(before), `Not an inherited patch: ${before}`);
    assert.ok(reviewedAdds.has(after), `Successor is not a reviewed patch: ${after}`);
    assert.equal(before.replace(/@[^@]+$/, ""), after.replace(/@[^@]+$/, ""), "Same package");
    // Upstream's own lock did not apply the patch it still carried.
    const name = before.slice("patches/".length).replace(/\.patch$/, "");
    assert.ok(!git(["show", `${upstream}:pnpm-lock.yaml`]).includes(`\n  ${name}: `), name);
  }
});
