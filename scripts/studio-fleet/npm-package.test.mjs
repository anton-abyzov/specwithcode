import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build, dependencyClosure, flatLayout, NPM_NODE_ENGINES } from "./npm-package.mjs";

/** A pnpm-style store: node_modules/<root> links into .pnpm/<id>/node_modules/<name>. */
function storePackage(nodeModules, name, version, dependencies = {}) {
  const dir = join(
    nodeModules,
    ".pnpm",
    `${name.replace("/", "+")}@${version}`,
    "node_modules",
    name,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, dependencies }));
  writeFileSync(join(dir, "index.js"), `export default "${name}@${version}";\n`);
  writeFileSync(join(dir, "index.js.map"), "{}");
  return dir;
}

function link(from, to) {
  mkdirSync(join(from, ".."), { recursive: true });
  symlinkSync(to, from);
}

function fixtureRuntime(root) {
  const nodeModules = join(root, "node_modules");
  const sdk = storePackage(nodeModules, "@scope/sdk", "1.0.0", { zod: "^3", shared: "1" });
  const zod4 = storePackage(nodeModules, "zod", "4.0.0");
  const zod3 = storePackage(nodeModules, "zod", "3.0.0");
  const shared = storePackage(nodeModules, "shared", "1.0.0");
  link(join(sdk, "..", "..", "zod"), zod3);
  link(join(sdk, "..", "..", "shared"), shared);
  link(join(nodeModules, "@scope", "sdk"), sdk);
  link(join(nodeModules, "zod"), zod4);
  return nodeModules;
}

test("the closure follows pnpm's store and keeps both versions of a name", () => {
  const root = mkdtempSync(join(tmpdir(), "npm-package-"));
  try {
    const closure = dependencyClosure(fixtureRuntime(root), ["@scope/sdk", "zod"]);
    const names = closure.map((entry) => `${entry.name}@${entry.version}`).sort();
    assert.deepEqual(names, ["@scope/sdk@1.0.0", "shared@1.0.0", "zod@3.0.0", "zod@4.0.0"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the root's version is hoisted and the other one nests under its dependent", () => {
  const layout = flatLayout([
    { name: "zod", version: "4.0.0", parent: null, dir: "/a" },
    { name: "@scope/sdk", version: "1.0.0", parent: null, dir: "/b" },
    { name: "zod", version: "3.0.0", parent: "@scope/sdk", dir: "/c" },
  ]);
  assert.deepEqual(
    layout.map((entry) => [entry.name, entry.version, entry.target]),
    [
      ["zod", "4.0.0", join("node_modules", "zod")],
      ["@scope/sdk", "1.0.0", join("node_modules", "@scope/sdk")],
      ["zod", "3.0.0", join("node_modules", "@scope/sdk", "node_modules", "zod")],
    ],
  );
});

test("a runtime archive becomes one npm tarball with both commands and no links or maps", () => {
  const root = mkdtempSync(join(tmpdir(), "npm-package-"));
  try {
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    fixtureRuntime(runtime);
    writeFileSync(join(runtime, "bin.mjs"), "#!/usr/bin/env node\n");
    writeFileSync(join(runtime, "bin.mjs.map"), "{}");
    writeFileSync(join(runtime, "LICENSE"), "MIT\n");
    writeFileSync(
      join(runtime, "package.json"),
      JSON.stringify({ name: "specweave-studio", version: "1.2.3" }),
    );
    writeFileSync(
      join(runtime, "studio-manifest.json"),
      JSON.stringify({
        product: "SpecWeave Studio",
        version: "1.2.3",
        sourceCommit: "a".repeat(40),
        runtimeRoots: ["@scope/sdk", "zod"],
        files: [{ path: "bin.mjs" }],
      }),
    );
    const archive = join(root, "runtime.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", runtime, "."]);
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");

    assert.throws(
      () => build({ archive, sha256: "0".repeat(64), outputDir: join(root, "bad") }),
      /SHA-256/,
    );
    const result = build({ archive, sha256, outputDir: join(root, "out") });
    assert.equal(result.version, "1.2.3");
    const pkg = JSON.parse(readFileSync(join(result.packageDir, "package.json"), "utf8"));
    assert.equal(pkg.name, "specwithcode");
    assert.equal(pkg.license, "UNLICENSED");
    assert.equal(readFileSync(join(result.packageDir, "LICENSE"), "utf8"), "MIT\n");
    assert.deepEqual(pkg.bin, { specwithcode: "bin.mjs", "specweave-studio": "bin.mjs" });
    assert.equal(pkg.dependencies, undefined);
    // The server's range, not the workspace's pinned build version (EBADENGINE on Node 22.19).
    assert.equal(pkg.engines.node, NPM_NODE_ENGINES);
    const manifest = JSON.parse(
      readFileSync(join(result.packageDir, "studio-manifest.json"), "utf8"),
    );
    assert.deepEqual(Object.keys(manifest).sort(), [
      "distribution",
      "product",
      "schemaVersion",
      "sourceCommit",
      "version",
    ]);
    assert.equal(existsSync(join(result.packageDir, "bin.mjs.map")), false);
    assert.equal(existsSync(join(result.packageDir, "node_modules", "zod", "index.js.map")), false);
    assert.equal(
      lstatSync(join(result.packageDir, "node_modules", "@scope", "sdk")).isSymbolicLink(),
      false,
    );
    assert.match(
      readFileSync(
        join(result.packageDir, "node_modules", "@scope", "sdk", "node_modules", "zod", "index.js"),
        "utf8",
      ),
      /zod@3\.0\.0/,
    );
    const listing = execFileSync("tar", ["-tzf", result.tarball], { encoding: "utf8" }).split("\n");
    assert.ok(listing.every((entry) => entry === "" || entry.startsWith("package")));
    assert.ok(listing.includes("package/node_modules/shared/index.js"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the npm range matches the server package's own engines", () => {
  const server = JSON.parse(
    readFileSync(new URL("../../apps/server/package.json", import.meta.url), "utf8"),
  );
  assert.equal(NPM_NODE_ENGINES, server.engines.node);
});
