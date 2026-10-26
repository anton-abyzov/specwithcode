// Every file in patches/ is applied to the dependency version the lock installs.
//
// pnpm fails on a patchedDependencies entry that matches nothing, but not on a patch file no entry
// names. Release 1.0.43 failed that way: the Expo 57 patches for expo-modules-core and
// expo-notifications stayed in patches/ after the lock moved to 58.0.11, pnpm installed both
// unpatched, and only the macOS ThreadSanitizer regressions in release.sh's stage 1 noticed.
// This runs in the Linux PR gate, in seconds.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const read = (file) => NodeFS.readFileSync(NodePath.resolve(root, file), "utf8");

const unquote = (text) => text.trim().replace(/^(['"])(.*)\1$/, "$2");

/** The `key: value` lines of a top-level YAML block, comments skipped. */
export const blockEntries = (yaml, name) => {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`${name}:`);
  if (start === -1) return [];
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!line.startsWith("  ")) break;
    if (line.startsWith("   ")) continue;
    const match = /^ {2}((?:'[^']*'|"[^"]*"|[^:\s]+(?::[^\s]+)?)):(?:\s+(.*))?$/.exec(line);
    if (match) entries.push([unquote(match[1]), unquote(match[2] ?? "")]);
  }
  return entries;
};

/** `name@version` -> [name, version], keeping a scope's leading @. */
export const splitKey = (key) => {
  const at = key.lastIndexOf("@");
  return [key.slice(0, at), key.slice(at + 1)];
};

export const patchProblems = ({ workspace, lock, patchFiles, fileExists }) => {
  const problems = [];
  const patched = blockEntries(workspace, "patchedDependencies");
  const lockPatched = new Set(blockEntries(lock, "patchedDependencies").map(([key]) => key));
  const installed = new Map();
  for (const [key] of blockEntries(lock, "packages")) {
    const [name, version] = splitKey(key);
    if (!installed.has(name)) installed.set(name, new Set());
    installed.get(name).add(version);
  }
  const named = new Set(patched.map(([, file]) => file));
  for (const file of patchFiles) {
    if (!named.has(`patches/${file}`)) {
      problems.push(
        `patches/${file} is not in pnpm-workspace.yaml patchedDependencies, so pnpm never applies it`,
      );
    }
  }
  for (const [key, file] of patched) {
    const [name, version] = splitKey(key);
    if (!fileExists(file)) problems.push(`${key}: ${file} does not exist`);
    if (!lockPatched.has(key))
      problems.push(`${key} is not in pnpm-lock.yaml patchedDependencies; run pnpm install`);
    const versions = installed.get(name) ?? new Set();
    if (!versions.has(version)) {
      problems.push(
        `${key}: the lock installs ${name} ${[...versions].join(", ") || "nowhere"}, not ${version}`,
      );
    }
    for (const other of versions) {
      if (other !== version && !patched.some(([k]) => k === `${name}@${other}`)) {
        problems.push(`${key}: the lock also installs ${name}@${other}, which no patch covers`);
      }
    }
  }
  return problems;
};

NodeTest.test("every patch file is applied to the version the lock installs", () => {
  const patchFiles = NodeFS.readdirSync(NodePath.resolve(root, "patches")).filter((file) =>
    file.endsWith(".patch"),
  );
  NodeAssert.ok(patchFiles.length > 0);
  const problems = patchProblems({
    workspace: read("pnpm-workspace.yaml"),
    lock: read("pnpm-lock.yaml"),
    patchFiles,
    fileExists: (file) => NodeFS.existsSync(NodePath.resolve(root, file)),
  });
  NodeAssert.deepEqual(problems, []);
});

NodeTest.test("an orphaned or outdated patch is reported", () => {
  const workspace = [
    "packages:",
    "  - apps/*",
    "patchedDependencies:",
    "  # a comment",
    "  expo-notifications@58.0.11: patches/expo-notifications@58.0.11.patch",
    '  "@scope/pkg@1.0.0": patches/@scope__pkg@1.0.0.patch',
    "",
  ].join("\n");
  const lock = [
    "patchedDependencies:",
    "  expo-notifications@58.0.11: abc",
    "  '@scope/pkg@1.0.0': def",
    "",
    "packages:",
    "",
    "  expo-modules-core@58.0.11:",
    "    resolution: {integrity: x}",
    "  expo-notifications@58.0.11:",
    "    resolution: {integrity: y}",
    "  '@scope/pkg@1.0.0':",
    "    resolution: {integrity: z}",
    "  '@scope/pkg@2.0.0':",
    "    resolution: {integrity: w}",
    "",
  ].join("\n");
  const problems = patchProblems({
    workspace,
    lock,
    patchFiles: [
      "expo-modules-core@57.0.14.patch",
      "expo-notifications@58.0.11.patch",
      "@scope__pkg@1.0.0.patch",
    ],
    fileExists: () => true,
  });
  NodeAssert.deepEqual(problems, [
    "patches/expo-modules-core@57.0.14.patch is not in pnpm-workspace.yaml patchedDependencies, so pnpm never applies it",
    "@scope/pkg@1.0.0: the lock also installs @scope/pkg@2.0.0, which no patch covers",
  ]);
});
