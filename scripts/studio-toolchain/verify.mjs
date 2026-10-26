import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
assert.ok(process.versions.node.startsWith('22.'), 'Run this acceptance check with the supported Node22 runtime');
const args = process.argv.slice(2);
const reportOption = args.indexOf('--report-dir');
const reportDir = reportOption >= 0 ? resolve(args[reportOption + 1]) : join(root, '.studio-build-evidence');
mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const toolRoot = join(homedir(), '.local/share/specweave-studio/toolchains');
const pnpm = process.env.STUDIO_PNPM_CLI ?? join(toolRoot, 'pnpm11/node_modules/pnpm/bin/pnpm.cjs');
assert.ok(existsSync(pnpm), 'Install the verified, isolated pnpm11 toolchain first');
const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH,
  PWDEBUG: '0', PLAYWRIGHT_HTML_OPEN: 'never' };
// No .env file, global runtime switch, provider login or service action occurs.
const receipt = { observedAt: new Date().toISOString(), runtime: process.version, node: process.execPath,
  root, pnpm, browserMode: 'headless-only', steps: [], noServiceOrAuthActions: true };
function save() { writeFileSync(join(reportDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); }
async function run(name, commandArgs, cwd = root) {
  const logPath = join(reportDir, name + '.log');
  const log = createWriteStream(logPath, { mode: 0o600 });
  const started = Date.now();
  const exitCode = await new Promise((done, reject) => {
    const child = spawn(process.execPath, commandArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.once('error', reject);
    child.once('close', code => { log.end(() => done(code)); });
  });
  receipt.steps.push({ name, exitCode, elapsedMs: Date.now() - started, logPath }); save();
  console.log(JSON.stringify({ step: name, exitCode, elapsedMs: Date.now() - started, logPath }));
  assert.equal(exitCode, 0, `${name} failed; inspect the saved log`);
}
await run('brand-audit', ['scripts/studio-brand-audit.mjs']);
await run('frozen-install', [pnpm, '--filter', 'specweave-studio...', '--filter', '@specweave-studio/web...',
  '--filter', '@specweave-studio/scripts...',
  'install', '--frozen-lockfile', '--ignore-scripts', '--store-dir', join(toolRoot, 'pnpm-store')]);
// A focused frozen install has just passed. Run Vite directly so pnpm's default
// pre-run dependency check cannot trigger an unrelated full-workspace install.
await run('web-production', [join(root, 'node_modules/vite-plus/bin/vp'), 'build'], join(root, 'apps/web'));
await run('server-production', ['apps/server/scripts/cli.ts', 'build']);
const require = createRequire(join(root, 'apps/server/package.json'));
receipt.nativeModules = ['node-pty', '@napi-rs/keyring', '@ff-labs/fff-node'].map(name => { require(name); return { name, loaded: true }; });
await run('cli-version', ['apps/server/dist/bin.mjs', '--version']);
await run('cli-help', ['apps/server/dist/bin.mjs', '--help']);
receipt.cliVersion = readFileSync(join(reportDir, 'cli-version.log'), 'utf8').trim();
save();
console.log(JSON.stringify({ checksPassed: receipt.steps.length, runtime: process.version, reportDir }));
