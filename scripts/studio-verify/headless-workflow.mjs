import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import net from 'node:net';
import { serverRpc, nativeRouteMetadata, safeProjection } from './native-proof.mjs';
import { verifyLayouts, verifyNotifications, verifyScopedAuth } from './ui-acceptance.mjs';

assert.ok(process.versions.node.startsWith('22.'), 'Run with an absolute Node22 executable');
process.env.PWDEBUG='0'; process.env.PLAYWRIGHT_HTML_OPEN='never';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const reportDir = resolve(option('--report-dir', join(root, 'reports/studio-verification/headless')));
const stateDir = resolve(option('--state-dir', join(homedir(), '.local/share/specweave-studio/verification/0885-t05')));
const port = Number(option('--port', '8420'));
assert.equal(port, 8420, 'Only the dedicated T05 loopback port is allowed');
mkdirSync(reportDir, { recursive: true, mode: 0o700 });
mkdirSync(stateDir, { recursive: true, mode: 0o700 }); chmodSync(stateDir, 0o700);
const codexBinary = option('--codex-binary', null);
if(args.includes('--native'))assert.ok(codexBinary,'A real native proof requires the explicitly verified official binary');
if (codexBinary) {
  assert.ok(existsSync(codexBinary), 'The explicit official Codex binary must exist');
  assert.equal(spawnSync(codexBinary, ['--version'], { encoding: 'utf8' }).stdout.trim(), 'codex-cli 0.160.1');
  mkdirSync(join(stateDir, 'userdata'), { recursive: true, mode: 0o700 });
  const settingsPath = join(stateDir, 'userdata/settings.json');
  if (!existsSync(settingsPath)) writeFileSync(settingsPath, JSON.stringify({ defaultThreadEnvMode: 'worktree', newWorktreesStartFromOrigin: false, providerInstances: { codex: { driver: 'codex', enabled: true, config: { setupMode: 'existing', binaryPath: codexBinary } } } }, null, 2), { mode: 0o600 });
}
const source = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
const receipt = { source, observedAt: new Date().toISOString(), runtime: process.version, node: process.execPath,
  browser: { headless: true, PWDEBUG: '0', PLAYWRIGHT_HTML_OPEN: 'never', reporterOpen: 'never' },
  evidenceKind: 'real-isolated-server', port, steps: [], screenshots: [], providerTurns: 0 };
function save() { writeFileSync(join(reportDir, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 }); }
function step(name, result) { receipt.steps.push({ name, ...result }); save(); console.log(JSON.stringify({ name, ...result })); }
await new Promise((resolvePort, reject) => { const socket = net.createServer(); socket.once('error', () => reject(new Error('Dedicated port is already in use; preserve owner'))); socket.listen(port, '127.0.0.1', () => socket.close(resolvePort)); });
const origin = 'http://127.0.0.1:' + port;
const env = { ...process.env, PATH: dirname(process.execPath) + ':' + join(homedir(), '.local/share/specweave/providers/bin') + ':' + process.env.PATH,
  PWDEBUG: '0', PLAYWRIGHT_HTML_OPEN: 'never' };
const entrypoint = resolve(option('--entrypoint', join(root, 'apps/server/dist/bin.mjs')));
receipt.entrypoint = entrypoint;
const child = spawn(process.execPath, [entrypoint, 'serve', '--host', '127.0.0.1', '--port', String(port), '--base-dir', stateDir, '--no-browser'], { cwd: stateDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
receipt.server = { pid: child.pid, startedAt: new Date().toISOString(), baseDir: stateDir, stoppedAt: null };
let privateOutput = ''; let browser;
try {
  const credential = await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(new Error('Private server startup timed out; output omitted for credential privacy')), 45000);
    const inspect = chunk => { privateOutput += chunk.toString(); const match = privateOutput.match(/(?:^|\n)Token: ([^\s]+)/); if (match) { clearTimeout(timer); ready(match[1]); } };
    child.stdout.on('data', inspect); child.stderr.on('data', inspect);
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Private server exited during startup: ' + code)); });
  });
  step('server-start', { ready: true, pid: child.pid });
  // Startup token/QR stay in memory and are never written to artifacts or browser URLs.
  const dependencyRoot = option('--browser-deps', join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules'));
  const { chromium } = createRequire(import.meta.url)(join(dependencyRoot, 'playwright'));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
  const response = await context.request.post(origin + '/api/auth/browser-session', { data: { credential }, headers: { Origin: origin } });
  assert.equal(response.status(), 200, 'Real browser-session exchange must succeed');
  step('browser-auth', { status: response.status() });
  if (codexBinary) {
    const settings = await serverRpc(context, origin, 'server.getSettings');
    assert.equal(settings.providerInstances.codex.config.binaryPath, codexBinary);
    step('effective-private-settings', { defaultThreadEnvMode: settings.defaultThreadEnvMode, nativeVersion: '0.160.1', setupMode: settings.providerInstances.codex.config.setupMode });
    if (args.includes('--native')) {
      let native;
      for (let attempt = 0; attempt < 15; attempt++) {
        native = (await serverRpc(context, origin, 'server.getConfig')).providers.find(p => p.instanceId === 'codex');
        if (native?.status === 'ready' && native?.auth.status === 'authenticated') break;
        await new Promise(done => setTimeout(done, 2000));
      }
      step('native-provider-observation', { instanceId: native?.instanceId, status: native?.status, authStatus: native?.auth.status, version: native?.version, installed: native?.installed, enabled: native?.enabled, modelCount: native?.models.length });
      assert.equal(native?.version, '0.160.1'); assert.equal(native?.status, 'ready'); assert.equal(native?.auth.status, 'authenticated');
      const refreshed = await context.request.post(origin + '/api/studio/capacity/refresh', { headers: { Origin: origin }, data: {} });
      assert.equal(refreshed.status(), 200);
      const snapshot = await refreshed.json();
      const account = snapshot.accounts.find(a => a.id === 'codex-1');
      step('explicit-capacity-refresh', { status: refreshed.status(), codexStatus: account?.status, mapped: account?.providerInstanceId === 'codex', authenticated: account?.authenticated, authError: account?.authError, quotaFreshness: account?.quota.freshness });
      assert.equal(account?.status, 'ready'); assert.equal(account?.providerInstanceId, 'codex');
    }
  }
  const unauth = await browser.newContext();
  assert.equal((await unauth.request.get(origin + '/api/studio/capacity')).status(), 401);
  await unauth.close(); step('anonymous-capacity-denied', { status: 401 });
  const headers = { 'x-studio-orchestration-protocol': '2' };
  const shell = await context.request.get(origin + '/api/orchestration/shell', { headers });
  step('initial-shell', { status: shell.status(), keys: shell.ok() ? Object.keys(await shell.json()) : [] });
  const initialShell = await context.request.get(origin + '/api/orchestration/shell', { headers });
  assert.equal(initialShell.status(), 200);
  const initialSnapshot = await initialShell.json();
  step('empty-session-count', { count: initialSnapshot.threads?.length ?? initialSnapshot.threadShells?.length ?? null });
  let fixture;
  if (args.includes('--fixture')) {
    fixture = join(stateDir, 't05-owned-fixture');
    if (!existsSync(join(fixture, '.git'))) {
      mkdirSync(fixture, { mode: 0o700 });
      writeFileSync(join(fixture, 'marker.txt'), 'studio-baseline\n');
      writeFileSync(join(fixture, 'README.md'), '# Studio T05 owned verification fixture\nOnly marker.txt may be edited by the bounded native task.\n');
      writeFileSync(join(fixture, 'AGENTS.md'), '# Owned test fixture\nAll automated browsers must explicitly use headless:true or headless=True. PWDEBUG=0; PLAYWRIGHT_HTML_OPEN=never. Only change marker.txt as asked. Do not inspect credentials, home-directory content, network endpoints or unrelated paths.\n');
      for (const gitArgs of [['init', '-b', 'feature/studio-t05'], ['add', 'marker.txt', 'README.md', 'AGENTS.md'], ['-c', 'user.name=Studio Verification', '-c', 'user.email=verification@example.invalid', 'commit', '-m', 'Owned native workflow baseline']]) {
        assert.equal(spawnSync('git', gitArgs, { cwd: fixture, encoding: 'utf8' }).status, 0);
      }
    }
    const projectsResponse = await context.request.get(origin + '/api/projects');
    assert.equal(projectsResponse.status(), 200);
    const projects = (await projectsResponse.json()).projects;
    let project = projects.find(p => p.workspaceRoot === fixture);
    if (!project) {
      const create = await context.request.post(origin + '/api/projects/mutate', { headers: { Origin: origin }, data: {
        type: 'project.create', commandId: randomUUID(), projectId: randomUUID(), title: 'T05 owned native fixture', workspaceRoot: fixture,
        defaultModelSelection: { instanceId: 'codex', model: 'gpt-5.4' }
      } });
      assert.equal(create.status(), 200); project = await create.json();
      const update = await context.request.post(origin + '/api/projects/mutate', { headers: { Origin: origin }, data: {
        type: 'project.update', commandId: randomUUID(), projectId: project.id, defaultThreadEnvMode: 'worktree', defaultModelSelection: { instanceId: 'codex', model: 'gpt-5.4' }
      } });
      assert.equal(update.status(), 200); project = await update.json();
    }
    receipt.fixture = { projectId: project.id, path: fixture, mode: project.defaultThreadEnvMode,
      baseSha: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture, encoding: 'utf8' }).stdout.trim(),
      baselineHash: createHash('sha256').update(readFileSync(join(fixture, 'marker.txt'))).digest('hex') };
    step('fixture-project', { mode: project.defaultThreadEnvMode, instanceId: project.defaultModelSelection?.instanceId, model: project.defaultModelSelection?.model });
  }
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', () => pageErrors.push('browser-runtime-error')); // Never save arbitrary exception text.
  await page.goto(origin + '/', { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(1500);
  step('first-route', { path: new URL(page.url()).pathname, headings: await page.locator('h1,h2').allTextContents(),
    buttons: await page.getByRole('button').allTextContents(), pageErrors });
  if (args.includes('--onboard')) {
    for (let i = 0; i < 2; i++) { const next = page.getByRole('button', { name: 'Continue', exact: true }); if (await next.count()) { await next.click(); await page.waitForTimeout(400); } }
    const skip = page.getByRole('button', { name: 'Do not import projects', exact: true });
    if (await skip.count()) { await skip.click(); await page.waitForTimeout(1200); }
    step('onboarding', { path: new URL(page.url()).pathname, headings: await page.locator('h1,h2').allTextContents(),
      buttons: await page.getByRole('button').allTextContents() });
  }
  assert.equal(new URL(page.url()).hash, '', 'Screenshots cannot contain pairing URLs');
  const screenshot = join(reportDir, 'first-authenticated-start-state-desktop-light.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  receipt.screenshots.push({ path: screenshot, width: 1440, height: 1000, theme: 'light', reducedMotion: true, evidenceKind: 'real-isolated-start-state', initialThreadCount: initialSnapshot.threads.length }); save();
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismiss.count()) { await dismiss.first().click(); await page.waitForTimeout(300); }
  const cleanShot = join(reportDir, 'authenticated-overview-dismissed-notification.png');
  await page.screenshot({ path: cleanShot, fullPage: true }); receipt.screenshots.push({ path: cleanShot, evidenceKind: 'real-isolated-clean-overview' }); save();
  const capacity = await context.request.get(origin + '/api/studio/capacity');
  const dto = capacity.ok() ? await capacity.json() : null;
  step('real-capacity-read', { status: capacity.status(), available: dto?.available ?? false,
    accountStates: dto?.accounts?.map(a => ({ id: a.id, provider: a.provider, status: a.status, mapped: a.providerInstanceId !== null })) ?? [] });
  if (args.includes('--scoped-auth')) await verifyScopedAuth({ browser, context, origin, step });
  if (args.includes('--notifications')) await verifyNotifications({ browser, context, origin, reportDir, receipt, step, save });
  if (args.includes('--visual')) await verifyLayouts({ context, page, origin, reportDir, receipt, step, save });
  if (args.includes('--fixture')) {
    const newSession = args.includes('--native')
      ? page.getByRole('button', { name: 'Draft using capacity policy', exact: true }).first()
      : page.getByRole('button', { name: 'New session', exact: true }).first();
    await newSession.click();
    const options = await page.locator('#studio-project option').evaluateAll(nodes => nodes.map(n => ({ value: n.value, label: n.textContent })));
    step('project-choices', { options });
    const chosen = options.find(o => o.value.endsWith(':' + receipt.fixture.projectId));
    assert.ok(chosen, 'The registered owned project must be offered by the live chooser');
    await page.locator('#studio-project').selectOption(chosen.value);
    await page.waitForTimeout(200);
    const openChosen = page.locator('.studio-draft-chooser').getByRole('button', { name: 'Open native draft', exact: true });
    step('project-selected', { value: await page.locator('#studio-project').inputValue(), enabled: await openChosen.isEnabled() });
    await openChosen.click();
    await page.waitForTimeout(1200);
    step('native-draft-controls', { path: new URL(page.url()).pathname, buttons: await page.getByRole('button').allTextContents(),
      editableCount: await page.locator('[contenteditable=true]').count(), textareas: await page.locator('textarea').count() });
    if(args.includes('--branch-diagnostic')){
      const trigger=page.locator('[data-thread-panel-run-context] button').filter({hasText:/Select ref|codex\/studio-t05/});
      step('base-ref-trigger-diagnostic',{count:await trigger.count(),panelControls:await page.locator('[data-thread-panel-run-context] button').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,role:n.getAttribute('role'),slot:n.getAttribute('data-slot'),disabled:n.disabled})))});
      await trigger.click();
      await page.getByRole('option').filter({hasText:'feature/studio-t05'}).waitFor();
      step('base-ref-popup-diagnostic',{switches:await page.getByRole('switch').count(),options:await page.getByRole('option').allTextContents()});
      const origin=page.locator('[data-slot=combobox-popup]').getByRole('switch');
      const switchVisible=await origin.count()===1;
      if(switchVisible){const before=await origin.getAttribute('aria-checked')==='true';
        if(!before)await origin.click();
        assert.equal(await origin.getAttribute('aria-checked'),'true');await origin.click();
        assert.equal(await origin.getAttribute('aria-checked'),'false');}
      step('origin-control-observation',{switchVisible,ownedServerDefaultStartFromOrigin:false});
      await page.getByRole('option').filter({hasText:'feature/studio-t05'}).click();
      const draftId=new URL(page.url()).pathname.split('/').at(-1);
      await page.waitForFunction(id=>JSON.parse(localStorage.getItem('studio:composer-drafts:v1')??'null')?.state?.draftThreadsByThreadKey?.[id]?.startFromOrigin===false,draftId);
      const draft=await page.evaluate(id=>{const d=JSON.parse(localStorage.getItem('studio:composer-drafts:v1')).state.draftThreadsByThreadKey[id];return {branch:d.branch,startFromOrigin:d.startFromOrigin,envMode:d.envMode,environmentSelection:d.environmentSelection};},draftId);
      assert.equal(draft.branch,'feature/studio-t05');assert.equal(draft.envMode,'worktree');
      step('real-native-base-ref-controls-no-inference',{...draft,providerTurns:0,originSwitchRoundtrip:switchVisible});
    }
    if (args.includes('--native')) {
      assert.ok(codexBinary, 'Native proof requires the reviewed explicit official binary');
      const originalRoute = await nativeRouteMetadata(codexBinary, fixture, env);
      assert.ok(originalRoute.modelProvider === null || originalRoute.modelProvider === 'openai'); assert.equal(originalRoute.routeVerified, true);
      step('fixture-native-route', originalRoute);
      // A deliberate standard workspace-write mode for this owned fixture, never full access.
      await page.getByRole('combobox', { name: 'Runtime mode', exact: true }).click();
      await page.getByRole('option', { name: /Auto-accept edits/ }).click();
      step('explicit-native-runtime-mode', { mode: 'auto-accept-edits', sandbox: 'workspaceWrite', approvalPolicy: 'on-request', permissionBypass: false });
      const prompt = 'In this owned verification repository, change only marker.txt from studio-baseline to studio-native-completed followed by one newline. Read AGENTS.md if needed. Do not inspect home directories, credentials, other projects or network endpoints. Do not commit. Report the single file changed. Any automated browser must explicitly be headless:true/True; PWDEBUG=0 and PLAYWRIGHT_HTML_OPEN=never.';
      await page.locator('[contenteditable=true]').fill(prompt);
      const send = page.getByRole('button', { name: 'Submit message', exact: true });
      assert.equal(await send.isEnabled(), true, 'Standard native guards must admit this bounded task');
      const started = Date.now();
      await send.click(); receipt.providerTurns++;
      let projection;
      for (let i = 0; i < 90; i++) {
        await page.waitForTimeout(2000);
        const shellResponse = await context.request.get(origin + '/api/orchestration/shell', { headers });
        const liveShell = await shellResponse.json();
        const thread = liveShell.threads.find(t => t.projectId === receipt.fixture.projectId);
        if (!thread) continue;
        const detail = await context.request.get(origin + '/api/orchestration/threads/' + thread.id, { headers });
        if (!detail.ok()) continue;
        projection = (await detail.json()).projection;
        const latest = projection.runs.at(-1);
        if (projection.runtimeRequests.some(r => r.status === 'pending')) {
          step('native-approval-observed', { kinds: projection.runtimeRequests.filter(r => r.status === 'pending').map(r => r.kind), buttons: await page.getByRole('button').allTextContents() });
          throw new Error('Native approval needs bounded request inspection before acceptance');
        }
        if (latest && ['completed', 'failed', 'cancelled', 'interrupted'].includes(latest.status)) break;
      }
      assert.ok(projection, 'A real native thread must persist');
      receipt.native = safeProjection(projection); save();
      step('native-terminal', { status: projection.runs.at(-1)?.status, elapsedMs: Date.now() - started,
        threadId: projection.thread.id, runId: projection.runs.at(-1)?.id, cwd: projection.thread.worktreePath });
      assert.equal(projection.runs.at(-1)?.status, 'completed');
      const cwd = projection.thread.worktreePath;
      assert.ok(cwd && cwd.startsWith(stateDir + '/'), 'Execution must use an owned worktree');
      const nativeId = projection.providerThreads.find(p => p.driver === 'codex')?.nativeThreadRef?.nativeId;
      assert.ok(nativeId, 'A supported native thread reference must persist');
      const route = await nativeRouteMetadata(codexBinary, cwd, env, undefined, nativeId);
      assert.equal(route.nativeExecution.modelProvider, 'openai'); assert.equal(route.nativeExecution.cwd, cwd);
      assert.equal(route.routeVerified, true); receipt.nativeRoute = route;
      assert.equal(readFileSync(join(cwd, 'marker.txt'), 'utf8'), 'studio-native-completed\n');
      assert.equal(readFileSync(join(fixture, 'marker.txt'), 'utf8'), 'studio-baseline\n');
      receipt.hashes = { projectRoot: createHash('sha256').update(readFileSync(join(fixture, 'marker.txt'))).digest('hex'),
        completed: createHash('sha256').update(readFileSync(join(cwd, 'marker.txt'))).digest('hex') };
      assert.ok(projection.checkpoints.some(c => c.status === 'ready'), 'A real native checkpoint must be ready'); save();
    }
    const shot = join(reportDir, 'actual-owned-native-draft.png');
    await page.screenshot({ path: shot, fullPage: true });
    receipt.screenshots.push({ path: shot, evidenceKind: args.includes('--native') ? 'real-isolated-native-terminal' : 'real-isolated-native-draft-no-turn' }); save();
  }
  assert.equal(pageErrors.length, 0);
  await context.close();
} catch (error) {
  receipt.failure = { kind: error.name, lastCompletedStep:receipt.steps.at(-1)?.name??null,
    timedOut:error.name==='TimeoutError',assertionOperator:error.operator??null }; save();
  throw new Error('Owned headless verification failed; sanitized receipt retained.');
} finally {
  if (browser) await browser.close();
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 7000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  receipt.server.stoppedAt = new Date().toISOString(); receipt.server.exitCode = child.exitCode; privateOutput = ''; save();
}
