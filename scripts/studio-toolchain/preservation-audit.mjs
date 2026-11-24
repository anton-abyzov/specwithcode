import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_UPSTREAM = "10f39eb9ac80c9a4b7f5097575dd2addc3b6f631";
// A record edit is not an approval. This digest pins the reviewed closed set of
// lock changes, so approving another one also takes a reviewed edit here.
export const LOCK_REVIEW_SHA256 =
  "b99052f28c7565faf5f2ba0b0dcdf18f1ab5649ecd9e49244ce43b70d6b1c1e2";
const LOCK_REVIEW_PATH = "scripts/studio-toolchain/reviewed-lock-changes.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const LAYOUT = "Pinned lock data must keep pnpm's two-space block layout";
const DIFFERS =
  "Pinned lock data may change only through the identity map, the exact server MCP SDK runtime promotion and reviewed-lock-changes.json";
const SDK = "@modelcontextprotocol/sdk";

// pnpm writes the lock as nested two-space blocks: a line's parent is the
// nearest line above it with two fewer spaces. Anything else is refused, so the
// tree read here is the tree pnpm reads.
function parseLockTree(text, where) {
  const root = { line: "", children: [] };
  const stack = [{ indent: -2, node: root }];
  text.split("\n").forEach((raw, index) => {
    if (raw === "") return;
    const indent = raw.length - raw.trimStart().length;
    const parent = stack.findLast((entry) => entry.indent < indent);
    assert.ok(
      !/\s$/.test(raw) && !raw.includes("\t") && parent.indent + 2 === indent,
      `${LAYOUT}: ${where} line ${index + 1}`,
    );
    stack.length = stack.indexOf(parent) + 1;
    const node = { line: raw.slice(indent), children: [] };
    parent.node.children.push(node);
    stack.push({ indent, node });
  });
  return root;
}

// Map keys and set-like lists carry no order, and pnpm re-sorts them whenever
// it rewrites the lock (for example after the identity map renamed keys).
// Every line still has to sit under the same parents, the same number of times.
// A registry's deprecation note is advice, not resolution data: pnpm adds or drops
// it whenever it rewrites the lock against the live registry, while the
// resolution, integrity and dependencies stay the same. Only that field of a
// package entry under the top-level packages: section is left out of the
// comparison; a dependency, snapshot edge or override named deprecated is not.
// `parents` lists the lines above the node, outermost first.
const advisory = (node, parents) =>
  parents.length === 2 && parents[0] === "packages:" && /^deprecated:(?: |$)/.test(node.line);

function canonicalLock(node, depth = 0, parents = []) {
  const here = depth === 0 ? parents : [...parents, node.line];
  const children = node.children
    .filter((child) => !advisory(child, here))
    .map((child) => canonicalLock(child, depth + 1, here))
    .sort();
  return (depth === 0 ? "" : `${"  ".repeat(depth - 1)}${node.line}\n`) + children.join("");
}

function lockPaths(node, prefix = [], out = new Map()) {
  for (const child of node.children) {
    if (advisory(child, prefix)) continue;
    const path = [...prefix, child.line];
    const key = path.join(" > ");
    out.set(key, (out.get(key) ?? 0) + 1);
    lockPaths(child, path, out);
  }
  return out;
}

// Names the first lines the lock is missing (-) and the first unreviewed ones (+).
function lockDifferences(expected, actual) {
  const before = lockPaths(expected);
  const after = lockPaths(actual);
  const only = (a, b, sign) =>
    [...a].filter(([path, count]) => (b.get(path) ?? 0) < count).map(([path]) => `${sign} ${path}`);
  const missing = only(before, after, "-");
  const added = only(after, before, "+");
  const clip = (line) => (line.length > 400 ? `${line.slice(0, 400)}...` : line);
  return [
    `${missing.length} expected line(s) missing, ${added.length} unreviewed line(s):`,
    ...missing.slice(0, 6).map(clip),
    ...added.slice(0, 6).map(clip),
  ];
}

// A block's map key, with YAML single quotes removed: 'a': and a: are one key.
const keyOf = (line) => {
  const key = /^('(?:[^']|'')*'|[^']+?)(?=:(?: |$))/.exec(line)?.[1] ?? line;
  return key.startsWith("'") ? key.slice(1, -1).replaceAll("''", "'") : key;
};
const REVIEWED_SECTIONS = new Set([
  "overrides:",
  "patchedDependencies:",
  "importers:",
  "packages:",
  "snapshots:",
]);
const CHANGE_FIELDS = {
  add: ["op", "parent", "lines", "commit", "pr", "reason", "package", "integrity", "patchFile"],
  replace: ["op", "parent", "before", "after", "commit", "pr", "reason", "patchFile"],
  remove: ["op", "parent", "lines", "commit", "pr", "reason", "package", "integrity"],
};
// A removal drops a block pnpm pruned after a version change. Patch entries and
// overrides leave through their own rules, never through a removal.
const REMOVABLE_SECTIONS = new Set(["importers:", "packages:", "snapshots:"]);
// `vite: npm:@scope/name@1.0.0` and `vite-plus: 1.0.0` both end in one exact version.
const EXACT_VERSION_TAIL = /(?<=^|[ @])\d+\.\d+\.\d+$/;

// Each reviewed change names the commit and pull request that wrote it. A
// change may add a block, rewrite one line in place (its children kept) or
// remove one block, named by its first line. It can never rewrite registry
// metadata or an integrity, and every registry record it adds or removes
// states its integrity.
function validateLockChange(change) {
  const label = Array.isArray(change?.parent) ? change.parent.at(-1) : change?.op;
  const where = `Reviewed lock change ${JSON.stringify(label)}`;
  assert.ok(Object.hasOwn(CHANGE_FIELDS, change?.op), `${where}: unknown op`);
  for (const key of Object.keys(change)) {
    assert.ok(CHANGE_FIELDS[change.op].includes(key), `${where}: unexpected field ${key}`);
  }
  assert.match(change.commit ?? "", /^[0-9a-f]{40}$/, `${where}: commit must be a full sha`);
  assert.ok(change.pr === null || (Number.isInteger(change.pr) && change.pr > 0), `${where}: pr`);
  assert.ok(
    typeof change.reason === "string" && change.reason.trim().length >= 20,
    `${where}: reason`,
  );
  const lineOk = (line) =>
    typeof line === "string" && line.trim() !== "" && line === line.trimEnd();
  assert.ok(
    Array.isArray(change.parent) &&
      change.parent.length > 0 &&
      change.parent.every((line) => lineOk(line) && line === line.trimStart()),
    `${where}: parent`,
  );
  const section = change.parent[0];
  assert.ok(REVIEWED_SECTIONS.has(section), `${where}: section ${section} is not reviewable`);
  const text = change.op === "replace" ? [change.before, change.after] : change.lines;
  assert.ok(Array.isArray(text) && text.length > 0 && text.every(lineOk), `${where}: lines`);
  if (change.op === "remove") {
    assert.ok(
      REMOVABLE_SECTIONS.has(section),
      `${where}: section ${section} is not reviewable for a removal`,
    );
  }
  // An override may cut one dependency edge (`parent>child: '-'`), or move the
  // exact version of an override the lock already has: same key, same target,
  // only the version at the end differs. Adding a pin, or pointing an override
  // at another package or range, is not reviewable here.
  if (section === "overrides:") {
    const key =
      change.op === "add" && change.lines.length === 1
        ? /^('[^']+'|[^\s':]+): '-'$/.exec(change.lines[0])?.[1]
        : undefined;
    const cut = key !== undefined && key.includes(">");
    const moved =
      change.op === "replace" &&
      text.every((line) => typeof line === "string" && EXACT_VERSION_TAIL.test(line)) &&
      change.before.replace(EXACT_VERSION_TAIL, "") ===
        change.after.replace(EXACT_VERSION_TAIL, "");
    assert.ok(
      change.parent.length === 1 && (cut || moved),
      `${where}: section overrides: is not reviewable except to add one dependency removal (parent>child: '-') or move one existing override to another exact version`,
    );
  }
  if (change.op === "replace") {
    assert.notEqual(section, "packages:", `${where}: registry metadata can only be added`);
    assert.ok(
      text.every((line) => line === line.trimStart()),
      `${where}: before/after`,
    );
    assert.notEqual(change.before, change.after, `${where}: redundant replacement`);
  } else {
    assert.equal(
      change.lines[0],
      change.lines[0].trimStart(),
      `${where}: block must start unindented`,
    );
  }
  const resolutions = text.filter((line) => /\b(?:resolution|integrity|tarball)\b/.test(line));
  if (change.op === "remove") {
    // A removal names the block by its first line; a registry record also
    // states the integrity it had, so the record shows which bytes left.
    assert.equal(
      change.lines.length,
      section === "packages:" ? 2 : 1,
      `${where}: a removal names one block`,
    );
  }
  if (change.op !== "replace" && section === "packages:") {
    assert.equal(
      change.parent.length,
      1,
      `${where}: registry records live directly under packages`,
    );
    assert.match(
      change.package ?? "",
      /^(?:@[\w.~-]+\/)?[\w.~-]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      `${where}: a registry record names an exact name@version`,
    );
    assert.match(change.integrity ?? "", /^sha512-[A-Za-z0-9+/]{86}==$/, `${where}: integrity`);
    assert.ok(
      [`'${change.package}':`, `${change.package}:`].includes(change.lines[0]),
      `${where}: package must name the record`,
    );
    assert.deepEqual(
      resolutions,
      [`  resolution: {integrity: ${change.integrity}}`],
      `${where}: a registry record needs exactly its stated integrity`,
    );
  } else {
    assert.ok(change.package === undefined && change.integrity === undefined, `${where}: package`);
    assert.deepEqual(resolutions, [], `${where}: resolution data belongs to a registry record`);
  }
  if (section === "patchedDependencies:") {
    const lines = change.op === "add" ? change.lines : [change.before, change.after];
    assert.ok(
      change.parent.length === 1 && lines.length === (change.op === "add" ? 1 : 2),
      `${where}: patch entry`,
    );
    for (const line of lines)
      assert.match(line, /^[^\s:]+: [0-9a-f]{64}$/, `${where}: patch entry`);
    if (change.op === "replace")
      assert.equal(
        keyOf(change.before),
        keyOf(change.after),
        `${where}: patch replacement must keep its package key`,
      );
    assert.match(change.patchFile ?? "", /^patches\/[^/\\]+\.patch$/, `${where}: patchFile`);
  } else {
    assert.equal(change.patchFile, undefined, `${where}: patchFile`);
  }
  return change;
}

export function validateReviewedLockChanges(record) {
  assert.equal(record.schemaVersion, 1, "Unsupported reviewed lock record version");
  assert.equal(record.upstreamCommit, LOCK_UPSTREAM, "Wrong reviewed lock baseline commit");
  assert.ok(Array.isArray(record.changes), "Reviewed lock record has no change list");
  record.changes.forEach(validateLockChange);
  return record;
}

export function loadReviewedLockChanges(root) {
  const bytes = readFileSync(join(root, LOCK_REVIEW_PATH));
  assert.equal(
    sha256(bytes),
    LOCK_REVIEW_SHA256,
    "Reviewed lock record differs from its pinned digest",
  );
  return validateReviewedLockChanges(JSON.parse(bytes.toString("utf8")));
}

// `removed` remembers the integrity of every registry record a reviewed removal
// dropped, so a later change cannot bring that name@version back with other bytes.
function applyReviewedLockChange(root, change, removed = new Map()) {
  validateLockChange(change);
  const missing = `Reviewed lock change no longer applies (${change.commit.slice(0, 9)})`;
  const childOf = (node, line) => {
    const found = node.children.filter((child) => child.line === line);
    assert.equal(found.length, 1, `${missing}: ${line}`);
    return found[0];
  };
  const parent = change.parent.reduce(childOf, root);
  const taken = (line) => parent.children.some((child) => keyOf(child.line) === keyOf(line));
  if (change.op === "replace") {
    const target = childOf(parent, change.before);
    target.line = "";
    assert.ok(!taken(change.after), `${missing}: ${change.after} already exists`);
    target.line = change.after;
    return;
  }
  const block = parseLockTree(change.lines.join("\n"), "reviewed change");
  assert.equal(block.children.length, 1, `${missing}: a change must be a single block`);
  if (change.op === "remove") {
    const target = childOf(parent, change.lines[0]);
    for (const stated of block.children[0].children)
      assert.equal(
        target.children.filter((child) => child.line === stated.line).length,
        1,
        `${missing}: ${change.lines[0]} does not have ${stated.line}`,
      );
    parent.children.splice(parent.children.indexOf(target), 1);
    if (change.integrity !== undefined) removed.set(change.package, change.integrity);
    return;
  }
  assert.ok(!taken(change.lines[0]), `${missing}: ${change.lines[0]} already exists`);
  assert.ok(
    change.integrity === undefined ||
      (removed.get(change.package) ?? change.integrity) === change.integrity,
    `${missing}: ${change.package} returns with another integrity than the one removed`,
  );
  parent.children.push(block.children[0]);
}

function applyReviewedLockChanges(root, changes) {
  const removed = new Map();
  for (const change of changes) applyReviewedLockChange(root, change, removed);
  return root;
}

// The canonical form of some top-level lock sections, after reviewed changes.
// Lets a check compare registry data with a fixed reviewed lock directly,
// without trusting the identity map.
// Only the changes inside those sections are applied: the others cannot alter
// the result, and an importer change may name a path this lock does not have.
export function canonicalLockSections(lockText, sections, reviewedChanges = []) {
  const tree = parseLockTree(lockText, "lock");
  applyReviewedLockChanges(
    tree,
    reviewedChanges.filter((change) => sections.includes(validateLockChange(change).parent[0])),
  );
  tree.children = tree.children.filter((node) => sections.includes(node.line));
  return canonicalLock(tree);
}

// A reviewed patch entry pins its patch file by the SHA-256 that pnpm records.
export function verifyReviewedPatches(root, changes) {
  let verified = 0;
  for (const change of changes) {
    if (change.patchFile === undefined) continue;
    const line = change.op === "replace" ? change.after : change.lines[0];
    const hash = line.slice(line.lastIndexOf(" ") + 1);
    assert.equal(
      sha256(readFileSync(join(root, change.patchFile))),
      hash,
      `Reviewed patch payload changed: ${change.patchFile}`,
    );
    verified += 1;
  }
  return verified;
}

// Inherited patches whose package upstream's lock no longer patched and whose
// fix Studio ported to the installed version. Each names its successor, which
// must be a reviewed patch, so the inherited file may be gone but never changed.
export const PORTED_INHERITED_PATCHES = new Map([
  ["patches/expo-modules-core@57.0.14.patch", "patches/expo-modules-core@58.0.11.patch"],
  ["patches/expo-notifications@57.0.15.patch", "patches/expo-notifications@58.0.11.patch"],
]);

// An inherited patch keeps upstream's bytes. The exceptions are closed: a
// reviewed lock change that replaces the patch's hash, whose new bytes
// verifyReviewedPatches has already checked against that hash, and a ported
// patch, which must be absent and succeeded by a reviewed patch.
// `upstreamPatches` maps each inherited patch path to upstream's text.
export function verifyInheritedPatches(
  root,
  upstreamPatches,
  changes,
  ported = PORTED_INHERITED_PATCHES,
) {
  const reviewed = new Map(
    changes.filter((change) => change.patchFile !== undefined).map((c) => [c.patchFile, c.op]),
  );
  const counts = { unchanged: 0, replaced: 0, ported: 0 };
  for (const [path, upstreamText] of upstreamPatches) {
    const successor = ported.get(path);
    if (successor !== undefined) {
      assert.ok(!existsSync(join(root, path)), `Ported inherited patch is still present: ${path}`);
      assert.ok(!upstreamPatches.has(successor), `Ported patch successor is inherited: ${path}`);
      assert.equal(
        reviewed.get(successor),
        "add",
        `Ported patch has no reviewed successor: ${path}`,
      );
      counts.ported += 1;
      continue;
    }
    assert.ok(existsSync(join(root, path)), `Inherited patch removed: ${path}`);
    if (reviewed.get(path) === "replace") {
      counts.replaced += 1;
      continue;
    }
    assert.equal(
      readFileSync(join(root, path), "utf8"),
      upstreamText,
      `Inherited patch payload changed: ${path}`,
    );
    counts.unchanged += 1;
  }
  return counts;
}

// The upstream lock after the identity map and the server SDK promotion, before
// any reviewed change: the tree every reviewed change is applied to.
export function preservedLockBaseline(originalLock) {
  let expectedLock = originalLock
    .replaceAll("@t3tools/", "@specweave-studio/")
    .replace("  oxlint-plugin-t3code:\n", "  oxlint-plugin-studio:\n")
    .replace("      effect-acp:", "      '@specweave-studio/effect-acp':")
    .replace(
      "      effect-codex-app-server:",
      "      '@specweave-studio/effect-codex-app-server':",
    );
  for (const name of ["markdown-text", "review-diff", "terminal"]) {
    expectedLock = expectedLock.replaceAll(`/modules/t3-${name}`, `/modules/studio-${name}`);
  }

  // Project MCP connections use the SDK upstream pinned for development at
  // runtime. Move only this exact importer record; its version, registry
  // packages, snapshots and every other line still have to equal the
  // identity-mapped upstream lock or a reviewed change.
  const sdk = SDK;
  const entry =
    "      '@modelcontextprotocol/sdk':\n        specifier: 1.29.0\n        version: 1.29.0(zod@4.6.5)\n";
  const matches = [...expectedLock.matchAll(/^  apps\/server:\n(?:(?: {4}[^\n]*)?\n)+/gm)];
  assert.equal(matches.length, 1, "Expected exactly one pinned server importer");
  const importer = matches[0][0];
  const runtimeHeader = "    dependencies:\n";
  const developmentHeader = "    devDependencies:\n";
  assert.equal(
    importer.split(runtimeHeader).length,
    2,
    "Expected one server runtime dependency section",
  );
  assert.equal(
    importer.split(developmentHeader).length,
    2,
    "Expected one server development dependency section",
  );
  assert.equal(
    importer.split(`      '${sdk}':\n`).length,
    2,
    "Expected one pinned server MCP SDK record",
  );
  assert.ok(
    importer.indexOf(entry) > importer.indexOf(developmentHeader),
    "Pinned SDK version/resolution or development placement changed",
  );
  const promoted = importer.replace(entry, "").replace(runtimeHeader, runtimeHeader + entry);
  return (
    expectedLock.slice(0, matches[0].index) +
    promoted +
    expectedLock.slice(matches[0].index + importer.length)
  );
}

// The lock the reviewed record describes: the baseline with every reviewed
// change applied in order.
// `baseline: false` reads a lock as it is, with no identity map or promotion.
export function reviewedLockTree(originalLock, reviewedChanges = [], { baseline = true } = {}) {
  return applyReviewedLockChanges(
    parseLockTree(baseline ? preservedLockBaseline(originalLock) : originalLock, "lock"),
    reviewedChanges,
  );
}

// The exact server SDK version the reviewed lock requests. It leaves upstream's
// pin only through reviewed changes to this one importer record.
function reviewedServerSdkVersion(expected) {
  const path = ["importers:", "apps/server:", "dependencies:", `'${SDK}':`];
  const record = path.reduce(
    (node, line) => node?.children.find((child) => child.line === line),
    expected,
  );
  const specifiers = (record?.children ?? []).filter((child) => keyOf(child.line) === "specifier");
  assert.equal(specifiers.length, 1, "Expected one pinned server MCP SDK record");
  const version = /^specifier: (\d+\.\d+\.\d+)$/.exec(specifiers[0].line)?.[1];
  assert.ok(version, "Server runtime SDK must be pinned to one exact version");
  return version;
}

// Drafts the reviewed changes that would turn the reviewed lock into the
// current one, for scripts/studio-toolchain/propose-lock-changes.mjs. A draft
// is not an approval: each entry still needs its commit, pull request and
// reason, and the record's digest above has to be updated by hand.
export function proposeLockChanges(expected, actual, parent = [], out = []) {
  const lines = (node, depth = 0) => [
    "  ".repeat(depth) + node.line,
    ...node.children.flatMap((child) => lines(child, depth + 1)),
  ];
  const registry = (node) => {
    if (parent.length !== 1 || parent[0] !== "packages:") return {};
    const integrity = /^resolution: \{integrity: (\S+)\}$/.exec(
      node.children.find((child) => keyOf(child.line) === "resolution")?.line ?? "",
    )?.[1];
    return { package: keyOf(node.line), integrity };
  };
  const kept = new Set(actual.children.map((child) => child.line));
  const had = new Set(expected.children.map((child) => child.line));
  const fresh = new Map(
    actual.children.filter((child) => !had.has(child.line)).map((c) => [keyOf(c.line), c]),
  );
  for (const node of expected.children) {
    if (kept.has(node.line)) {
      const twin = actual.children.find((child) => child.line === node.line);
      if (canonicalLock(node, 1, parent) !== canonicalLock(twin, 1, parent))
        proposeLockChanges(node, twin, [...parent, node.line], out);
      continue;
    }
    assert.ok(parent.length > 0, `Lock section ${node.line} changed outside the reviewed sections`);
    const twin = parent[0] === "packages:" ? undefined : fresh.get(keyOf(node.line));
    if (twin === undefined) {
      const record = registry(node);
      const stated = record.integrity ? [`  resolution: {integrity: ${record.integrity}}`] : [];
      out.push({ op: "remove", parent, lines: [node.line, ...stated], ...record });
      continue;
    }
    fresh.delete(keyOf(node.line));
    out.push({ op: "replace", parent, before: node.line, after: twin.line });
    proposeLockChanges(node, twin, [...parent, twin.line], out);
  }
  for (const node of fresh.values())
    out.push({ op: "add", parent, lines: lines(node), ...registry(node) });
  return out;
}

// Identity replacements must never alter registry hashes, encoded bytes or
// public keys. Lock changes beyond them are the closed, digest-pinned set in
// reviewed-lock-changes.json. The separate fixture-preservation audit permits
// only exact, independently reviewed fixture migrations pinned by byte hashes.
export function verifyPreservedLock(
  originalLock,
  currentLock,
  serverManifest,
  reviewedChanges = [],
) {
  const expected = reviewedLockTree(originalLock, reviewedChanges);
  assert.equal(
    serverManifest.dependencies?.[SDK],
    reviewedServerSdkVersion(expected),
    "Server runtime SDK must retain its pinned version",
  );
  assert.ok(
    !Object.hasOwn(serverManifest.devDependencies ?? {}, SDK),
    "Server SDK must not remain a development dependency",
  );
  const actual = parseLockTree(currentLock, "pnpm-lock.yaml");
  if (canonicalLock(actual) !== canonicalLock(expected)) {
    assert.fail([DIFFERS, ...lockDifferences(expected, actual)].join("\n"));
  }
}

export function auditPreservedPayloads(root, upstream) {
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const originalLock = git(["show", `${upstream}:pnpm-lock.yaml`]);
  const review = loadReviewedLockChanges(root);
  assert.equal(review.upstreamCommit, upstream, "Reviewed lock changes name another baseline");
  verifyPreservedLock(
    originalLock,
    readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
    JSON.parse(readFileSync(join(root, "apps/server/package.json"), "utf8")),
    review.changes,
  );
  const reviewedPatches = verifyReviewedPatches(root, review.changes);
  // Integrities of registry records that left the lock through a reviewed removal.
  const prunedIntegrities = new Set(
    review.changes
      .filter((change) => change.op === "remove" && change.integrity !== undefined)
      .map((change) => change.integrity),
  );

  const paths = git(["ls-tree", "-r", "--name-only", upstream]).trim().split("\n");
  const patchPaths = paths.filter((p) => p.startsWith("patches/"));
  const inheritedPatches = verifyInheritedPatches(
    root,
    new Map(patchPaths.map((p) => [p, git(["show", `${upstream}:${p}`])])),
    review.changes,
  );

  const renames = new Map();
  for (const line of git(["diff", "--name-status", "-M20%", upstream, "--"]).trim().split("\n")) {
    const [kind, before, after] = line.split("\t");
    if (kind?.startsWith("R")) renames.set(before, after);
  }
  const selected = paths.filter(
    (p) =>
      !p.startsWith(".repos/") &&
      /\.(?:tsx?|[cm]?js|svg|astro|json|ya?ml|toml|md|swift|kt|xml|plist|sh|py|txt|lock)$/.test(p),
  );
  const batch = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: selected.map((p) => `${upstream}:${p}\n`).join(""),
    maxBuffer: 128 * 1024 * 1024,
  });
  // These first-party installer illustrations were deliberately replaced with
  // owned vectors. Neither replacement may contain an encoded image.
  const ownedVectors = new Set([
    "apps/desktop/resources/dmg/dmg-background-latest.svg",
    "apps/desktop/resources/dmg/dmg-background-nightly.svg",
  ]);
  // Encoded payloads that left the tree together with the upstream artwork
  // around them. Each is named by file and exact bytes, so nothing else in
  // that file can be dropped under the same allowance.
  const removedWithUpstreamArtwork = new Map([
    // The 1x1 transparent GIF that stood in for the upstream desktop
    // screenshot on narrow screens; the screenshot and its markup are gone.
    [
      "apps/marketing/src/pages/index.astro",
      ["R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"],
    ],
  ]);
  // A provider's mark that upstream embedded as a PNG and Studio replaced with
  // that vendor's official vector (docs/studio/provider-logos.md). Named by
  // file and the SHA-256 of the exact payload; the file must still export the
  // mark and may hold no encoded image at all.
  const replacedProviderMarks = new Map([
    [
      "apps/web/src/components/Icons.tsx",
      {
        payloads: ["07537e571ee6fc0aa6277573edb7bbe7c32a4c59bab0677fea1ab7baf69b3719"],
        exportedAs: /\bAntigravityLogo as AntigravityIcon\b/,
      },
    ],
  ]);
  const patterns = [
    /(?<=base64,)[A-Za-z0-9+/=]{40,}/g,
    /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
    /sha(?:256|384|512)-[A-Za-z0-9+/=]{32,}/g,
    /(?<=["'])[A-Za-z0-9+/]{40,}={1,2}(?=["'])/g,
    /(?<=["'])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?=["'])/g,
  ];
  let offset = 0,
    payloads = 0,
    files = 0;
  for (const oldPath of selected) {
    const end = batch.indexOf(10, offset);
    const header = batch.subarray(offset, end).toString("utf8");
    const match = / blob (\d+)$/.exec(header);
    assert.ok(match, `Cannot inspect pinned source object: ${oldPath}`);
    const size = Number(match[1]);
    const content = batch.subarray(end + 1, end + 1 + size);
    offset = end + 1 + size + 1;
    if (content.includes(0)) continue;
    const before = content.toString("utf8");
    const payloadSet = new Set(
      patterns.flatMap((pattern) => [...before.matchAll(pattern)].map((m) => m[0])),
    );
    if (payloadSet.size === 0) continue;
    const currentPath = renames.get(oldPath) ?? oldPath;
    assert.ok(existsSync(join(root, currentPath)), `Encoded payload source missing: ${oldPath}`);
    const current = readFileSync(join(root, currentPath), "utf8");
    if (ownedVectors.has(currentPath)) {
      assert.doesNotMatch(current, /base64,|M33\.4509/);
      // The current mark of assets/brand/specwithcode-mark.svg.
      const mark = /<path[^>]*\sd="([^"]+)"/.exec(
        readFileSync(join(root, "assets/brand/specwithcode-mark.svg"), "utf8"),
      )?.[1];
      assert.ok(mark && current.includes(mark), `Owned vector lost the brand mark: ${currentPath}`);
      continue;
    }
    const removed = removedWithUpstreamArtwork.get(currentPath) ?? [];
    const replaced = replacedProviderMarks.get(currentPath);
    if (replaced) {
      assert.doesNotMatch(current, /base64,/, `Replaced provider mark is encoded: ${currentPath}`);
      assert.match(current, replaced.exportedAs, `Replaced provider mark is gone: ${currentPath}`);
    }
    let preserved = 0;
    for (const payload of payloadSet) {
      if (!current.includes(payload) && removed.includes(payload)) continue;
      if (!current.includes(payload) && replaced?.payloads.includes(sha256(payload))) continue;
      if (
        !current.includes(payload) &&
        currentPath === "pnpm-lock.yaml" &&
        prunedIntegrities.has(payload)
      )
        continue;
      assert.ok(current.includes(payload), `Pinned encoded payload changed: ${currentPath}`);
      preserved += 1;
    }
    if (preserved === 0) continue;
    payloads += preserved;
    files += 1;
  }
  return {
    registryIntegrityRecords: (originalLock.match(/integrity:/g) ?? []).length,
    reviewedLockChanges: review.changes.length,
    reviewedRegistryRecords: review.changes.filter(
      (change) => change.op === "add" && change.integrity,
    ).length,
    reviewedRegistryRemovals: prunedIntegrities.size,
    reviewedPatches,
    reviewedLockSha256: LOCK_REVIEW_SHA256,
    inheritedPatches: patchPaths.length,
    inheritedPatchesUnchanged: inheritedPatches.unchanged,
    inheritedPatchesReplacedByReview: inheritedPatches.replaced,
    inheritedPatchesPorted: inheritedPatches.ported,
    encodedPayloads: payloads,
    encodedPayloadFiles: files,
  };
}
