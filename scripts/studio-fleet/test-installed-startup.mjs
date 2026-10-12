import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fleetSshTargets } from './fleet-hosts.mjs';

assert.equal(process.version, 'v22.20.0');
assert.equal(process.env.PWDEBUG, '0'); assert.equal(process.env.PLAYWRIGHT_HTML_OPEN, 'never');
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); assert.ok(i >= 0 && args[i + 1]); return args[i + 1]; };
const directory = resolve(option('--report-dir')), archiveSha256 = option('--artifact-sha'), sourceCommit = option('--source-commit');
assert.match(archiveSha256, /^[a-f0-9]{64}$/); assert.match(sourceCommit, /^[a-f0-9]{40}$/);
const fleet = JSON.parse(readFileSync(resolve(option('--fleet-proof')), 'utf8'));
mkdirSync(directory, { recursive: true, mode: 0o700 });
const ssh = ['-F', '/dev/null', '-i', join(homedir(), '.local/share/specweave/fleet/id_ed25519'), '-o', 'IdentitiesOnly=yes',
  '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile=' + join(homedir(), '.local/share/specweave/fleet/known_hosts'),
  '-o', 'ConnectTimeout=5', '-o', 'ControlMaster=no'];
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const workers = fleetSshTargets();
const hosts = [{ id: 'm4', origin: 'http://127.0.0.1:8319' },
  { id: 'm1', origin: 'http://127.0.0.1:18319', ssh: workers.m1 },
  { id: 'm3', origin: 'http://127.0.0.1:28319', ssh: workers.m3 }];
function cli(host, command) {
  const result = host.ssh ? spawnSync('/usr/bin/ssh', [...ssh, host.ssh, '"$HOME/.local/bin/specweave-studio" ' + command.map(quote).join(' ')], { encoding: 'utf8', timeout: 20000 })
    : spawnSync(join(homedir(), '.local/bin/specweave-studio'), command, { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, 'Installed owned CLI operation failed; private output withheld'); return result.stdout;
}
const fingerprint = list => createHash('sha256').update(JSON.stringify(list.map(item => item.id ?? item.sessionId).sort())).digest('hex');
const shellIds = shell => ({ projects: shell.projects.map(p => p.id).sort(), threads: shell.threads.map(t => t.id).sort() });
const protocolHeaders = { 'x-studio-orchestration-protocol': '2' };
const delay = ms => new Promise(done => setTimeout(done, ms));
async function welcome(context, origin) {
  const response = await context.request.post(origin + '/api/auth/websocket-ticket', { headers: { Origin: origin } });
  assert.equal(response.status(), 200); const { ticket } = await response.json();
  const url = new URL(origin); url.protocol = 'ws:'; url.pathname = '/ws'; url.searchParams.set('wsTicket', ticket); url.searchParams.set('orchestrationProtocol', '2');
  return await new Promise((done, reject) => {
    const ws = new WebSocket(url), timeout = setTimeout(() => { ws.close(); reject(new Error('Owned welcome readback timed out')); }, 15000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ _tag: 'Request', id: '1', tag: 'subscribeServerLifecycle', payload: {}, headers: [] })));
    ws.addEventListener('error', () => { clearTimeout(timeout); ws.close(); reject(new Error('Owned welcome transport failed')); });
    ws.addEventListener('message', event => {
      let items; try { const value = JSON.parse(event.data); items = Array.isArray(value) ? value : [value]; } catch { return; }
      for (const item of items) for (const value of item.values ?? []) if (value.type === 'welcome') {
        clearTimeout(timeout); ws.close(); done({ bootstrapProjectPresent: value.payload.bootstrapProjectId != null, bootstrapThreadPresent: value.payload.bootstrapThreadId != null });
      }
    });
  });
}
const { chromium } = createRequire(import.meta.url)(join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
const browser = await chromium.launch({ headless: true });
const proof = { artifactSha256: archiveSha256, artifactSourceCommit: sourceCommit, node: process.execPath, version: process.version,
  browserHeadless: true, inferenceExecuted: false, nativeAuthActions: false, hosts: [] };
const save = () => writeFileSync(join(directory, 'receipt.json'), JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
try {
  for (const host of hosts) {
    proof.currentHost = host.id; proof.phase = 'installed-provenance'; save();
    const installed = fleet.hosts[host.id].finalSnapshot;
    assert.equal(installed.archiveSha256, archiveSha256); assert.equal(installed.artifactSourceCommit, sourceCommit);
    const pairingBefore = JSON.parse(cli(host, ['auth', 'pairing', 'list', '--json']));
    const sessionsBefore = JSON.parse(cli(host, ['auth', 'session', 'list', '--json']));
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(15000); context.setDefaultNavigationTimeout(15000);
    let grant, page, ownedSessionIds = [];
    try {
      const unauthenticated = await context.request.get(host.origin + '/api/studio/capacity'); assert.equal(unauthenticated.status(), 401);
      proof.phase = 'one-time-pairing'; save();
      grant = JSON.parse(cli(host, ['auth', 'pairing', 'create', '--ttl', '5m', '--label', '0885 T15 owned startup ' + randomUUID(), '--base-url', host.origin, '--scope', 'orchestration:read', '--json']));
      page = await context.newPage(); await page.goto(grant.pairUrl, { waitUntil: 'domcontentloaded' });
      let paired = false;
      for (let i = 0; i < 100; i++) { paired = (await context.cookies(host.origin)).some(cookie => cookie.name === installed.cookieName) && new URL(page.url()).hash === ''; if (paired) break; await delay(100); }
      assert.ok(paired); assert.equal(new URL(page.url()).hash, ''); grant.credential = ''; grant.pairUrl = '';
      const previousSessionIds = new Set(sessionsBefore.map(session => session.sessionId));
      const newSessions = JSON.parse(cli(host, ['auth', 'session', 'list', '--json'])).filter(session => !previousSessionIds.has(session.sessionId));
      assert.equal(newSessions.length, 1, 'Owned pairing must create exactly one new browser session');
      ownedSessionIds = newSessions.map(session => session.sessionId);
      proof.phase = 'authenticated-shell-status'; save();
      const beforeResponse = await context.request.get(host.origin + '/api/orchestration/shell', { headers: protocolHeaders }); proof.shellStatus = beforeResponse.status(); save(); assert.equal(beforeResponse.status(), 200);
      const before = shellIds(await beforeResponse.json());
      proof.phase = 'installed-shell-ids'; proof.shellCounts = { expectedProjects: installed.rows.projectIds.length, actualProjects: before.projects.length, expectedThreads: installed.rows.threadIds.length, actualThreads: before.threads.length }; save();
      assert.deepEqual(before.projects, installed.rows.projectIds); assert.deepEqual(before.threads, installed.rows.threadIds);
      proof.phase = 'welcome'; save();
      const event = await welcome(context, host.origin); assert.deepEqual(event, { bootstrapProjectPresent: false, bootstrapThreadPresent: false });
      proof.phase = 'overview'; save();
      await page.locator('#studio-heading').waitFor({ state: 'visible' }); assert.equal(new URL(page.url()).pathname, '/');
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#studio-heading').waitFor({ state: 'visible' });
      assert.equal(new URL(page.url()).pathname, '/'); assert.equal(new URL(page.url()).hash, '');
      proof.phase = 'connected-overview'; save();
      await page.getByText('Authenticated connection', { exact: true }).first().waitFor({ state: 'visible' });
      const afterResponse = await context.request.get(host.origin + '/api/orchestration/shell', { headers: protocolHeaders }); assert.equal(afterResponse.status(), 200);
      const after = shellIds(await afterResponse.json()); assert.deepEqual(after, before);
      await page.screenshot({ path: join(directory, host.id + '-installed-overview.png'), fullPage: true });
      proof.hosts.push({ identity: host.id, origin: host.origin, servicePid: installed.servicePid, cookieName: installed.cookieName,
        existingProjectIds: before.projects, existingThreadIds: before.threads, shellIdsPreserved: true, welcome: event,
        rootAndReloadOverview: true, connectedOverview: true, unauthenticatedCapacity: 401, authenticatedShell: 200, oneTimePairingUi: true, tokenClearedBeforeCapture: true });
    } catch (error) { proof.failedStage = proof.phase; proof.failedPath = page ? new URL(page.url()).pathname : null; throw error; }
    finally {
      proof.phase = 'own-grant-cleanup'; save();
      if (grant?.id) {
        cli(host, ['auth', 'pairing', 'revoke', grant.id]);
      }
      for (const id of ownedSessionIds) cli(host, ['auth', 'session', 'revoke', id]);
      await context.close();
      assert.equal(fingerprint(JSON.parse(cli(host, ['auth', 'pairing', 'list', '--json']))), fingerprint(pairingBefore));
      assert.equal(fingerprint(JSON.parse(cli(host, ['auth', 'session', 'list', '--json']))), fingerprint(sessionsBefore));
      const result = proof.hosts.find(item => item.identity === host.id); if (result) result.ownedGrantsAndSessionsRevoked = true;
    }
  }
  proof.result = 'passed';
} catch (error) { proof.result = 'failed'; proof.errorType = error.name; throw new Error('Installed startup acceptance failed; sanitized receipt retained'); }
finally { await browser.close(); save(); }
console.log(JSON.stringify({ result: proof.result, hosts: proof.hosts.length, browserHeadless: true, report: join(directory, 'receipt.json') }));
