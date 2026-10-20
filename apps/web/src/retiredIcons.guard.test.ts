// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * Brain, padlock and "psychology" artwork is retired from every SpecWithCode
 * surface. Thinking rows show the provider mark or three dots, access modes
 * use the crafted AccessGlyph, and secrets use the masked field. This guard
 * fails when one comes back in any app: a Lucide or Tabler import, an SF
 * Symbol or Material name, an emoji or an image named after one.
 */
const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

const APP_TREES = [
  "apps/web/src",
  "apps/web/public",
  "apps/desktop/src",
  "apps/desktop/resources",
  "apps/mobile/src",
  "apps/mobile/assets",
  "apps/mobile/modules",
  "apps/mobile/plugins",
  "apps/ios",
  "apps/marketing/src",
  "apps/marketing/public",
];

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  ".build",
  ".expo",
  ".gradle",
  ".cxx",
  "DerivedData",
  "Pods",
  "SpecWithCode.xcodeproj",
]);

const SOURCE_EXTENSIONS =
  /\.(?:tsx?|jsx?|mjs|cjs|swift|kt|h|mm?|xml|css|html|astro|mdx?|json|svg)$/;
const IMAGE_EXTENSIONS = /\.(?:svg|png|webp|jpe?g|pdf|icns|ico)$/;

const ICON_LIBRARIES = String.raw`(?:lucide|@tabler\/icons|react-icons|@expo\/vector-icons)[^"']*`;
const ICON_LIBRARY_IMPORT = new RegExp(
  String.raw`import\s+(?:type\s+)?([\w$]+\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["'](${ICON_LIBRARIES})["']`,
  "g",
);
/** Brain or padlock in a component name; "Unlock" counts, Clock and Block don't. */
const RETIRED_COMPONENT_NAME = /Brain|Lock|Psychology|(?<![CcBb])lock/;

const BANNED: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  {
    name: "brain or padlock component",
    pattern: /\b\w*(?:Brain|Lock|(?<![CcBb])lock)\w*Icon\b/g,
  },
  { name: "Tabler brain or padlock", pattern: /\bIcon(?:Brain|Lock|Unlock|Psychology)\w*/g },
  {
    // "brain", "lock.fill", "exclamationmark.lock.fill", "shield-lock", "folder-lock".
    name: "brain or padlock symbol name",
    pattern: /["'](?:[a-z0-9]+[.-])*(?:brain|lock|unlock)(?:[.-][\w.-]+)?["']/g,
  },
  { name: "Material psychology or padlock", pattern: /["'](?:psychology(?:_alt)?|lock_\w+)["']/g },
  {
    name: "brain or padlock emoji",
    pattern: /\u{1F9E0}|\u{1F512}|\u{1F513}|\u{1F510}|\u{1F50F}/gu,
  },
  {
    // A namespace import hides which icons are drawn, so the names above can't see them.
    name: "icon library namespace import",
    pattern: new RegExp(
      String.raw`import\s+\*\s+as\s+[\w$]+\s+from\s*["']${ICON_LIBRARIES}["']`,
      "g",
    ),
  },
];

/** Quoted names of files and events that contain "lock" but are not artwork. */
const NON_ICON_NAMES = new Set([
  // Package manager lock files and Firefox's profile lock.
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "composer.lock",
  "parent.lock",
  // Electron power monitor events.
  "lock-screen",
  "unlock-screen",
]);

/** Matches that are not artwork in one file: a lock file, a power event, a legacy key. */
const ALLOWED: ReadonlyArray<{ readonly file: string; readonly text: string }> = [
  // Firefox's profile lock file, not an icon.
  { file: "apps/desktop/src/preview/BrowserImport/Sources.ts", text: '"lock"' },
  // The update check's reason after an Electron "unlock-screen" event.
  { file: "apps/desktop/src/app/DesktopApp.ts", text: '"unlock"' },
  // Saved project icon names, drawn as a lightbulb, a CPU and a shield.
  { file: "apps/ios/SWCKit/Sources/Weave/Components/ProjectAvatar.swift", text: '"brain"' },
  { file: "apps/ios/SWCKit/Sources/Weave/Components/ProjectAvatar.swift", text: '"brain-circuit"' },
  { file: "apps/ios/SWCKit/Sources/Weave/Components/ProjectAvatar.swift", text: '"lock"' },
];

const isTestFile = (file: string) =>
  /\.test\.[cm]?[jt]sx?$/.test(file) || /\/(?:Tests|UITests|__tests__)\//.test(file);

function walk(directory: string, files: string[]): string[] {
  if (!NodeFS.existsSync(directory)) return files;
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else files.push(NodePath.relative(repoRoot, path).split(NodePath.sep).join("/"));
  }
  return files;
}

export function findRetiredIcons(file: string, source: string): string[] {
  const findings: string[] = [];
  const report = (index: number, name: string, text: string) => {
    if (NON_ICON_NAMES.has(text.slice(1, -1))) return;
    if (ALLOWED.some((allowed) => allowed.file === file && allowed.text === text)) return;
    findings.push(`${file}:${source.slice(0, index).split("\n").length} ${name}: ${text}`);
  };
  for (const { name, pattern } of BANNED) {
    for (const match of source.matchAll(pattern)) report(match.index, name, match[0]);
  }
  for (const match of source.matchAll(ICON_LIBRARY_IMPORT)) {
    const specifiers = [match[1] ?? "", ...(match[2] ?? "").split(",")];
    for (const specifier of specifiers) {
      const imported =
        specifier
          .trim()
          .replace(/,$/, "")
          .split(/\s+as\s+/)[0]
          ?.replace(/^type\s+/, "") ?? "";
      if (RETIRED_COMPONENT_NAME.test(imported))
        report(match.index, `${match[3]} brain or padlock`, imported);
    }
  }
  return findings;
}

const appFiles = APP_TREES.flatMap((tree) => walk(NodePath.join(repoRoot, tree), []));

describe("retired brain and padlock icons", () => {
  it("scans every app tree", () => {
    for (const tree of APP_TREES) {
      expect(
        appFiles.some((file) => file.startsWith(`${tree}/`)),
        tree,
      ).toBe(true);
    }
  });

  it("are not drawn by any app", () => {
    const findings = appFiles
      .filter((file) => SOURCE_EXTENSIONS.test(file) && !isTestFile(file))
      .flatMap((file) =>
        findRetiredIcons(file, NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8")),
      );
    expect(findings).toEqual([]);
  });

  it("ship no brain or padlock images", () => {
    const images = appFiles.filter(
      (file) =>
        IMAGE_EXTENSIONS.test(file) &&
        /(?:^|[/_.-])(?:brain|lock|padlock|psychology)(?:[/_.-]|$)/i.test(file),
    );
    expect(images).toEqual([]);
  });

  it("catches each retired form", () => {
    const seeded = [
      'import { BrainIcon, LockKeyholeIcon } from "lucide-react";',
      'import { Brain, Lock } from "lucide-react";',
      'import { Unlock, UnlockKeyhole } from "lucide-react";',
      "<UnlockIcon />",
      "<IconLock size={12} />",
      'Image(systemName: "brain")',
      'Image(systemName: "exclamationmark.lock.fill")',
      '[UIImage systemImageNamed:@"lock.shield"]',
      'icon: { ios: "lock.fill", android: "lock" }',
      '<MaterialCommunityIcons name="shield-lock" />',
      'symbol: "psychology"',
      'value: "brain-circuit"',
      "label: '\u{1F9E0} Thinking'",
      'import * as Icons from "lucide-react";',
    ].join("\n");
    const found = findRetiredIcons("apps/web/src/seeded.tsx", seeded).map((finding) =>
      finding.replace(/^[^ ]+ /, ""),
    );
    for (const text of [
      "BrainIcon",
      "LockKeyholeIcon",
      "Brain",
      "Lock",
      "Unlock",
      "UnlockKeyhole",
      "UnlockIcon",
      "IconLock",
      '"brain"',
      '"exclamationmark.lock.fill"',
      '"lock.fill"',
      '"lock.shield"',
      '"shield-lock"',
      '"psychology"',
      '"brain-circuit"',
      "\u{1F9E0}",
      'import * as Icons from "lucide-react"',
    ]) {
      expect(
        found.some((finding) => finding.endsWith(`: ${text}`)),
        text,
      ).toBe(true);
    }
    expect(
      findRetiredIcons(
        "apps/web/src/seeded.tsx",
        [
          'import { ClockIcon, BlockquoteIcon, AlarmClock, Blocks } from "lucide-react";',
          'const lockfiles = ["pnpm-lock.yaml", "yarn.lock"];',
          'powerMonitor.on("unlock-screen", check);',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
