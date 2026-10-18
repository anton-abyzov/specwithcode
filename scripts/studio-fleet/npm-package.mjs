#!/usr/bin/env node
/**
 * Builds the `specwithcode` npm package from a published release's runtime
 * archive (`studio-<version>-<sha12>.tar.gz`, the one the fleet installer
 * verifies), so `npm i -g specwithcode` runs the same bytes on Node 22.
 *
 *   node scripts/studio-fleet/npm-package.mjs --archive <runtime.tar.gz> \
 *     --sha256 <hex from SHA256SUMS> --output-dir <new dir>
 *
 * The runtime archive is platform independent apart from its manifest: its
 * native dependencies carry prebuilds for darwin and linux on x64 and arm64.
 * The archive keeps them in pnpm's symlinked store, and npm drops symlinks
 * and nested node_modules when it packs a folder, so this script copies the
 * dependency closure into a flat node_modules and writes the npm tarball
 * itself (`npm publish <tarball>` uploads it byte for byte).
 *
 * Source maps are left out. The manifest is reduced to the fields
 * ServerReleaseManifest reads, so the server reports its source commit.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

export const NPM_PACKAGE_NAME = "specwithcode";
export const NPM_BINS = ["specwithcode", "specweave-studio"];
const EXCLUDED_FILE = /\.map$/;

/** Every package reachable from `roots`, read from pnpm's store beside each package. */
export function dependencyClosure(nodeModules, roots) {
  const packages = new Map(); // "name@version" -> { name, version, dir, parent }
  const queue = roots.map((root) => ({ link: path.join(nodeModules, root), parent: null }));
  while (queue.length > 0) {
    const { link, parent } = queue.shift();
    const dir = fs.realpathSync(link);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    const key = `${manifest.name}@${manifest.version}`;
    if (packages.has(key)) continue;
    packages.set(key, { name: manifest.name, version: manifest.version, dir, parent });
    const store = dir.slice(0, dir.lastIndexOf(`${path.sep}node_modules${path.sep}`) + 14);
    const wanted = { ...manifest.optionalDependencies, ...manifest.dependencies };
    for (const dependency of Object.keys(wanted)) {
      const candidate = path.join(store, dependency);
      // An optional platform package the store never received is simply absent.
      if (fs.existsSync(candidate)) queue.push({ link: candidate, parent: manifest.name });
    }
  }
  return [...packages.values()];
}

/**
 * Hoists each package to node_modules/<name>. The first version reached wins
 * the top level (roots come first); another version of the same name is
 * nested under the package that asked for it.
 */
export function flatLayout(closure) {
  const top = new Map();
  const layout = [];
  for (const entry of closure) {
    const hoisted = top.get(entry.name);
    if (hoisted === undefined) {
      top.set(entry.name, entry.version);
      layout.push({ ...entry, target: path.join("node_modules", entry.name) });
    } else if (hoisted !== entry.version) {
      if (entry.parent === null) throw new Error(`Root ${entry.name} appears in two versions`);
      layout.push({
        ...entry,
        target: path.join("node_modules", entry.parent, "node_modules", entry.name),
      });
    }
  }
  return layout;
}

function copyTree(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    if (item.name === "node_modules") continue;
    const from = path.join(source, item.name);
    const to = path.join(target, item.name);
    const stat = fs.statSync(from); // follows links: the copy holds no symlinks
    if (stat.isDirectory()) copyTree(from, to);
    else if (stat.isFile() && !EXCLUDED_FILE.test(item.name)) {
      fs.copyFileSync(from, to);
      fs.chmodSync(to, stat.mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

function readme(version) {
  return `# SpecWithCode

The SpecWithCode server and CLI (version ${version}). It needs Node.js 22.20 or newer on macOS or Linux.

\`\`\`sh
npm i -g specwithcode
specwithcode --version
\`\`\`

Add this machine to your existing SpecWithCode machines over Tailscale:

\`\`\`sh
specwithcode service install   # run the server in the background
specwithcode fleet invite      # publish it on this machine's Tailscale name and print a join line
\`\`\`

On your main machine, paste the line into Settings > Connections > Add a machine, or run
\`specwithcode fleet add <line>\`. \`specweave-studio\` is the same command under its earlier name.

MIT licensed. See LICENSE and UPSTREAM.md for the retained upstream notice.
`;
}

export function build({ archive, sha256, outputDir }) {
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (digest !== sha256.toLowerCase())
    throw new Error(`${archive} does not match the given SHA-256`);
  if (fs.existsSync(outputDir)) throw new Error(`${outputDir} already exists`);
  const work = path.join(outputDir, "extract");
  const pkg = path.join(outputDir, "package");
  fs.mkdirSync(work, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", work]);
  const release = JSON.parse(fs.readFileSync(path.join(work, "studio-manifest.json"), "utf8"));
  const runtime = JSON.parse(fs.readFileSync(path.join(work, "package.json"), "utf8"));

  fs.mkdirSync(pkg);
  for (const item of fs.readdirSync(work, { withFileTypes: true })) {
    if (["node_modules", "package.json", "studio-manifest.json"].includes(item.name)) continue;
    const from = path.join(work, item.name);
    if (item.isDirectory()) copyTree(from, path.join(pkg, item.name));
    else if (item.isFile() && !EXCLUDED_FILE.test(item.name)) {
      fs.copyFileSync(from, path.join(pkg, item.name));
    }
  }
  fs.chmodSync(path.join(pkg, "bin.mjs"), 0o755);
  const layout = flatLayout(
    dependencyClosure(path.join(work, "node_modules"), release.runtimeRoots),
  );
  for (const entry of layout) copyTree(entry.dir, path.join(pkg, entry.target));

  fs.writeFileSync(
    path.join(pkg, "studio-manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, product: release.product, version: release.version, sourceCommit: release.sourceCommit, distribution: "npm" }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(pkg, "README.md"), readme(release.version));
  const manifest = {
    name: NPM_PACKAGE_NAME,
    version: release.version,
    description: "SpecWithCode server and CLI: spec-driven coding agents across your machines.",
    license: "MIT",
    type: "module",
    homepage: "https://github.com/anton-abyzov/specwithcode",
    repository: { type: "git", url: "git+https://github.com/anton-abyzov/specwithcode.git" },
    bin: Object.fromEntries(NPM_BINS.map((bin) => [bin, "bin.mjs"])),
    engines: { node: ">=22.20.0" },
    os: ["darwin", "linux"],
    cpu: ["x64", "arm64"],
  };
  if (runtime.version !== release.version) throw new Error("Runtime package and manifest disagree");
  fs.writeFileSync(path.join(pkg, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.rmSync(work, { recursive: true, force: true });

  const tarball = path.join(outputDir, `${NPM_PACKAGE_NAME}-${release.version}.tgz`);
  execFileSync("tar", ["-czf", tarball, "--uid", "0", "--gid", "0", "-C", outputDir, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return { tarball, packageDir: pkg, version: release.version, packages: layout.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      archive: { type: "string" },
      sha256: { type: "string" },
      "output-dir": { type: "string" },
    },
  });
  if (!values.archive || !values.sha256 || !values["output-dir"]) {
    console.error(
      "usage: npm-package.mjs --archive <runtime.tar.gz> --sha256 <hex> --output-dir <new dir>",
    );
    process.exit(2);
  }
  const result = build({
    archive: values.archive,
    sha256: values.sha256,
    outputDir: path.resolve(values["output-dir"]),
  });
  console.log(JSON.stringify(result, null, 2));
}
