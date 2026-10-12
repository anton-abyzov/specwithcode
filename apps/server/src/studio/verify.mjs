import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

assert.ok(process.versions.node.startsWith("22."), "Use the supported Node22 runtime.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const option = process.argv.indexOf("--report-dir");
const reportDir = option >= 0 ? resolve(process.argv[option + 1]) : resolve(root, ".studio-backend-evidence");
mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const env = { ...process.env, PATH: dirname(process.execPath) + ":" + process.env.PATH,
  PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" };
const sourceCommit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
const receipt = { sourceCommit, observedAt: new Date().toISOString(), node: process.execPath,
  version: process.version, root, noAuthOrInference: true, browserRuns: 0, steps: [] };
const tests = ["studio/Capacity", "studio/SwitchClient", "studio/capacitySnapshot", "studio/http",
  "provider/ProviderInstanceEnvironment", "provider/CodexProvider", "provider/ClaudeProvider",
  "provider/codexUsageLimits", "provider/providerUsageLimits", "provider/ProviderRegistry",
  "provider/ProviderInstanceRegistry", "orchestration-v2/ProviderAdapterRegistry",
  "orchestration-v2/Adapters/CodexAdapterV2", "orchestration-v2/Adapters/ClaudeAdapterV2"];
for (const [name, args] of [
  ["server-typecheck", ["node_modules/typescript/bin/tsc", "--noEmit", "--project", "apps/server/tsconfig.json"]],
  ["focused-tests", ["node_modules/vite-plus/bin/vp", "test", "run", ...tests.map((file) => `apps/server/src/${file}.test.ts`)]],
  ["server-production", ["apps/server/scripts/cli.ts", "build", "--verbose"]],
  ["cli-version", ["apps/server/dist/bin.mjs", "--version"]],
]) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: "utf8", timeout: 120000, maxBuffer: 20 * 1024 * 1024 });
  const logPath = resolve(reportDir, `${name}.log`);
  writeFileSync(logPath, (result.stdout ?? "") + (result.stderr ?? ""), { mode: 0o600 });
  receipt.steps.push({ name, command: [process.execPath, ...args], exitCode: result.status, elapsedMs: Date.now() - started, logPath });
  writeFileSync(resolve(reportDir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(receipt.steps.at(-1)));
  assert.equal(result.status, 0, `${name} failed; retained ${logPath}`);
}
