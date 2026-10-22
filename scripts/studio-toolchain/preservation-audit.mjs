import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_UPSTREAM = "10f39eb9ac80c9a4b7f5097575dd2addc3b6f631";
// A record edit is not an approval. This digest pins the reviewed closed set of
// lock changes, so approving another one also takes a reviewed edit here.
export const LOCK_REVIEW_SHA256 =
  "eaa80b5f4b2de998a88c5e214094198fd80306bfcca9102c8baf943d7792cde3";
const LOCK_REVIEW_PATH = "scripts/studio-toolchain/reviewed-lock-changes.json";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const LAYOUT = "Pinned lock data must keep pnpm's two-space block layout";
const DIFFERS =
  "Pinned lock data may change only through the identity map, the exact server MCP SDK runtime promotion and reviewed-lock-changes.json";

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
function canonicalLock(node, depth = 0) {
  const children = node.children.map((child) => canonicalLock(child, depth + 1)).sort();
  return (depth === 0 ? "" : `${"  ".repeat(depth - 1)}${node.line}\n`) + children.join("");
}

function lockPaths(node, prefix = [], out = new Map()) {
  for (const child of node.children) {
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
  replace: ["op", "parent", "before", "after", "commit", "pr", "reason"],
};

// Each reviewed change names the commit and pull request that wrote it. A
// change may add a block or rewrite one line in place (its children kept); it
// can never rewrite registry metadata or an integrity, and every registry
// record it adds states its integrity.
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
  const text = change.op === "add" ? change.lines : [change.before, change.after];
  assert.ok(Array.isArray(text) && text.length > 0 && text.every(lineOk), `${where}: lines`);
  // An override may only cut one dependency edge (`parent>child: '-'`); pinning
  // or replacing a version through an override is not reviewable here.
  if (section === "overrides:") {
    const key =
      change.op === "add" && change.lines.length === 1
        ? /^('[^']+'|[^\s':]+): '-'$/.exec(change.lines[0])?.[1]
        : undefined;
    assert.ok(
      change.parent.length === 1 && key !== undefined && key.includes(">"),
      `${where}: section overrides: is not reviewable except to add one dependency removal (parent>child: '-')`,
    );
  }
  if (change.op === "replace") {
    assert.notEqual(section, "packages:", `${where}: registry metadata can only be added`);
    // A patch hash is pinned by its patch file, which only an added entry names.
    assert.notEqual(section, "patchedDependencies:", `${where}: patch entries can only be added`);
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
  if (change.op === "add" && section === "packages:") {
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
  if (change.op === "add" && section === "patchedDependencies:") {
    assert.ok(change.parent.length === 1 && change.lines.length === 1, `${where}: patch entry`);
    assert.match(change.lines[0], /^[^\s:]+: [0-9a-f]{64}$/, `${where}: patch entry`);
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

function applyReviewedLockChange(root, change) {
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
  assert.equal(block.children.length, 1, `${missing}: an addition must be a single block`);
  assert.ok(!taken(change.lines[0]), `${missing}: ${change.lines[0]} already exists`);
  parent.children.push(block.children[0]);
}

// The canonical form of some top-level lock sections, after reviewed changes.
// Lets a check compare registry data with a fixed reviewed lock directly,
// without trusting the identity map.
export function canonicalLockSections(lockText, sections, reviewedChanges = []) {
  const tree = parseLockTree(lockText, "lock");
  for (const change of reviewedChanges) applyReviewedLockChange(tree, change);
  tree.children = tree.children.filter((node) => sections.includes(node.line));
  return canonicalLock(tree);
}

// A reviewed patch entry pins its patch file by the SHA-256 that pnpm records.
export function verifyReviewedPatches(root, changes) {
  let verified = 0;
  for (const change of changes) {
    if (change.patchFile === undefined) continue;
    const hash = change.lines[0].slice(change.lines[0].lastIndexOf(" ") + 1);
    assert.equal(
      sha256(readFileSync(join(root, change.patchFile))),
      hash,
      `Reviewed patch payload changed: ${change.patchFile}`,
    );
    verified += 1;
  }
  return verified;
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

  // Project MCP connections use the already pinned SDK at runtime. Move only
  // this exact importer record; registry packages, snapshots and every other
  // line still have to equal the identity-mapped upstream lock or a reviewed change.
  const sdk = "@modelcontextprotocol/sdk";
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
  expectedLock =
    expectedLock.slice(0, matches[0].index) +
    promoted +
    expectedLock.slice(matches[0].index + importer.length);
  assert.equal(
    serverManifest.dependencies?.[sdk],
    "1.29.0",
    "Server runtime SDK must retain its pinned version",
  );
  assert.ok(
    !Object.hasOwn(serverManifest.devDependencies ?? {}, sdk),
    "Server SDK must not remain a development dependency",
  );
  const expected = parseLockTree(expectedLock, "baseline");
  for (const change of reviewedChanges) applyReviewedLockChange(expected, change);
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

  const paths = git(["ls-tree", "-r", "--name-only", upstream]).trim().split("\n");
  const patchPaths = paths.filter((p) => p.startsWith("patches/"));
  for (const p of patchPaths) {
    assert.equal(
      readFileSync(join(root, p), "utf8"),
      git(["show", `${upstream}:${p}`]),
      `Inherited patch payload changed: ${p}`,
    );
  }

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
      // The page-and-prompt mark of assets/brand/specwithcode-mark.svg (b130c0d2b).
      assert.match(current, /M29 10H60L78 28/);
      continue;
    }
    const removed = removedWithUpstreamArtwork.get(currentPath) ?? [];
    let preserved = 0;
    for (const payload of payloadSet) {
      if (!current.includes(payload) && removed.includes(payload)) continue;
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
    reviewedRegistryRecords: review.changes.filter((change) => change.integrity).length,
    reviewedPatches,
    reviewedLockSha256: LOCK_REVIEW_SHA256,
    inheritedPatches: patchPaths.length,
    encodedPayloads: payloads,
    encodedPayloadFiles: files,
  };
}
