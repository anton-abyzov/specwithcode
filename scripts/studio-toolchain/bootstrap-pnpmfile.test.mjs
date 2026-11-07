import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hook = join(root, "scripts/studio-toolchain/bootstrap-pnpmfile.cjs");
const wrapper = { name: "vp-global", version: "1.0.0", dependencies: { "vite-plus": "1.0.0" } };
const edge = { name: "estree-walker", version: "3.0.3", dependencies: { "@types/estree": "^1.0.0", other: "^2" } };
function readPackage(manifest, pkg = edge) {
  const dir = mkdtempSync(join(tmpdir(), "vp-bootstrap-test-"));
  try {
    if (manifest !== null) writeFileSync(join(dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
    return JSON.parse(execFileSync(process.execPath, ["-e", 'const load = require("node:module").createRequire(process.argv[1]); process.chdir(process.argv[3]); const hook = load(process.argv[1]); console.log(JSON.stringify(hook.hooks.readPackage(JSON.parse(process.argv[2]))));', hook, JSON.stringify(pkg), dir], { cwd: root, encoding: "utf8" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("pins only the unavailable bootstrap edge to the repository-reviewed version", () => {
  assert.deepEqual(readPackage(wrapper), { ...edge, dependencies: { ...edge.dependencies, "@types/estree": "1.0.9" } });
  assert.match(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), /'@types\/estree@1\.0\.9':/);
});

test("product installs and other bootstrap versions keep original package requirements", () => {
  for (const manifest of [JSON.parse(readFileSync(join(root, "package.json"), "utf8")), null, "{invalid", { ...wrapper, name: "different" }, { ...wrapper, version: "1.1.0" }, { ...wrapper, dependencies: { "vite-plus": "1.1.0" } }]) {
    assert.deepEqual(readPackage(manifest), edge);
  }
});

test("does not rewrite unrelated packages, versions, dependency ranges or dependency kinds", () => {
  for (const pkg of [{ ...edge, name: "different" }, { ...edge, version: "4.0.0" }, { ...edge, dependencies: { "@types/estree": "^2.0.0" } }, { name: "estree-walker", version: "3.0.3", devDependencies: edge.dependencies }]) {
    assert.deepEqual(readPackage(wrapper, pkg), pkg);
  }
});

test("every pinned setup-vp step receives a step-scoped bootstrap hook", () => {
  let count = 0;
  for (const name of readdirSync(join(root, ".github/workflows")).filter((name) => name.endsWith(".yml"))) {
    const text = readFileSync(join(root, ".github/workflows", name), "utf8");
    for (const step of text.split(/^      - /m).filter((part) => part.includes("uses: voidzero-dev/setup-vp@"))) {
      count++;
      assert.match(step, /uses: voidzero-dev\/setup-vp@68f39c78aaf39be468cabd2afb09c162574c84af/, name);
      assert.match(step, /^        env:\n(?:          [^\n]*\n)*          npm_config_global_pnpmfile: \$\{\{ github.workspace \}\}\/scripts\/studio-toolchain\/bootstrap-pnpmfile.cjs$/m, name);
    }
  }
  assert.ok(count > 0);
});
