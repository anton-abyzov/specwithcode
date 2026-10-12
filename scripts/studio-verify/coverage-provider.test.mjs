import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COVERAGE_PROVIDER,
  COVERAGE_PROVIDER_VERSION,
  requireCoverageProvider,
} from "./coverage-provider.mjs";

function workspace(t, version) {
  const root = mkdtempSync(join(tmpdir(), "studio-coverage-provider-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "apps/web");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "package.json"), '{"name":"web"}');
  if (version) {
    const plugin = join(root, "node_modules", COVERAGE_PROVIDER);
    mkdirSync(plugin, { recursive: true });
    writeFileSync(
      join(plugin, "package.json"),
      JSON.stringify({ name: COVERAGE_PROVIDER, version }),
    );
  }
  return app;
}

test("resolves the matching plugin from the workspace root for each package", (t) => {
  const app = workspace(t, COVERAGE_PROVIDER_VERSION);
  const [found] = requireCoverageProvider([app]);
  assert.equal(found.version, COVERAGE_PROVIDER_VERSION);
  assert.match(found.manifest, /node_modules\/@vitest\/coverage-v8\/package\.json$/);
});

test("a missing plugin fails before any test step with the install pointer", (t) => {
  const app = workspace(t, null);
  assert.throws(
    () => requireCoverageProvider([app]),
    /not installed.*install that exact version out of tree/s,
  );
});

test("a plugin that does not match the Vitest runner is refused", (t) => {
  const app = workspace(t, "4.0.0");
  assert.throws(() => requireCoverageProvider([app]), /does not match the Vitest 5\.0\.1 runner/);
});
