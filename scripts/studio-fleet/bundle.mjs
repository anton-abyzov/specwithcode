#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { findEsmImportsOfExternalPackages } from "../lib/cli-executable-imports.ts";
import {
  isUnresolvedFirstPartyCliImport,
  selectCliRuntimeExternalDependencies,
} from "../lib/cli-external-packages.ts";
import { sourceVersion } from "../studio-projects/version.mjs";
import { generateThirdPartyLicenseManifest } from "../lib/third-party-licenses.ts";
import { runtimePackage } from "./runtime-package.mjs";
import { MAC_SERVICE_UPDATER_FILES } from "../lib/studio-service-updater.ts";

assert.equal(process.versions.node.split(".")[0], "22", "Use the supported Node22 toolchain");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = sourceVersion(root);
const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  assert.ok(index >= 0 && args[index + 1], `Required: ${name}`);
  return resolve(args[index + 1]);
}
function optional(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}
const output = option("--out");
const archive = option("--archive");
// A mac build host also produces the Linux worker archives: the runtime is the same JavaScript,
// and every native dependency ships its builds for all supported targets.
const platform = optional("--platform", process.platform);
const arch = optional("--arch", process.arch);
assert.ok(
  ["darwin", "linux"].includes(platform) && ["arm64", "x64"].includes(arch),
  "Supported targets: --platform darwin|linux, --arch arm64|x64",
);
assert.ok(!existsSync(output) && !existsSync(archive), "Bundle destinations must be new");
// Build output may live on an external volume; copy its directory, not the alias.
const dist = realpathSync(join(root, "apps/server/dist"));
assert.ok(
  existsSync(join(dist, "bin.mjs")) && existsSync(join(dist, "client/index.html")),
  "Build the integrated Node22 server and web client first",
);
execFileSync("/usr/bin/git", ["diff", "--quiet", "HEAD", "--"], { cwd: root, stdio: "ignore" });
const sourceCommit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const within = (base, path) => path === base || path.startsWith(base + sep);
const store = realpathSync(join(root, "node_modules/.pnpm"));
// Native adapters deliberately use createRequire; ESM imports alone omit them.
const serverPackage = JSON.parse(readFileSync(join(root, "apps/server/package.json"), "utf8"));
const roots = new Set(
  Object.keys(selectCliRuntimeExternalDependencies(serverPackage.dependencies)),
);
for (const file of readdirSync(dist).filter((file) => file.endsWith(".mjs"))) {
  for (const id of findEsmImportsOfExternalPackages(readFileSync(join(dist, file), "utf8"))) {
    assert.ok(!isUnresolvedFirstPartyCliImport(id), `Unresolved workspace module: ${id}`);
    const name = id.startsWith("@") ? id.split("/").slice(0, 2).join("/") : id.split("/")[0];
    roots.add(name);
  }
}
assert.ok(
  roots.has("node-pty") && roots.has("@napi-rs/keyring"),
  "Native runtime imports were not detected",
);
mkdirSync(output, { recursive: true, mode: 0o700 });
cpSync(dist, output, { recursive: true, dereference: false });
// The server invokes its own immutable helper graph beside bin.mjs. The same
// authoritative list supplies the desktop resources and the installed updater.
const updater = join(output, "studio-updater");
mkdirSync(updater, { recursive: true, mode: 0o700 });
for (const file of MAC_SERVICE_UPDATER_FILES) {
  const source = join(root, "scripts/studio-fleet", file);
  assert.ok(
    lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink(),
    "Unsafe updater helper source",
  );
  cpSync(source, join(updater, file));
}
// Which release this copy of the agent belongs to: no installer puts it over a newer agent
// (update_request.AGENT_RECORD), and update.py installs it after every verified install.
writeFileSync(
  join(updater, "agent-release.json"),
  JSON.stringify({ schemaVersion: 1, version }) + "\n",
);
for (const file of ["UPSTREAM.md"]) cpSync(join(root, file), join(output, file));
// Preserve the installed notice path while source separates third-party terms.
cpSync(join(root, "THIRD_PARTY_NOTICES.md"), join(output, "LICENSE"));
const manifest = {
  schemaVersion: 1,
  product: "SpecWeave Studio",
  version,
  sourceCommit,
  runtime: "Node22.20.0",
  platform,
  arch,
  lockSha256: hash(lock),
  runtimeRoots: [...roots].sort(),
  packages: [],
  files: [],
  resourceTelemetry: "unavailable-until-verified-sidecar",
  noAuthOrUserStores: true,
};

function integrity(name, version) {
  const key = `${name}@${version}`;
  const lines = lock.split("\n");
  const index = lines.findIndex((line) => {
    const match = /^  (.+):$/.exec(line);
    return match && match[1].replace(/^['"]|['"]$/g, "") === key;
  });
  assert.ok(index >= 0, `Runtime dependency absent from pinned lock: ${key}`);
  for (let cursor = index + 1; cursor < lines.length && !/^  \S/.test(lines[cursor]); cursor++) {
    const match = /integrity: ([^},\s]+)/.exec(lines[cursor]);
    if (match) return match[1];
  }
  throw new Error(`Runtime dependency lacks locked integrity: ${key}`);
}
const volumes = new Set();
function volumeFor(path) {
  assert.ok(within(store, path), "A runtime dependency escapes the project pnpm store");
  const volume = relative(store, path).split(sep)[0];
  assert.ok(volume && volume !== "node_modules", "Dependency did not resolve to a pnpm volume");
  return volume;
}
function includeVolume(volume) {
  if (volumes.has(volume)) return;
  volumes.add(volume);
  const source = join(store, volume);
  const destination = join(output, "node_modules/.pnpm", volume);
  function copyTree(from, to) {
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(from);
      const dependencyVolume = volumeFor(target);
      includeVolume(dependencyVolume);
      const bundledTarget = join(output, "node_modules/.pnpm", relative(store, target));
      mkdirSync(dirname(to), { recursive: true });
      symlinkSync(relative(dirname(to), bundledTarget), to);
    } else if (stat.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from)) {
        if (name === ".git" || name === ".bin" || name === ".repos" || /^\.env(?:\.|$)/.test(name))
          continue;
        copyTree(join(from, name), join(to, name));
      }
    } else if (stat.isFile()) {
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to);
      // Bundled vendored metadata (for example Cursor's tree-sitter sources)
      // belongs to its enclosing locked package, rather than a pnpm resolution.
      if (/^node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(relative(source, from))) {
        const pkg = JSON.parse(readFileSync(from, "utf8"));
        if (pkg.name && pkg.version)
          manifest.packages.push({
            name: pkg.name,
            version: pkg.version,
            integrity: integrity(pkg.name, pkg.version),
            packageJsonSha256: hash(readFileSync(from)),
          });
      }
    } else throw new Error("Unsupported runtime dependency file type");
  }
  copyTree(source, destination);
}
for (const name of roots) {
  const candidates = [
    join(root, "apps/server/node_modules", name),
    join(root, "node_modules", name),
    join(store, "node_modules", name),
  ];
  const source = candidates.find(existsSync);
  assert.ok(source, `Emitted runtime module is not installed: ${name}`);
  const target = realpathSync(source);
  includeVolume(volumeFor(target));
  const bundledTarget = join(output, "node_modules/.pnpm", relative(store, target));
  const destination = join(output, "node_modules", name);
  mkdirSync(dirname(destination), { recursive: true });
  symlinkSync(relative(dirname(destination), bundledTarget), destination);
}
// The target's own native builds must be in the archive, or the server will not start there.
// Each napi package is a pnpm volume of its own; node-pty ships every prebuild in one tree.
assert.ok(
  existsSync(join(output, "node_modules/node-pty/prebuilds", `${platform}-${arch}`)),
  `node-pty has no prebuild for ${platform}-${arch}`,
);
const gnu = platform === "linux" ? "-gnu" : "";
const bundledVolumes = readdirSync(join(output, "node_modules/.pnpm"));
for (const prefix of [
  `@napi-rs+keyring-${platform}-${arch}${gnu}@`,
  `@yuuang+ffi-rs-${platform}-${arch}${gnu}@`,
  `@ff-labs+fff-bin-${platform}-${arch}${gnu}@`,
  `@cursor+sdk-${platform}-${arch}@`,
]) {
  assert.ok(
    bundledVolumes.some((volume) => volume.startsWith(prefix)),
    `Native build for ${platform}-${arch} is not bundled: ${prefix}`,
  );
}
writeFileSync(
  join(output, "package.json"),
  JSON.stringify(runtimePackage(version), null, 2) + "\n",
);
const notices = await generateThirdPartyLicenseManifest({
  configFile: join(root, "third-party-licenses.config.json"),
  packageManifests: [
    { bundle: "server", path: join(root, "apps/server/package.json") },
    { bundle: "web", path: join(root, "apps/web/package.json") },
  ],
});
writeFileSync(join(output, "third-party-licenses.json"), JSON.stringify(notices) + "\n");
function indexTree(path) {
  for (const name of readdirSync(path).sort()) {
    const absolute = join(path, name),
      local = relative(output, absolute);
    const stat = lstatSync(absolute);
    assert.ok(!local.split(sep).some((part) => [".repos", ".git", ".bin"].includes(part)));
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      assert.ok(
        !target.startsWith("/") && within(output, realpathSync(absolute)),
        "Escaped bundle symlink",
      );
      manifest.files.push({ path: local, type: "symlink", target });
    } else if (stat.isDirectory()) indexTree(absolute);
    else
      manifest.files.push({
        path: local,
        type: "file",
        bytes: stat.size,
        mode: stat.mode & 0o777,
        sha256: hash(readFileSync(absolute)),
      });
  }
}
indexTree(output);
manifest.packages = [
  ...new Map(manifest.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg])).values(),
].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
manifest.pnpmVolumes = volumes.size;
writeFileSync(join(output, "studio-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
execFileSync("/usr/bin/tar", ["-czf", archive, "-C", output, "."], {
  env: { COPYFILE_DISABLE: "1", PATH: "/usr/bin:/bin", HOME: process.env.HOME },
  stdio: "ignore",
});
const receipt = {
  version,
  archive,
  sha256: hash(readFileSync(archive)),
  sourceCommit,
  files: manifest.files.length,
  packages: manifest.packages.length,
  pnpmVolumes: volumes.size,
  runtimeRoots: manifest.runtimeRoots,
  license: "LICENSE",
  upstreamProvenance: "UPSTREAM.md",
  generatedNotices: ["third-party-licenses.json", "client/third-party-licenses.json"],
};
writeFileSync(archive + ".receipt.json", JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(receipt));
