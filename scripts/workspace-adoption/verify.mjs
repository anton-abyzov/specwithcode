import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert.ok(
  process.versions.node.startsWith("22."),
  "Run workspace adoption verification with Node 22.",
);
const output = join(root, ".artifacts/workspace-adoption/verification");
mkdirSync(output, { recursive: true });
const env = {
  ...process.env,
  PATH: dirname(process.execPath) + ":" + process.env.PATH,
  PWDEBUG: "0",
  PLAYWRIGHT_HTML_OPEN: "never",
};
const vp = join(root, "node_modules/vite-plus/bin/vp");
const receipt = {
  runtime: process.version,
  source: root,
  startedAt: new Date().toISOString(),
  headless: true,
  steps: [],
};
const save = () =>
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
async function run(name, args, cwd = root, node = process.execPath) {
  const logPath = join(output, `${name}.log`);
  const log = createWriteStream(logPath);
  const code = await new Promise((done, reject) => {
    const child = spawn(node, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("error", reject);
    child.once("exit", (code) => log.end(() => done(code)));
  });
  receipt.steps.push({ name, code, node, logPath });
  save();
  console.log(`${name}: ${code === 0 ? "passed" : "FAILED"} (${logPath})`);
  assert.equal(code, 0, `Inspect ${logPath}`);
}
const tests = [
  "packages/contracts/src/projectEnvironment.test.ts",
  "packages/contracts/src/project.test.ts",
  "apps/server/src/project/ProjectEnvironmentImport.test.ts",
  "apps/server/src/project/ProjectEnvironmentAdoption.test.ts",
  "apps/server/src/project/ProjectWorkspaceImportRpc.test.ts",
  "apps/server/src/auth/RpcAuthorization.test.ts",
  "apps/server/src/project/ProjectEnvironmentService.test.ts",
  "apps/server/src/project/ProjectService.test.ts",
  "apps/server/src/project/ProjectPlanService.test.ts",
  "apps/web/src/components/studio/ProjectEnvironmentImport.test.tsx",
  "apps/web/src/components/studio/ProjectWorkspaceSettings.test.tsx",
  "apps/web/src/components/studio/ProjectPlan.test.tsx",
];
const coverage =
  process.env.STUDIO_COVERAGE_MODULE ??
  join(
    homedir(),
    ".local/share/specweave-studio/toolchains/coverage-v8-5.0.1/node_modules/@vitest/coverage-v8/dist/index.js",
  );
assert.ok(
  existsSync(coverage),
  "Install @vitest/coverage-v8 matching this workspace outside the pinned lockfile; set STUDIO_COVERAGE_MODULE.",
);
// V8's workers resolve the provider by package name. Link only this checkout's ignored dependencies.
const coverageLink = join(root, "node_modules/@vitest/coverage-v8");
if (!existsSync(coverageLink)) {
  mkdirSync(dirname(coverageLink), { recursive: true });
  symlinkSync(resolve(dirname(coverage), ".."), coverageLink, "dir");
}
await run("focused-tests-coverage", [
  vp,
  "test",
  "run",
  ...tests,
  "--maxWorkers=2",
  "--coverage",
  "--coverage.provider=v8",
  "--coverage.include=apps/server/src/project/ProjectEnvironmentImport.ts",
  "--coverage.include=apps/server/src/project/ProjectEnvironmentAdoption.ts",
  "--coverage.include=apps/server/src/project/ProjectRepositoryInspection.ts",
  "--coverage.include=apps/server/src/project/plan/SpecWeavePlanReader.ts",
  "--coverage.include=apps/web/src/components/studio/ProjectEnvironmentImport.tsx",
  "--coverage.reporter=json-summary",
  "--coverage.reporter=text",
  `--coverage.reportsDirectory=${join(output, "coverage")}`,
  "--coverage.thresholds.lines=60",
  "--coverage.thresholds.functions=60",
  "--coverage.thresholds.statements=60",
  "--coverage.thresholds.branches=60",
]);
receipt.coverage = JSON.parse(
  readFileSync(join(output, "coverage/coverage-summary.json"), "utf8"),
).total;
save();
if (process.argv.includes("--full")) {
  await run("server-types", [
    join(root, "node_modules/typescript/bin/tsc"),
    "--noEmit",
    "--project",
    "apps/server/tsconfig.json",
  ]);
  const buildNode = process.env.STUDIO_BUILD_NODE ?? process.execPath;
  assert.ok(existsSync(buildNode), "Set STUDIO_BUILD_NODE to the isolated build runtime.");
  await run("web-production", [vp, "build"], join(root, "apps/web"), buildNode);
  await run("server-production", ["apps/server/scripts/cli.ts", "build"], root, buildNode);
  await run(
    "browser-fixture-build",
    [vp, "build", "--config", "scripts/workspace-adoption/vite.config.ts"],
    root,
    buildNode,
  );
  await run("headless-browser", ["scripts/workspace-adoption/browser.mjs"]);
}
receipt.finishedAt = new Date().toISOString();
save();
