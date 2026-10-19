import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  STUDIO_NAME,
  STUDIO_CLI,
  STUDIO_DEFAULT_PORT,
  studioDefaultHome,
} from "../packages/shared/src/studioIdentity.ts";
import {
  buildRuntimeInstructions,
  HEADLESS_BROWSER_ENVIRONMENT,
  withHeadlessBrowserEnvironment,
} from "../apps/server/src/provider/RuntimeInstructions.ts";
import {
  HEADLESS_ENVIRONMENT_HELPERS,
  PROVIDER_ADAPTER_PROCESS_CHAINS,
  PROVIDER_PROCESS_SPAWN_SITES,
} from "../apps/server/src/provider/providerSpawnSites.ts";
import { sourceVersion } from "./studio-projects/version.mjs";
import { auditPreservedPayloads } from "./studio-toolchain/preservation-audit.mjs";
import {
  auditPreservedFixtures,
  isProtectedPath,
} from "./studio-toolchain/fixture-preservation-audit.mjs";

const assert = NodeAssert;
const { execFileSync } = NodeChildProcess;
const { createHash } = NodeCrypto;
const { existsSync, lstatSync, readFileSync, readdirSync } = NodeFS;
const { dirname, join, resolve } = NodePath;
const { fileURLToPath } = NodeURL;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedVersion = sourceVersion(root);
const upstream = "10f39eb9ac80c9a4b7f5097575dd2addc3b6f631";
const read = (p) => readFileSync(join(root, p), "utf8");
const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// CI fetches the pinned upstream commit by asking this script which one it is.
if (process.argv.includes("--print-upstream-pin")) {
  console.log(upstream);
  process.exit(0);
}

// The preservation and artwork checks compare this checkout with the pinned
// upstream commit and with the inherited reference trees. A shallow clone has
// no upstream commit and a sparse checkout that drops /.repos/ has no reference
// trees, so name what is missing rather than fail from inside a check.
const missingInputs = [];
try {
  execFileSync("git", ["cat-file", "-e", `${upstream}^{tree}`], { cwd: root, stdio: "ignore" });
} catch {
  missingInputs.push(
    `upstream commit ${upstream} is not in this clone; run: git fetch --no-tags --depth=1 origin ${upstream}`,
  );
}
if (!existsSync(join(root, ".repos"))) {
  missingInputs.push(
    "the reference trees under .repos are not checked out; use a checkout without the /.repos/ sparse exclusion",
  );
}
if (missingInputs.length > 0) {
  console.error(
    ["studio-brand-audit cannot run in this checkout:", ...missingInputs.map((m) => `- ${m}`)].join(
      "\n",
    ),
  );
  process.exit(2);
}

const checks = [];
const failures = [];
let preservation;
let fixturePreservation;
// Every check runs even after an earlier one fails, so one run lists all of them.
function check(name, fn) {
  try {
    fn();
    checks.push(name);
  } catch (error) {
    failures.push({ check: name, message: error instanceof Error ? error.message : String(error) });
  }
}
check("independent runtime values", () => {
  // Display name is SpecWithCode; the runtime identities below keep their
  // pre-rename values so installed services, homes and update feeds keep working.
  assert.equal(STUDIO_NAME, "SpecWithCode");
  assert.equal(STUDIO_CLI, "specweave-studio");
  assert.equal(STUDIO_DEFAULT_PORT, 8319);
  assert.equal(studioDefaultHome("/tmp/studio-user"), "/tmp/studio-user/.specwithcode");
  const prior = process.env.T3CODE_HOME;
  process.env.T3CODE_HOME = "/tmp/upstream-store";
  try {
    assert.equal(studioDefaultHome("/tmp/studio-user"), "/tmp/studio-user/.specwithcode");
  } finally {
    if (prior === undefined) delete process.env.T3CODE_HOME;
    else process.env.T3CODE_HOME = prior;
  }
});
check("CLI package and alpha version", () => {
  const p = JSON.parse(read("apps/server/package.json"));
  assert.equal(p.name, STUDIO_CLI);
  assert.equal(p.version, expectedVersion);
  // `specwithcode` is a display-name alias for the same entry; the CLI keeps its name.
  assert.deepEqual(p.bin, { [STUDIO_CLI]: "./dist/bin.mjs", specwithcode: "./dist/bin.mjs" });
  assert.match(read("apps/server/src/config.ts"), /DEFAULT_PORT = STUDIO_DEFAULT_PORT/);
  assert.match(read("apps/server/src/os-jank.ts"), /studioDefaultHome\(NodeOS.homedir\(\)\)/);
});
check("upstream MIT provenance retained exactly", () => {
  assert.equal(
    read("LICENSE"),
    execFileSync("git", ["show", upstream + ":LICENSE"], { cwd: root, encoding: "utf8" }),
  );
  assert.match(read("UPSTREAM.md"), /T3 Tools Inc/);
  assert.match(read("UPSTREAM.md"), new RegExp(upstream));
  assert.match(read("scripts/lib/third-party-licenses.ts"), /\["@specweave-studio\/"\]/);
});
check(
  "reference trees and unlisted fixtures preserved; reviewed fixture migrations hash-verified",
  () => {
    fixturePreservation = auditPreservedFixtures(root, upstream);
  },
);
check("hosted services and telemetry opt in only", () => {
  assert.match(
    read("apps/server/src/cloud/publicConfig.ts"),
    /process.env.STUDIO_ENABLE_HOSTED_SERVICES === "true" && Boolean/,
  );
  assert.match(
    read("apps/web/src/cloud/publicConfig.ts"),
    /VITE_STUDIO_ENABLE_HOSTED_SERVICES === "true"/,
  );
  assert.match(
    read("apps/server/src/telemetry/AnalyticsService.ts"),
    /STUDIO_TELEMETRY_ENABLED"\).pipe\(Config.withDefault\(false\)\)/,
  );
  assert.doesNotMatch(
    read("apps/server/src/telemetry/AnalyticsService.ts"),
    /phc_[A-Za-z0-9]+|us.i.posthog.com/,
  );
  assert.match(read("packages/shared/src/connectAuth.ts"), /DEFAULT_HOSTED_APP_URL = ""/);
});
check("legal pages name the owner and state the telemetry default truthfully", () => {
  const pages = [
    "apps/marketing/src/components/LegalPage.astro",
    "apps/marketing/src/pages/legal.astro",
    "apps/marketing/src/pages/privacy-policy.astro",
    "apps/marketing/src/pages/terms-of-service.astro",
    "apps/marketing/src/pages/security-policy.astro",
  ];
  for (const p of pages) {
    const text = read(p);
    assert.doesNotMatch(text, /Studio Tools|Market Street|San Francisco, CA|@studio\.invalid/i, p);
    assert.doesNotMatch(text, /mobile(?:,| and) (?:and )?hosted|desktop and mobile/i, p);
  }
  const privacy = read("apps/marketing/src/pages/privacy-policy.astro");
  assert.match(privacy, /Product usage data is off by default/);
  assert.doesNotMatch(privacy, /By default, (?:SpecWeave Studio|SpecWithCode) sends/);
});
check("security policy reaches a real inbox", () => {
  // A reserved .invalid address or link delivers nothing, so a report sent there is lost.
  const policy = read(".github/SECURITY.md");
  assert.doesNotMatch(
    policy,
    /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.invalid\b/i,
    ".github/SECURITY.md address",
  );
  assert.doesNotMatch(policy, /https?:\/\/[^\s)>\]]*\.invalid\b/i, ".github/SECURITY.md link");
  assert.match(policy, /mailto:[^\s)]+@[^\s)]+/, ".github/SECURITY.md names a contact address");
});
check("self update only from an owned feed and original update endpoints absent", () => {
  assert.match(
    read("apps/desktop/src/updates/DesktopUpdates.ts"),
    /UPSTREAM_UPDATE_FEED_PATTERN = \/pingdotgg\|t3code\|t3tools\|t3\\.codes\/i/,
  );
  assert.match(read("apps/desktop/src/updates/DesktopUpdates.ts"), /if \(args.feedIsUpstream\)/);
  assert.match(read("apps/server/src/cli/update.ts"), /STUDIO_ENABLE_SELF_UPDATE !== "true"/);
  assert.doesNotMatch(read("packages/shared/src/cliRelease.ts"), /pingdotgg|t3code|t3.codes/);
});
check("owned runtime has no original brand, env or origin", () => {
  const findings = [];
  function scan(dir) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const p = dir + "/" + entry.name;
      if (["fixtures", "__fixtures__", "replays"].includes(entry.name)) continue;
      if (entry.isDirectory()) scan(p);
      else if (/\.(tsx?|m?js|html|json)$/.test(p) && !/\.(?:test|fixture)\./.test(p)) {
        const s = read(p);
        if (
          /\bT3 Code\b|\bT3CODE_|@t3tools\/|https?:\/\/[^\s"'`]*(?:t3\.codes|t3tools\.com)/.test(s)
        )
          findings.push(p);
      }
    }
  }
  for (const d of [
    "apps/server/src",
    "apps/web/src",
    "packages/contracts/src",
    "packages/client-runtime/src",
    "packages/shared/src",
  ])
    scan(d);
  assert.deepEqual(findings, []);
});
check("real first-party mark replaced", () => {
  // The page-and-prompt brand mark from assets/brand/specwithcode-mark.svg starts with this path.
  assert.match(read("assets/prod/logo.svg"), /M29 10H60L78 28/);
  assert.match(read("apps/web/src/components/StudioWordmark.tsx"), /M29 10H60L78 28/);
  assert.doesNotMatch(read("apps/web/src/components/StudioWordmark.tsx"), /M33.4509/);
  assert.match(read("apps/web/index.html"), /SpecWithCode/);
  for (const p of [
    "apps/desktop/resources/dmg/dmg-background-latest.svg",
    "apps/desktop/resources/dmg/dmg-background-nightly.svg",
  ]) {
    assert.match(read(p), /M29 10H60L78 28/);
    assert.doesNotMatch(read(p), /M33\.4509|base64,|M16 22H40/);
  }
});
// Upstream leftovers anywhere in the tree. The checks above pin known files;
// the ones below read every tracked or newly added file outside the reference
// trees, so a leftover is found wherever it lands. The legal pages are pinned
// by their own check above.

// Upstream's product, vendor, domain and maintainer names in any spelling.
const UPSTREAM_NAME =
  /pingdotgg|t3dotgg|t3\.gg|t3[._-]?(?:code|chat|tools)|(?<![a-z0-9])t3\s(?:code|chat|tools)/i;
// Opening coordinates of the upstream wordmark outline.
const UPSTREAM_WORDMARK = "M33.4509";
// Upstream's Discord invite, App Store id, TestFlight invite and Apple team id,
// matched by SHA-256 so that this file does not carry them either.
const UPSTREAM_ACCOUNT_DIGESTS = new Map([
  ["ba69b375839d8c76aec1d0b71cb644ae8e00c8d9db09073d40c66026c521987e", "upstream Discord invite"],
  ["16cf8d421fd89aad07715a3cae05cdc9b4a75564438f90d7c61e7992888b59f2", "upstream App Store id"],
  [
    "d2cec6962c00529c20ce8c6a3bb17b35011cbd329c334bf4d6a5dc146d45a128",
    "upstream TestFlight invite",
  ],
  ["73908e07002aab117f3fc1466fb347cdeee6d3b961496768e12bfc0c2658917c", "upstream Apple team id"],
]);
// Every token shaped like one of those identifiers is hashed and compared.
const ACCOUNT_CANDIDATES = [
  /discord(?:app)?\.(?:gg|com\/invite)\/([A-Za-z0-9-]+)/g,
  /testflight\.apple\.com\/join\/([A-Za-z0-9]+)/g,
  /(?<![0-9])([0-9]{10})(?![0-9])/g,
  /(?<![A-Za-z0-9])([A-Z0-9]{10})(?![A-Za-z0-9])/g,
];
// A Clerk publishable key is "pk_<env>_" followed by its base64 frontend host.
const PUBLISHABLE_KEY = /pk_(?:live|test)_([A-Za-z0-9+/_-]+)/g;

// The preservation audit files that name upstream, each with the reason it has
// to. Every other file under scripts/studio-toolchain/ is read like any file
// Studio owns, and a file listed here that names upstream no longer is reported.
const UPSTREAM_NAMING_TOOLCHAIN_FILES = new Set([
  // Rewrites upstream's package scope and lint plugin name in upstream's
  // lockfile, to get the lockfile this checkout has to match line for line,
  // apart from the changes listed in reviewed-lock-changes.json.
  "scripts/studio-toolchain/preservation-audit.mjs",
  // Its sample recording is captured under upstream's client name, which the
  // reviewed migration under test replaces.
  "scripts/studio-toolchain/fixture-preservation-audit.test.mjs",
  // The reviewed migration manifest states the import rename it permits, from
  // upstream's package scope to Studio's.
  "scripts/studio-toolchain/reviewed-fixture-migrations.json",
]);

// Files in which upstream names are meant to stay. A hit anywhere else is a
// leftover to remove; these lists are not the place to make the audit pass.
// `inUpstreamTree` tells whether a path exists in the pinned upstream tree.
function isUpstreamReferenceFile(p, inUpstreamTree) {
  return (
    // MIT provenance: the retained upstream notice and the record of the fork point.
    p === "LICENSE" ||
    p === "UPSTREAM.md" ||
    // This audit and the preservation audits name upstream to detect and map it.
    p === "scripts/studio-brand-audit.mjs" ||
    UPSTREAM_NAMING_TOOLCHAIN_FILES.has(p) ||
    // Recorded fixtures and replays, which hold every *.ndjson recording. Their
    // bytes are pinned to upstream, or to a hash-reviewed migration, by the
    // fixture preservation check above, so they cannot gain a new reference.
    isProtectedPath(p) ||
    // Inherited dependency patches, compared byte for byte with upstream by the
    // payload preservation check below. A patch that upstream does not have is
    // Studio's own and is read like any other file.
    (p.startsWith("patches/") && inUpstreamTree(p))
  );
}

// A third party's Ghostty branch is named after upstream, and the licence
// notice has to cite the source the vendored framework was built from.
const GHOSTTY_SOURCE_BRANCH =
  /github\.com\/Yash-Singh1\/ghostty\/tree\/t3code\/custom-io-ordered-feed/g;
// The one upstream package name that a retained evidence log quotes verbatim.
const QUOTED_CONTRACTS_IMPORT = /@t3tools\/contracts/g;

// Single deliberate references inside files Studio otherwise owns. Only the
// quoted fragment is tolerated, so a second reference in the same file fails.
const UPSTREAM_REFERENCE_FRAGMENTS = [
  // The self-update guard has to name upstream's feeds in order to refuse them.
  [
    "apps/desktop/src/updates/DesktopUpdates.ts",
    /UPSTREAM_UPDATE_FEED_PATTERN = \/pingdotgg\|t3code\|t3tools\|t3\\\.codes\/i/g,
  ],
  ["third-party-licenses.config.json", GHOSTTY_SOURCE_BRANCH],
  ["scripts/lib/third-party-licenses.test.ts", GHOSTTY_SOURCE_BRANCH],
  // Retained verification evidence: a past module-resolution error, verbatim.
  ["reports/t26-resolution-lifecycle/README.md", QUOTED_CONTRACTS_IMPORT],
  ["reports/t26-resolution-lifecycle/guards-replay.txt", QUOTED_CONTRACTS_IMPORT],
];

// Files kept only in the private repository. A public snapshot omits them, so
// their allowances apply only where the file is present.
const PRIVATE_ONLY_REFERENCE_FILES = new Set([
  "docs/studio/getting-started.md",
  "reports/t26-resolution-lifecycle/README.md",
  "reports/t26-resolution-lifecycle/guards-replay.txt",
]);

const TEST_DIRECTORIES = new Set([
  "test",
  "tests",
  "__tests__",
  "integration",
  "testkit",
  "testUtils",
]);
const isTestFile = (p) =>
  isProtectedPath(p) ||
  /\.(?:test|spec)\.(?:[cm]?[jt]sx?|py)$/.test(p) ||
  p.split("/").some((part) => TEST_DIRECTORIES.has(part));

const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|ico|icns|svg|bmp|tiff?|heic)$/i;
const ANDROID_DRAWABLE = /\/res\/(?:drawable|mipmap)[^/]*\/[^/]+\.xml$/;
const BRAND_WORDS = new Set([
  "icon",
  "icons",
  "favicon",
  "logo",
  "mark",
  "wordmark",
  "splash",
  "social",
]);
// Marks that belong to the harness vendors they depict, not to upstream.
const THIRD_PARTY_MARKS = [
  "apps/marketing/public/harnesses/",
  "apps/marketing/public/95/providers/",
];
const UPSTREAM_CONCEPT_ART = "apps/marketing/public/95/t3-code-concepts/";
// Upstream artwork kept unchanged because it shows nothing of upstream's
// identity: no mark, no letters and no line that follows a glyph. Each entry is
// one path, the Git blob that was looked at and what it depicts, so a different
// file at that path, or the same path after a change upstream, is not covered.
const GENERIC_UPSTREAM_ARTWORK = new Map([
  [
    "assets/dev/app-icon.icon/Assets/background.svg",
    {
      blob: "db5c319d607d7db3bce38a47137d072b26f36a9e",
      depicts: "blueprint paper: a blue gradient, a square grid, a frame line and corner hatching",
    },
  ],
  [
    "assets/nightly/app-icon.icon/Assets/cloud-lower-left.svg",
    {
      blob: "d43478860f4693ac39cd190c05007a9bb42437a5",
      depicts: "one soft blue-to-violet cloud",
    },
  ],
  [
    "assets/nightly/app-icon.icon/Assets/cloud-upper-right.svg",
    {
      blob: "7b094441db156af8b0cbd82006a2fe5bb8295553",
      depicts: "the same cloud, mirrored",
    },
  ],
  [
    "apps/marketing/public/nightly-sky.svg",
    {
      blob: "3165b211b2874c150a6d5b9135a5f265f5e01e62",
      depicts: "a wide navy-to-violet night sky strip with a few stars and two blurred clouds",
    },
  ],
]);
// Files that show that artwork in bytes that are not upstream's: a layer whose
// comments were reworded, the Android backgrounds and splash icons that
// scripts/export-android-icons.ts renders from the kept layers. The byte comparison cannot tell them from Studio's own work,
// so they are listed here to keep the report of kept upstream artwork complete.
// An entry excuses nothing: the artwork checks read these files like any other,
// and a file that is no longer the blob that was looked at fails until it is
// looked at again and its entry updated or removed.
const DERIVED_UPSTREAM_ARTWORK = new Map([
  [
    "assets/nightly/app-icon.icon/Assets/background.svg",
    {
      blob: "63461ad445e81820e37f5a83251fc9963965c3c4",
      depicts:
        "night sky: a navy-to-violet gradient, two soft glows, five dot stars, two cross stars and two horizon bands",
      differs: "two comments reworded; it draws what upstream's layer at this path draws",
    },
  ],
  [
    "apps/mobile/assets/android-icon-background-nightly.png",
    {
      blob: "3d43de62595e7d14fe79b4cb0565d6e96acdbfac",
      depicts: "that night sky, full bleed, under the two clouds",
      differs: "this checkout's render of the three nightly layers",
    },
  ],
  [
    "apps/mobile/assets/android-icon-background-dev.png",
    {
      blob: "fcd247c872eb47e72b2fbbd39a5c97dd0cd309c0",
      depicts: "the blueprint paper, full bleed",
      differs: "this checkout's render of the development background layer",
    },
  ],
  [
    "apps/mobile/assets/android-splash-icon-nightly.png",
    {
      blob: "a0f110a43e18ee7531c0cbf27ed4250cec5e431c",
      depicts: "the page-and-prompt brand mark over that night sky and the two clouds",
      differs: "Studio's mark composed over a render of the three nightly layers",
    },
  ],
  [
    "apps/mobile/assets/android-splash-icon-dev.png",
    {
      blob: "885370117d12ff79531ee5ab240fa8f81276d78f",
      depicts: "the page-and-prompt brand mark over the blueprint paper",
      differs: "Studio's mark composed over a render of the development background layer",
    },
  ],
]);

// App icons, splash and notification icons, favicons, the social card and the
// marketing artwork: images that present the product and so must be Studio's own.
function isBrandBearingImage(p) {
  if (!IMAGE_FILE.test(p) && !ANDROID_DRAWABLE.test(p)) return false;
  if (!p.startsWith("apps/") && !p.startsWith("assets/")) return false;
  if (THIRD_PARTY_MARKS.some((directory) => p.startsWith(directory))) return false;
  if (p.startsWith("assets/") || p.startsWith("apps/marketing/src/assets/")) return true;
  if (/\.(?:icon|iconset|appiconset|imageset)\//.test(p)) return true;
  const name = p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  const words = name.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) ?? [];
  return words.some((word) => BRAND_WORDS.has(word.toLowerCase()));
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const gitBlobId = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

function findUpstreamLeftovers() {
  const found = { names: [], accounts: [], keys: [], wordmark: [], artwork: [] };

  const allowances = UPSTREAM_REFERENCE_FRAGMENTS.filter(
    ([path]) => !PRIVATE_ONLY_REFERENCE_FILES.has(path) || existsSync(join(root, path)),
  ).map(([path, fragment]) => ({
    path,
    fragment,
    used: false,
  }));

  const genericArtworkSeen = new Set();
  const derivedArtworkSeen = new Set();
  const toolchainFilesNamingUpstream = new Set();

  const accountLabels = new Map();
  const accountLabel = (token) => {
    if (!accountLabels.has(token)) {
      accountLabels.set(token, UPSTREAM_ACCOUNT_DIGESTS.get(sha256(token)) ?? null);
    }
    return accountLabels.get(token);
  };

  // One listing of the upstream tree. The current side is hashed from the
  // working files instead of a second listing, so a replacement counts before
  // it is committed and an added file counts before it is tracked.
  const upstreamBlobAt = new Map();
  const upstreamPathByBlob = new Map();
  const conceptArt = new Set();
  for (const row of git(["ls-tree", "-r", "-z", upstream]).split("\0")) {
    const tab = row.indexOf("\t");
    if (tab < 0) continue;
    const [, type, object] = row.slice(0, tab).split(" ");
    const p = row.slice(tab + 1);
    if (type !== "blob" || p.startsWith(".repos/")) continue;
    upstreamBlobAt.set(p, object);
    if (!upstreamPathByBlob.has(object)) upstreamPathByBlob.set(object, p);
    if (p.startsWith(UPSTREAM_CONCEPT_ART)) conceptArt.add(object);
  }
  assert.ok(conceptArt.size > 0, "Upstream concept art is missing from the pinned tree");

  const listed = git([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ".",
    ":(exclude).repos",
  ]);
  for (const p of listed.split("\0")) {
    if (!p) continue;
    let stat;
    try {
      stat = lstatSync(join(root, p));
    } catch {
      continue; // Removed from the working tree, not yet from the index.
    }
    if (!stat.isFile()) continue;
    const reference = isUpstreamReferenceFile(p, (path) => upstreamBlobAt.has(path));
    if (!reference && UPSTREAM_NAME.test(p)) found.names.push(`${p}: path name`);
    const bytes = readFileSync(join(root, p));

    if (IMAGE_FILE.test(p) || ANDROID_DRAWABLE.test(p)) {
      const object = gitBlobId(bytes);
      if (conceptArt.has(object)) {
        found.artwork.push(`${p}: upstream concept art, ${upstreamPathByBlob.get(object)}`);
      } else if (
        GENERIC_UPSTREAM_ARTWORK.get(p)?.blob === object &&
        upstreamBlobAt.get(p) === object
      ) {
        genericArtworkSeen.add(p);
      } else if (isBrandBearingImage(p) && upstreamPathByBlob.has(object)) {
        const origin =
          upstreamBlobAt.get(p) === object ? "the same path" : upstreamPathByBlob.get(object);
        found.artwork.push(`${p}: byte-identical to upstream at ${origin}`);
      }
      const derived = DERIVED_UPSTREAM_ARTWORK.get(p);
      if (derived) {
        derivedArtworkSeen.add(p);
        if (derived.blob !== object) {
          found.artwork.push(
            `${p}: no longer the derived upstream artwork that was looked at; look at it again and update or remove its entry`,
          );
        }
      }
    }

    if (bytes.subarray(0, 8000).includes(0)) continue;
    const text = bytes.toString("utf8");

    // Keys are checked in every file: no allowance can excuse an upstream host.
    for (const match of text.matchAll(PUBLISHABLE_KEY)) {
      const host = Buffer.from(match[1], "base64").toString("latin1");
      if (/^[\x20-\x7e]+$/.test(host) && /t3/i.test(host)) {
        found.keys.push(`${p}:${lineOf(text, match.index)}: key issued for an upstream host`);
      } else if (!isTestFile(p)) {
        found.keys.push(`${p}:${lineOf(text, match.index)}: publishable key outside a test`);
      }
    }
    if (UPSTREAM_NAMING_TOOLCHAIN_FILES.has(p) && UPSTREAM_NAME.test(text)) {
      toolchainFilesNamingUpstream.add(p);
    }
    if (reference) continue;

    if (text.includes(UPSTREAM_WORDMARK)) {
      found.wordmark.push(`${p}:${lineOf(text, text.indexOf(UPSTREAM_WORDMARK))}`);
    }
    for (const candidate of ACCOUNT_CANDIDATES) {
      for (const match of text.matchAll(candidate)) {
        const label = accountLabel(match[1]);
        if (label) found.accounts.push(`${p}:${lineOf(text, match.index)}: ${label}`);
      }
    }
    if (!UPSTREAM_NAME.test(text)) continue;
    const allowed = allowances.filter((allowance) => allowance.path === p);
    text.split("\n").forEach((line, index) => {
      let rest = line;
      for (const allowance of allowed) {
        const stripped = rest.replace(allowance.fragment, " ");
        if (stripped !== rest) allowance.used = true;
        rest = stripped;
      }
      const match = UPSTREAM_NAME.exec(rest);
      if (match) found.names.push(`${p}:${index + 1}: ${JSON.stringify(match[0])}`);
    });
  }
  // An allowance that matches nothing has outlived its reference: drop it from
  // the list so that it cannot excuse a later one.
  for (const allowance of allowances) {
    if (!allowance.used) {
      found.names.push(`${allowance.path}: unused allowance ${allowance.fragment}`);
    }
  }
  for (const p of UPSTREAM_NAMING_TOOLCHAIN_FILES) {
    if (!toolchainFilesNamingUpstream.has(p)) {
      found.names.push(`${p}: unused reference file exemption`);
    }
  }
  for (const p of GENERIC_UPSTREAM_ARTWORK.keys()) {
    if (!genericArtworkSeen.has(p)) found.artwork.push(`${p}: unused generic artwork allowance`);
  }
  for (const p of DERIVED_UPSTREAM_ARTWORK.keys()) {
    if (!derivedArtworkSeen.has(p)) found.artwork.push(`${p}: unused derived artwork entry`);
  }
  for (const kind of Object.keys(found)) found[kind] = [...new Set(found[kind])].sort();
  return found;
}

let leftovers;
function expectNoLeftovers(kind, summary) {
  leftovers ??= findUpstreamLeftovers();
  const findings = leftovers[kind];
  if (findings.length === 0) return;
  assert.fail(
    [`${findings.length} ${summary}`, ...findings.map((finding) => `  ${finding}`)].join("\n"),
  );
}
check("no upstream product, vendor or domain name outside the documented references", () => {
  expectNoLeftovers("names", "upstream name(s) left in the tree:");
});
check("no upstream store, invite or signing identifier", () => {
  expectNoLeftovers("accounts", "upstream account identifier(s) left in the tree:");
});
check("no publishable key outside tests and none issued for an upstream host", () => {
  expectNoLeftovers("keys", "publishable key(s) to remove:");
});
check("upstream wordmark outline absent from every text file", () => {
  expectNoLeftovers("wordmark", "file(s) still draw the upstream wordmark:");
});
check("brand-bearing images are not upstream artwork", () => {
  expectNoLeftovers("artwork", "image(s) still carry upstream artwork:");
});
check("pinned registry, patch and encoded payload bytes preserved", () => {
  preservation = auditPreservedPayloads(root, upstream);
});
check("build scripts use owned artifact identity", () => {
  assert.match(read("apps/server/scripts/cli.ts"), /Built dist-exe\/specweave-studio/);
  assert.match(read("apps/server/scripts/cli.ts"), /path.join\(packagesDir, "@specweave-studio"\)/);
  assert.match(
    read("scripts/build-npm-platform-packages.ts"),
    /NPM_PLATFORM_PACKAGE_SCOPE = "@specweave-studio"/,
  );
  assert.doesNotMatch(read("apps/server/scripts/cli.ts"), /dist-exe\/t3\b|"@studio"/);
});
check("workspace source exports resolve on disk", () => {
  for (const directory of ["packages", "apps"]) {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(root, directory, entry.name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const inspect = (value) => {
        if (typeof value === "string" && value.startsWith("./src/") && !value.includes("*")) {
          assert.ok(
            existsSync(join(dirname(manifestPath), value)),
            `${manifest.name}: source export missing on disk`,
          );
        } else if (value && typeof value === "object") {
          for (const child of Object.values(value)) inspect(child);
        }
      };
      inspect(manifest.exports);
    }
  }
});
check("workspace protocol imports use owned package names", () => {
  const findings = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*)["']effect-(?:acp|codex-app-server)(?:\/|["'])/;
  const scan = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (["fixtures", "__fixtures__", "replays"].includes(entry.name)) continue;
      const p = directory + "/" + entry.name;
      if (entry.isDirectory()) scan(p);
      else if (/\.[cm]?[jt]sx?$/.test(p) && pattern.test(read(p))) findings.push(p);
    }
  };
  for (const directory of [
    "apps/server/src",
    "apps/server/scripts",
    "packages/effect-acp/src",
    "packages/effect-codex-app-server/src",
  ])
    scan(directory);
  assert.deepEqual(findings, []);
  assert.match(read("apps/server/scripts/cli.ts"), /filter\(isUnresolvedFirstPartyCliImport\)/);
});
check("approval default and propagated headless policy", () => {
  assert.match(
    read("packages/contracts/src/providerPolicy.ts"),
    /DEFAULT_RUNTIME_MODE: RuntimeMode = "approval-required"/,
  );
  // The prose every provider receives: headless, and passed to delegated agents.
  const runtime = buildRuntimeInstructions({ harness: "audit" });
  assert.match(runtime, /headless: true/);
  assert.match(runtime, /without the user's approval/);
  assert.match(runtime, /Pass this rule to agents you delegate to\./);
  // The variables every provider process gets, applied over inherited values.
  assert.deepEqual(
    { ...HEADLESS_BROWSER_ENVIRONMENT },
    { PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
  );
  assert.deepEqual(withHeadlessBrowserEnvironment({ PWDEBUG: "1", KEEP: "1" }), {
    KEEP: "1",
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
  });
  const server = (p) => read("apps/server/src/" + p);
  for (const site of Object.keys(PROVIDER_PROCESS_SPAWN_SITES)) {
    assert.ok(
      HEADLESS_ENVIRONMENT_HELPERS.some((helper) => server(site).includes(helper)),
      site + " applies HEADLESS_BROWSER_ENVIRONMENT",
    );
  }
  const adapters = readdirSync(join(root, "apps/server/src/orchestration-v2/Adapters"))
    .filter((name) => name.endsWith("AdapterV2.ts"))
    .map((name) => "orchestration-v2/Adapters/" + name);
  assert.deepEqual(adapters.toSorted(), Object.keys(PROVIDER_ADAPTER_PROCESS_CHAINS).toSorted());
  for (const [adapter, { chain }] of Object.entries(PROVIDER_ADAPTER_PROCESS_CHAINS)) {
    if (chain === null) continue; // Cursor runs in the server process.
    const steps = [adapter, ...chain.filter((step) => step !== adapter)];
    steps.slice(1).forEach((step, index) => {
      const name = step.split("/").at(-1);
      assert.ok(server(steps[index]).includes("/" + name + '"'), steps[index] + " imports " + name);
    });
    assert.ok(steps.at(-1) in PROVIDER_PROCESS_SPAWN_SITES, adapter + " reaches a spawn site");
  }
  // The orchestration block no longer repeats the headless rule, so every
  // sender must also send the runtime instructions (Claude through its policy).
  const senders = [];
  const scan = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const p = directory + "/" + entry.name;
      if (entry.isDirectory()) scan(p);
      else if (p.endsWith(".ts") && !/\.test\.|testkit|\/testing\//.test(p)) {
        const source = read(p);
        if (
          !p.endsWith("/StudioOrchestrationInstructions.ts") &&
          /STUDIO_CODE_ORCHESTRATION_INSTRUCTIONS|studioAcpPromptWithInstructions|studioOrchestrationPromptForFirstRun|studioOrchestrationSystemPrompt/.test(
            source,
          )
        )
          senders.push([p, source]);
      }
    }
  };
  scan("apps/server/src");
  assert.ok(senders.length > 0);
  const claudePolicy = server("provider/ClaudeWorkflowPolicy.ts");
  for (const [p, source] of senders) {
    const viaClaudePolicy =
      /orchestrationInstructions:/.test(source) &&
      /compileClaudeWorkflowPolicy\(/.test(source) &&
      /buildRuntimeInstructions\([^)]*\),\s*input\.orchestrationInstructions/.test(claudePolicy);
    assert.ok(
      /buildRuntimeInstructions|STUDIO_HEADLESS_INSTRUCTIONS/.test(source) || viaClaudePolicy,
      p + " sends orchestration instructions without the runtime instructions",
    );
  }
});
console.log(
  JSON.stringify(
    {
      product: STUDIO_NAME,
      checksPassed: checks.length,
      checksFailed: failures.length,
      checks,
      failed: failures.map((failure) => failure.check),
      root,
      upstream,
      runtimeNode: process.version,
      preservation,
      fixturePreservation,
      genericUpstreamArtworkKept: [
        ...[...GENERIC_UPSTREAM_ARTWORK].map(([path, { depicts }]) => ({
          path,
          depicts,
          comparedWithUpstream: "byte-identical at the same path",
        })),
        ...[...DERIVED_UPSTREAM_ARTWORK].map(([path, { depicts, differs }]) => ({
          path,
          depicts,
          comparedWithUpstream: differs,
        })),
      ],
      noServiceOrAuthActions: true,
    },
    null,
    2,
  ),
);
if (failures.length > 0) {
  for (const failure of failures) console.error(`\nFAILED: ${failure.check}\n${failure.message}`);
  console.error(`\n${failures.length} of ${checks.length + failures.length} checks failed.`);
  process.exitCode = 1;
}
