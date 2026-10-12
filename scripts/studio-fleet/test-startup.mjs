import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

assert.equal(process.version, 'v22.20.0');
assert.equal(process.env.PWDEBUG, '0'); assert.equal(process.env.PLAYWRIGHT_HTML_OPEN, 'never');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); assert.ok(i >= 0 && args[i + 1]); return resolve(args[i + 1]); };
const entrypoint = option('--entrypoint'), reportDir = option('--report-dir');
const wrapperIndex = args.indexOf('--cli-wrapper');
const wrapper = wrapperIndex >= 0 ? resolve(args[wrapperIndex + 1]) : null;
mkdirSync(reportDir, { recursive: true, mode: 0o700 });
const { chromium } = createRequire(import.meta.url)(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const browser = await chromium.launch({ headless: true });
const proof = { node: process.execPath, version: process.version, entrypoint, cliWrapper: wrapper, browserHeadless: true, inferenceExecuted: false, allNativeProvidersDisabled: true, cases: [] };
const save = phase => { proof.phase = phase; writeFileSync(join(reportDir, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 }); };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function freePort() {
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
function cli(args, env) {
  const call = spawnSync(wrapper ?? process.execPath, [...(wrapper ? [] : [entrypoint]), ...args, '--base-dir', env.STUDIO_HOME], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(call.status, 0, 'Owned CLI operation failed; private output withheld'); return call.stdout;
}
async function welcome(context, origin) {
  const response = await context.request.post(origin + '/api/auth/websocket-ticket', { headers: { Origin: origin } });
  assert.equal(response.status(), 200); const { ticket } = await response.json();
  const url = new URL(origin); url.protocol = 'ws:'; url.pathname = '/ws'; url.searchParams.set('wsTicket', ticket); url.searchParams.set('orchestrationProtocol', '2');
  return await new Promise((done, reject) => {
    const ws = new WebSocket(url); const timer = setTimeout(() => { ws.close(); reject(new Error('Owned welcome observation timed out')); }, 15000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'subscribeServerLifecycle', payload: {}, headers: [] })));
    ws.addEventListener('error', () => { clearTimeout(timer); ws.close(); reject(new Error('Owned welcome observation transport failed')); });
    ws.addEventListener('message', event => {
      let items; try { const value = JSON.parse(event.data); items = Array.isArray(value) ? value : [value]; } catch { return; }
      for (const item of items) for (const value of item.values ?? []) if (value.type === 'welcome') {
        clearTimeout(timer); ws.close(); done({ bootstrapProjectPresent: value.payload.bootstrapProjectId != null, bootstrapThreadPresent: value.payload.bootstrapThreadId != null });
      }
    });
  });
}
try {
  for (const test of [{ name: 'ordinary-start', envFalse: false, explicitPath: false },
    { name: 'service-bootstrap-false', envFalse: true, explicitPath: false },
    { name: 'intentional-explicit-project', envFalse: false, explicitPath: true },
    { name: 'intentional-headless-serve', envFalse: false, explicitPath: false, command: 'serve' }]) {
    const root = mkdtempSync(join(tmpdir(), 'studio-startup-owned-'));
    const home = join(root, 'state'), cwd = join(root, 'project'), userHome = join(root, 'empty-user-home'); mkdirSync(home); mkdirSync(cwd); mkdirSync(userHome);
    proof.currentCase = test.name; proof.currentRoot = root; save('setup');
    mkdirSync(join(home, 'userdata'));
    writeFileSync(join(home, 'userdata/settings.json'), JSON.stringify({ providers: Object.fromEntries(['codex','claudeAgent','cursor','grok','pi','opencode','antigravity'].map(driver => [driver, { enabled: false }])) }), { mode: 0o600 });
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    const env = { HOME: userHome, USER: process.env.USER, LOGNAME: process.env.USER, LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin',
      STUDIO_HOME: home, STUDIO_LOG_LEVEL: 'Warn', STUDIO_ENABLE_HOSTED_SERVICES: 'false', PWDEBUG: '0', PLAYWRIGHT_HTML_OPEN: 'never',
      ...(test.envFalse ? { STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: 'false' } : {}) };
    const child = spawn(wrapper ?? process.execPath, [...(wrapper ? [] : [entrypoint]), test.command ?? 'start', ...(test.explicitPath ? [cwd] : []), '--host', '127.0.0.1', '--port', String(port), '--base-dir', home, '--mode', 'web', '--no-browser'], { cwd, env, stdio: ['ignore','ignore','ignore'] });
    let context, grant, page, startupGrantIds = [], ownedSessionIds = [];
    try {
      let ready = false;
      save('server-ready');
      for (let i = 0; i < 100; i++) { try { ready = (await fetch(origin, { signal: AbortSignal.timeout(1000) })).status === 200; } catch {} if (ready) break; assert.equal(child.exitCode, null, 'Owned server exited during startup'); await delay(100); }
      assert.ok(ready, 'Owned startup server did not become ready');
      assert.equal((await fetch(origin + '/api/studio/capacity')).status, 401);
      const beforePairing = new DatabaseSync(join(home, 'userdata/statev2.sqlite'), { readOnly: true });
      const startupPairingCount = beforePairing.prepare('SELECT count(*) n FROM auth_pairing_links').get().n;
      const startupSessionCount = beforePairing.prepare('SELECT count(*) n FROM auth_sessions').get().n;
      startupGrantIds = beforePairing.prepare("SELECT id FROM auth_pairing_links WHERE subject='administrative-bootstrap' AND revoked_at IS NULL AND consumed_at IS NULL").all().map(row => row.id); beforePairing.close();
      proof.startupAuthCounts = { startupPairingCount, startupSessionCount }; save('startup-auth-count');
      assert.equal(startupPairingCount, test.command === 'serve' ? 1 : 0); assert.equal(startupSessionCount, 0);
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(15000);
      save('pairing-ui');
      grant = JSON.parse(cli(['auth','pairing','create','--ttl','5m','--label','0885 T15 isolated startup observation','--base-url',origin,'--json'], env));
      page = await context.newPage();
      await page.goto(grant.pairUrl, { waitUntil: 'domcontentloaded' });
      let paired = false;
      for (let i = 0; i < 100; i++) { paired = (await context.cookies(origin)).some(cookie => cookie.name.startsWith('studio_session_')) && new URL(page.url()).hash === ''; if (paired) break; await delay(100); }
      assert.ok(paired, 'Owned one-time browser pairing failed');
      assert.equal(new URL(page.url()).hash, '', 'Pairing token was not cleared before capture');
      grant.credential = ''; grant.pairUrl = '';
      const pairedSessions = JSON.parse(cli(['auth','session','list','--json'], env));
      assert.equal(pairedSessions.length, 1, 'Fresh owned home must have exactly one browser session');
      ownedSessionIds = pairedSessions.map(session => session.sessionId);
      save('welcome-event');
      const event = await welcome(context, origin);
      save('rows-before-onboarding');
      const db = new DatabaseSync(join(home, 'userdata/statev2.sqlite'), { readOnly: true });
      const projectCount = db.prepare('SELECT count(*) n FROM projection_projects').get().n;
      const legacyThreadCount = db.prepare('SELECT count(*) n FROM projection_threads').get().n;
      const threadCount = db.prepare('SELECT count(*) n FROM orchestration_v2_projection_threads').get().n;
      const runCount = db.prepare('SELECT count(*) n FROM orchestration_v2_projection_runs').get().n;
      const providerSessionCount = db.prepare('SELECT count(*) n FROM orchestration_v2_projection_provider_sessions').get().n; db.close();
      proof.currentCounts = { projectCount, threadCount }; save('db-count');
      assert.equal(projectCount, test.explicitPath ? 1 : 0);
      assert.equal(threadCount, test.explicitPath ? 1 : 0); assert.equal(legacyThreadCount, 0);
      assert.equal(runCount, 0); assert.equal(providerSessionCount, 0);
      assert.deepEqual(event, { bootstrapProjectPresent: test.explicitPath, bootstrapThreadPresent: test.explicitPath });
      if (!test.explicitPath) {
        save('first-run-onboarding');
        // A new browser's supported first-run wizard precedes the overview. Skip
        // imports deliberately; never seed settings or disable the product gate.
        await page.waitForURL(url => url.pathname === '/welcome', { timeout: 15000 });
        proof.initialPairedPath = new URL(page.url()).pathname; save('first-run-onboarding');
        for (let i = 0; i < 2; i++) await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByRole('button', { name: 'Do not import projects', exact: true }).click();
        save('overview');
        await page.waitForURL(url => url.pathname === '/', { timeout: 15000 });
        await page.locator('#studio-heading').waitFor({ state: 'visible' }); assert.equal(new URL(page.url()).pathname, '/');
        await page.reload({ waitUntil: 'networkidle' }); await page.locator('#studio-heading').waitFor({ state: 'visible' });
        assert.equal(new URL(page.url()).pathname, '/'); assert.equal(new URL(page.url()).hash, '');
        await page.screenshot({ path: join(reportDir, test.name + '.png'), fullPage: true });
        const afterDb = new DatabaseSync(join(home, 'userdata/statev2.sqlite'), { readOnly: true });
        assert.equal(afterDb.prepare('SELECT count(*) n FROM projection_projects').get().n, 0);
        assert.equal(afterDb.prepare('SELECT count(*) n FROM orchestration_v2_projection_threads').get().n, 0); afterDb.close();
      }
      proof.cases.push({ name: test.name, root, projectCount, threadCount, legacyThreadCount, runCount, providerSessionCount, startupPairingCount, startupSessionCount, welcome: event, explicitProjectCreated: test.explicitPath, unauthorizedCapacity: 401, oneTimePairingUi: true, tokenClearedBeforeCapture: true, overviewStable: !test.explicitPath });
    } catch (error) {
      proof.failedStage = proof.phase;
      proof.failedPath = page ? new URL(page.url()).pathname : null;
      throw error;
    } finally {
      save('owned-cleanup');
      if (grant?.id) cli(['auth','pairing','revoke',grant.id], env);
      for (const id of ownedSessionIds) cli(['auth','session','revoke',id], env);
      for (const id of startupGrantIds) cli(['auth','pairing','revoke',id], env);
      if (context) await context.close();
      const ownDb = new DatabaseSync(join(home, 'userdata/statev2.sqlite'), { readOnly: true });
      assert.equal(ownDb.prepare('SELECT count(*) n FROM auth_pairing_links WHERE revoked_at IS NULL AND consumed_at IS NULL').get().n, 0); ownDb.close();
      assert.equal(JSON.parse(cli(['auth','session','list','--json'], env)).length, 0);
      const completed = proof.cases.find(item => item.name === test.name); if (completed) completed.ownedGrantsAndSessionsRevoked = true;
      if (child.exitCode === null) child.kill('SIGTERM');
      await Promise.race([new Promise(done => child.once('exit', done)), delay(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  proof.result = 'passed';
} catch (error) { proof.result = 'failed'; proof.errorType = error.name; throw new Error('Owned startup acceptance failed; sanitized receipt retained'); }
finally { await browser.close(); writeFileSync(join(reportDir, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 }); }
console.log(JSON.stringify({ result: proof.result, cases: proof.cases.length, browserHeadless: true, report: join(reportDir, 'receipt.json') }));
