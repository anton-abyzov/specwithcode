import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import net from 'node:net';
import { serverRpc, nativeRouteMetadata, safeProjection } from './native-proof.mjs';

assert.ok(process.versions.node.startsWith('22.'));
process.env.PWDEBUG='0'; process.env.PLAYWRIGHT_HTML_OPEN='never';
const args = process.argv.slice(2);
const restoreOnly = args.includes('--restore-only');
function option(name) { const i = args.indexOf(name); assert.ok(i >= 0 && args[i + 1], name + ' is required'); return args[i + 1]; }
const previous = JSON.parse(readFileSync(option('--previous-receipt'), 'utf8'));
assert.equal(previous.failure, undefined); assert.equal(previous.native.runs.at(-1).status, 'completed');
const stateDir = previous.server.baseDir;
assert.ok(stateDir.startsWith(join(homedir(), '.local/share/specweave-studio/verification/')));
const cwd = previous.native.worktreePath;
assert.ok(cwd.startsWith(stateDir + '/worktrees/')); assert.equal(previous.native.providerInstanceId, 'codex');
const ownedCodex = join(homedir(), '.local/share/specweave/providers/bin/codex');
const binary = process.env.STUDIO_CODEX_BINARY || (existsSync(ownedCodex) ? ownedCodex
  : (process.env.PATH ?? '').split(':').filter(Boolean).map(dir => join(dir, 'codex')).find(candidate => existsSync(candidate)));
assert.ok(binary, 'Set STUDIO_CODEX_BINARY or put codex on PATH');
assert.equal(spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim(), 'codex-cli 0.160.1');
assert.equal(readFileSync(join(cwd, 'marker.txt'), 'utf8'), restoreOnly ? 'studio-baseline\n' : 'studio-native-completed\n');
const reportDir = resolve(option('--report-dir')); mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const receipt = { observedAt: new Date().toISOString(), node: process.execPath, runtime: process.version,
  entrypoint: previous.entrypoint, previousReceipt: resolve(option('--previous-receipt')),
  browser: { headless: true, PWDEBUG: '0', PLAYWRIGHT_HTML_OPEN: 'never' }, steps: [], providerTurns: 0, screenshots: [] };
const save = () => writeFileSync(join(reportDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
function step(name, result) { receipt.steps.push({ name, ...result }); save(); console.log(JSON.stringify({ name, ...result })); }
const origin = 'http://127.0.0.1:8420';
await new Promise((done, reject) => { const server = net.createServer(); server.once('error', () => reject(new Error('Preserve the dedicated port owner'))); server.listen(8420, '127.0.0.1', () => server.close(done)); });
const env = { ...process.env, PATH: dirname(process.execPath) + ':' + process.env.PATH, PWDEBUG: '0', PLAYWRIGHT_HTML_OPEN: 'never' };
const child = spawn(process.execPath, [previous.entrypoint, 'serve', '--host', '127.0.0.1', '--port', '8420', '--base-dir', stateDir, '--no-browser'],
  { cwd: stateDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
receipt.server = { pid: child.pid, previousPid: previous.server.pid, baseDir: stateDir }; save();
let privateOutput = ''; let browser;
const headers = { 'x-studio-orchestration-protocol': '2' };
try {
  const credential = await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned private server startup timed out')), 45000);
    const inspect = chunk => { privateOutput += chunk.toString(); const found = privateOutput.match(/(?:^|\n)Token: ([^\s]+)/); if (found) { clearTimeout(timer); ready(found[1]); } };
    child.stdout.on('data', inspect); child.stderr.on('data', inspect);
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Owned private server exited: ' + code)); });
  });
  const { chromium } = createRequire(import.meta.url)(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  assert.equal((await context.request.post(origin + '/api/auth/browser-session', { headers: { Origin: origin }, data: { credential } })).status(), 200);
  let config;
  for (let i = 0; i < 15; i++) {
    config = await serverRpc(context, origin, 'server.getConfig');
    if (config.providers.some(p => p.instanceId === 'codex' && p.status === 'ready' && p.auth.status === 'authenticated')) break;
    await new Promise(done => setTimeout(done, 2000));
  }
  assert.equal(config.providers.find(p => p.instanceId === 'codex').version, '0.160.1');
  const fresh = await context.request.post(origin + '/api/studio/capacity/refresh', { headers: { Origin: origin }, data: {} });
  assert.equal(fresh.status(), 200);
  const account = (await fresh.json()).accounts.find(a => a.id === 'codex-1');
  assert.equal(account.status, 'ready'); assert.equal(account.providerInstanceId, 'codex');
  const detailPath = origin + '/api/orchestration/threads/' + previous.native.threadId;
  const readProjection = async () => {
    const response = await context.request.get(detailPath, { headers }); assert.equal(response.status(), 200); return (await response.json()).projection;
  };
  const before = await readProjection();
  const nativeRef = before.providerThreads.find(p => p.driver === 'codex').nativeThreadRef.nativeId;
  const route = await nativeRouteMetadata(binary, cwd, env, undefined, nativeRef);
  assert.equal(route.routeVerified, true); assert.equal(route.nativeExecution.modelProvider, 'openai'); assert.equal(route.nativeExecution.cwd, cwd);
  step('restart-persisted-state', { oldProcessExited: true, freshProcess: child.pid !== previous.server.pid,
    persistedCompletedRuns: before.runs.filter(r => r.status === 'completed').length, nativeProvider: route.nativeExecution.modelProvider,
    cwd, checkpointReady: before.checkpoints.some(p => p.status === 'ready'), quotaFreshAndMapped: true });
  const page = await context.newPage();
  await page.goto(origin + '/', { waitUntil: 'networkidle' });
  const session = page.locator('a.studio-session-item[href$="/' + previous.native.threadId + '"]');
  await session.click(); await page.waitForTimeout(1000);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('[contenteditable=true]').count(), 1);
  if (!restoreOnly) {
  const prompt = 'Read only marker.txt in this owned workspace and reply exactly STUDIO_RESUME_VERIFIED. Do not edit files, inspect home directories, credentials or unrelated paths, commit, or contact network endpoints. Automated browsers must explicitly be headless:true/True; PWDEBUG=0 and PLAYWRIGHT_HTML_OPEN=never.';
  await page.locator('[contenteditable=true]').fill(prompt);
  const send = page.getByRole('button', { name: 'Submit message', exact: true }); assert.equal(await send.isEnabled(), true);
  const started = Date.now(); await send.click(); receipt.providerTurns++;
  let after;
  for (let i = 0; i < 75; i++) {
    await page.waitForTimeout(2000); after = await readProjection();
    assert.equal(after.runtimeRequests.some(r => r.status === 'pending'), false, 'Unexpected requests require bounded inspection');
    const run = after.runs.at(-1);
    if (after.runs.length > before.runs.length && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) break;
  }
  assert.equal(after.runs.length, before.runs.length + 1); assert.equal(after.runs.at(-1).status, 'completed');
  assert.equal(after.providerThreads.find(p => p.driver === 'codex').nativeThreadRef.nativeId, nativeRef);
  assert.equal(after.providerThreads.length, before.providerThreads.length);
  assert.equal(after.thread.providerInstanceId, 'codex'); assert.equal(after.thread.worktreePath, cwd);
  assert.equal(readFileSync(join(cwd, 'marker.txt'), 'utf8'), 'studio-native-completed\n');
  assert.ok(await page.getByText('STUDIO_RESUME_VERIFIED', { exact: true }).count());
  receipt.native = safeProjection(after); save();
  step('real-compatible-resume', { status: 'completed', elapsedMs: Date.now() - started, sameNativeReference: true,
    sameProviderInstance: true, sameWorkspace: true, additionalProviderThread: false, markerUnchanged: true });
  const resumedShot = join(reportDir, 'real-native-resumed-after-restart.png');
  await page.screenshot({ path: resumedShot }); receipt.screenshots.push({ path: resumedShot, evidenceKind: 'real-native-resume' }); save();
  }
  const liveUserMessages = projection => projection.messages.filter(m => m.role === 'user' &&
    (m.runId === null || projection.runs.find(r => r.id === m.runId)?.status !== 'rolled_back'));
  if (liveUserMessages(await readProjection()).length > 0) {
    await page.getByRole('button', { name: 'Edit from here', exact: true }).first().click();
    await page.getByRole('button', { name: 'Revert files too', exact: true }).click();
  }
  for (let i = 0; i < 30 && readFileSync(join(cwd, 'marker.txt'), 'utf8') !== 'studio-baseline\n'; i++) await page.waitForTimeout(500);
  assert.equal(readFileSync(join(cwd, 'marker.txt'), 'utf8'), 'studio-baseline\n');
  const restoredHash = createHash('sha256').update(readFileSync(join(cwd, 'marker.txt'))).digest('hex');
  assert.equal(restoredHash, previous.fixture.baselineHash);
  assert.equal(spawnSync('git', ['diff', '--name-only'], { cwd, encoding: 'utf8' }).stdout.trim(), '');
  let restored;
  for (let i = 0; i < 30; i++) {
    restored = await readProjection();
    if (liveUserMessages(restored).length === 0) break;
    await page.waitForTimeout(500);
  }
  assert.equal(liveUserMessages(restored).length, 0, 'Published active history must finish rewinding before stopping the server');
  assert.equal(restored.thread.worktreePath, cwd); assert.equal(restored.thread.providerInstanceId, 'codex');
  const nativeRestored = await nativeRouteMetadata(binary, cwd, env, undefined, nativeRef);
  assert.equal(nativeRestored.nativeExecution.observedTurnCount, 0); assert.equal(nativeRestored.nativeExecution.moreTurns, false);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByRole('button', { name: 'Edit from here', exact: true }).count(), 0);
  step('real-native-gui-checkpoint-restore', { restoredHash, baselineHashMatched: true, trackedChanges: 0,
    actualWorkspace: cwd, projectRootUnchanged: readFileSync(join(previous.fixture.path, 'marker.txt'), 'utf8') === 'studio-baseline\n',
    providerAffinityPreserved: true, activeAppUserMessages: 0, historicalMessagesRetained: restored.messages.length,
    nativeHistoryTurns: 0, reloadedUiHistoryRewound: true,
    control: 'Edit from here → Revert files too' });
  const restoreShot = join(reportDir, 'real-native-checkpoint-restored.png');
  await page.screenshot({ path: restoreShot }); receipt.screenshots.push({ path: restoreShot, evidenceKind: 'real-native-gui-restore' }); save();
  await context.close();
} catch (error) {
  receipt.failure = { kind: error.name, lastCompletedStep:receipt.steps.at(-1)?.name??null,
    timedOut:error.name==='TimeoutError',assertionOperator:error.operator??null }; save();
  throw new Error('Owned native continuity verification failed; sanitized receipt retained.');
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) {
    child.kill('SIGTERM'); await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 7000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  privateOutput = ''; receipt.server.stoppedAt = new Date().toISOString(); receipt.server.exitCode = child.exitCode; save();
}
