import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseOptions, resolveRuntimeRoot, toolingIdentity, openOwnedProject, nativeEnvironment, validateReview, providerSettings, catalogReceipt, buildFingerprint, cyclePrompts, syntheticAnswer, newestAcceptedContext, sanitizedFailure, linksThread } from './native-acceptance.mjs';
import { NATIVE_ORIGIN, createNativeScope, observeProjection, assertNativeRpc, nativeRpc, userDispatchReceipt } from './native-rpc.mjs';
import { APPROVAL_PLAN } from './native-approval.mjs';
const projectId = 'owned-project';
const scope = (execute = false) => createNativeScope(projectId, execute);
const now = Date.now();
const observed = { sourceCommit: 'a'.repeat(40), buildSha256: 'b'.repeat(64), sourceDirty: false, tooling: { sha256: 'f'.repeat(64) } };
const review = () => ({ schemaVersion: 2, authorization: 'six-native-project-runs-with-exact-single-use-approvals', approvalPlan: structuredClone(APPROVAL_PLAN), toolingSha256: observed.tooling.sha256, expiresAt: new Date(now + 60000).toISOString(), sourceCommit: observed.sourceCommit, buildSha256: observed.buildSha256, maxRuns: 6,
  codex: { binaryPath: '/existing/codex', binarySha256: 'c'.repeat(64), version: '0.161.0', model: 'codex-test-model' },
  claude: { binaryPath: '/existing/claude', binarySha256: 'd'.repeat(64), version: '2.1.293', model: 'claude-test-model' } });
const projection = (threadId = 'worker', runs = [{ id: 'run-1', status: 'running' }]) => ({ thread: { id: threadId, projectId }, runs, subagents: [], runtimeRequests: [], providerTurns: [], attempts: [] });
const dispatch = (commandId = 'intent-1', extra = {}) => ({ projectId, commandId, prompt: 'Do the bounded marker check.', ...extra });

test('inspection is inert by default; execution requires an explicit review and options are closed', () => {
  assert.equal(parseOptions([])['--mode'], 'inspect');
  assert.throws(() => parseOptions(['--mode', 'execute']));
  assert.throws(() => parseOptions(['--mode', 'smoke', '--review', '/file']));
  assert.throws(() => parseOptions(['--endpoint', 'https://api.example.invalid']));
  assert.throws(() => parseOptions(['--mode', 'smoke', '--mode', 'execute']));
  assert.equal(parseOptions(['--mode', 'execute', '--review', '/review'])['--review'], '/review');
});
test('runtime root is explicit, absolute and checkout-bound; tooling keeps separate source and file identity', () => {
  const ownRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  assert.equal(parseOptions(['--runtime-root', ownRoot])['--runtime-root'], ownRoot);
  assert.throws(() => parseOptions(['--runtime-root', './relative']));
  assert.throws(() => parseOptions(['--runtime-root', ownRoot, '--runtime-root', ownRoot]));
  assert.equal(resolveRuntimeRoot(), ownRoot);
  assert.equal(resolveRuntimeRoot(ownRoot), ownRoot);
  assert.throws(() => resolveRuntimeRoot(join(ownRoot, 'apps/server')), /checkout root/);
  const identity = toolingIdentity();
  assert.equal(identity.root, ownRoot); assert.match(identity.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(typeof identity.sourceDirty, 'boolean'); assert.equal(identity.files.length, 7); assert.ok(identity.files.some(file => file.path === 'scripts/studio-projects/native-tool-detail.mjs'));
  assert.ok(identity.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
  assert.equal(identity.entrypointSha256, identity.files.find(file => file.path.endsWith('/native-acceptance.mjs')).sha256);
  assert.equal(identity.sha256, createHash('sha256').update(JSON.stringify(identity.files)).digest('hex'));
});
function routePage({ onboarding = 0, skip = false, href = '/projects/folder%3Aworkspace', heading = 'Owned title' } = {}) {
  const calls = [], state = { onboarding, skip, url: NATIVE_ORIGIN };
  const visible = kind => kind === 'continue' ? state.onboarding > 0 : kind === 'skip' ? state.onboarding === 0 && state.skip : state.onboarding === 0 && !state.skip;
  const control = kind => ({
    waitFor: async options => { calls.push(['wait', kind, options]); if (!visible(kind)) throw new Error('not visible'); },
    isVisible: async () => visible(kind),
    click: async () => { calls.push(['click', kind]); assert.ok(visible(kind)); if (kind === 'continue') state.onboarding--; else if (kind === 'skip') state.skip = false; else state.url = new URL(href, NATIVE_ORIGIN).href; },
    getAttribute: async name => { assert.equal(name, 'href'); return href; },
  });
  const link = control('project');
  const page = {
    goto: async url => { calls.push(['goto', url]); state.url = url; },
    locator: selector => { assert.equal(selector, 'a[href*="/projects/"]'); return { filter: filter => { assert.equal(filter.hasText, 'Owned title'); return { first: () => link }; } }; },
    getByRole: (role, options) => role === 'region' || role === 'heading' ? { waitFor: async () => { calls.push([role, options.name]); assert.equal(state.url, new URL(href, NATIVE_ORIGIN).href); if (role === 'heading') assert.equal(options.name, heading); } } : control(options.name === 'Continue' ? 'continue' : 'skip'),
    url: () => state.url,
  };
  return { page, calls };
}
test('project navigation waits for rendered controls, handles bounded onboarding, then clicks the observed link', async () => {
  const { page, calls } = routePage({ onboarding: 3, skip: true });
  const result = await openOwnedProject(page, { id: 'owned-project', title: 'Owned title' });
  assert.deepEqual(result, { url: NATIVE_ORIGIN + '/projects/folder%3Aworkspace', continues: 3, skippedImport: true });
  assert.deepEqual(calls.filter(call => call[0] === 'goto'), [['goto', NATIVE_ORIGIN]]);
  assert.deepEqual(calls.filter(call => call[0] === 'click').map(call => call[1]), ['continue', 'continue', 'continue', 'skip', 'project']);
  assert.ok(calls.some(call => call[0] === 'wait' && call[1] === 'project' && call[2].state === 'visible' && call[2].timeout === 30000));
  assert.ok(calls.some(call => call[0] === 'heading' && call[1] === 'Owned title'));
});
test('project navigation rejects extra onboarding or foreign rendered destinations without following them', async () => {
  for (const input of [{ onboarding: 4 }, { href: 'https://foreign.example/projects/owned-project' }, { href: '/settings/projects' }, { href: null }]) {
    const { page, calls } = routePage(input);
    await assert.rejects(openOwnedProject(page, { id: 'owned-project', title: 'Owned title' }));
    assert.ok(!calls.some(call => call[0] === 'click' && call[1] === 'project'));
    assert.deepEqual(calls.filter(call => call[0] === 'goto'), [['goto', NATIVE_ORIGIN]]);
  }
  const wrong = routePage({ heading: 'Other project' });
  await assert.rejects(openOwnedProject(wrong.page, { id: 'owned-project', title: 'Owned title' }));
});
test('review binds exact source, entire build, binaries, expiry and six-run authorization', () => {
  assert.equal(validateReview(review(), observed, now).maxRuns, 6);
  for (const patch of [{ sourceCommit: 'f'.repeat(40) }, { buildSha256: 'e'.repeat(64) }, { maxRuns: 7 }, { authorization: 'yes' }, { expiresAt: new Date(now - 1).toISOString() }, { expiresAt: new Date(now + 7200000).toISOString() }, { endpoint: 'secret' }])
    assert.throws(() => validateReview({ ...review(), ...patch }, observed, now));
  assert.throws(() => validateReview(review(), { ...observed, sourceDirty: true }, now));
  for (const patch of [{ binaryPath: 'claude' }, { binarySha256: 'unverified' }, { model: 'x; shell' }, { env: { ANTHROPIC_API_KEY: 'secret' } }]) {
    const r = review(); r.claude = { ...r.claude, ...patch }; assert.throws(() => validateReview(r, observed, now));
  }
});
test('native environment preserves only current login homes and strips paid API/endpoint/debug state', () => {
  const source = { HOME: '/current', USER: 'test', LOGNAME: 'test', CODEX_HOME: '/current-codex', CLAUDE_CONFIG_DIR: '/current-claude', TMPDIR: '/external/tmp',
    OPENAI_API_KEY: 'secret1', ANTHROPIC_API_KEY: 'secret2', CLAUDE_CODE_OAUTH_TOKEN: 'secret3', ANTHROPIC_BASE_URL: 'https://foreign', HTTP_PROXY: 'https://foreign', NODE_OPTIONS: '--require malicious', PWDEBUG: '1', PLAYWRIGHT_HTML_OPEN: 'always' };
  const real = nativeEnvironment(source, '/fake', true), smoke = nativeEnvironment(source, '/fake', false);
  assert.equal(real.HOME, '/current'); assert.equal(real.CODEX_HOME, '/current-codex'); assert.equal(real.CLAUDE_CONFIG_DIR, '/current-claude');
  assert.equal(smoke.HOME, '/fake'); assert.equal(smoke.CODEX_HOME, undefined); assert.equal(smoke.CLAUDE_CONFIG_DIR, undefined);
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'HTTP_PROXY', 'NODE_OPTIONS']) assert.equal(real[key], undefined);
  assert.equal(real.PWDEBUG, '0'); assert.equal(real.PLAYWRIGHT_HTML_OPEN, 'never');
});
test('smoke disables every provider while native setup configures two existing binaries without auth setup', () => {
  const smoke = providerSettings(null);
  assert.ok(Object.values(smoke.providers).every((p) => !p.enabled));
  assert.ok(Object.values(smoke.providerInstances).every((p) => !p.enabled));
  const configured = providerSettings(review());
  assert.equal(configured.defaultRuntimeMode, 'approval-required');
  assert.deepEqual(Object.entries(configured.providerInstances).filter(([, p]) => p.enabled).map(([id]) => id), ['codex', 'claudeAgent']);
  assert.equal(configured.providerInstances.codex.config.setupMode, 'existing');
  assert.equal(configured.providerInstances.codex.config.shadowHomePath, undefined);
  assert.equal(configured.providerInstances.claudeAgent.config.launchArgs, '--setting-sources project');
  assert.ok(!JSON.stringify(configured).includes('apiKey'));
});
test('native catalog rejects unreviewed ACP providers and requires current native model plus verified auth', () => {
  const r = review();
  const providers = [['codex', r.codex.model], ['claudeAgent', r.claude.model]].map(([instanceId, model]) => ({
    instanceId, enabled: true, installed: true, status: 'ready', auth: { status: 'authenticated', email: 'private@example.invalid' }, models: [{ slug: model }],
  }));
  assert.ok(catalogReceipt({ providers }, r).every((p) => p.available));
  assert.ok(!JSON.stringify(catalogReceipt({ providers }, r)).includes('private@'));
  for (const patch of [{ auth: { status: 'unknown' } }, { status: 'warning' }, { availability: 'unavailable' }, { models: [] }, { installed: false }])
    assert.equal(catalogReceipt({ providers: [{ ...providers[0], ...patch }, providers[1]] }, r)[0].available, false);
  const unexpected = { instanceId: 'copilot-work', driver: 'acpRegistry', enabled: true };
  assert.throws(() => catalogReceipt({ providers: [...providers, unexpected] }, r), /Unreviewed provider/);
  assert.throws(() => catalogReceipt({ providers }, null), /Unreviewed provider/);
  assert.deepEqual(catalogReceipt({ providers: [{ ...unexpected, enabled: false }] }, null), []);
});
test('native dispatch cannot carry manual credit consent, model overrides or extra unreviewed fields', () => {
  for (const extra of [{ manualCodexCreditIntent: { type: 'human-submit-existing-credits' } }, { modelSelection: { instanceId: 'grok', model: 'other' } }, { sourceThreadId: 'worker' }, { attachments: [] }])
    assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'projects.coordinatorStart', dispatch('id', extra), scope(true)), /Unreviewed RPC field/);
});
test('build fingerprint covers chunks and client assets, not merely bin.mjs; escaped symlink fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-build-test-'));
  try {
    mkdirSync(join(dir, 'client')); writeFileSync(join(dir, 'bin.mjs'), 'entry'); writeFileSync(join(dir, 'client', 'index.html'), 'old');
    const first = buildFingerprint(dir); assert.equal(first.files, 2);
    writeFileSync(join(dir, 'client', 'index.html'), 'new'); assert.notEqual(buildFingerprint(dir).sha256, first.sha256);
    symlinkSync('/private', join(dir, 'escape')); assert.throws(() => buildFingerprint(dir), /symlink/);
  } finally { rmSync(dir, { recursive: true }); }
});
test('RPC forbids foreign ports, methods, projects, selected workers and any direct message command', () => {
  const s = scope(true);
  assert.throws(() => assertNativeRpc('http://127.0.0.1:8319', 'server.getConfig', {}, s));
  assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'server.updateSettings', {}, s));
  assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'projects.memoryRead', { projectId: 'foreign' }, s));
  assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'projects.coordinatorSend', dispatch('id', { sourceThreadId: 'foreign' }), s));
  assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'orchestration.dispatchCommand', { type: 'message.dispatch', threadId: 'worker' }, s));
});
test('disabled execution cannot start a coordinator; two durable dispatch IDs retain retries without budget inflation', () => {
  assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'projects.coordinatorStart', dispatch(), scope()));
  const s = scope(true);
  assertNativeRpc(NATIVE_ORIGIN, 'projects.coordinatorStart', dispatch(), s);
  assertNativeRpc(NATIVE_ORIGIN, 'projects.coordinatorStart', dispatch(), s);
  assert.equal(s.dispatches.size, 1);
  assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'projects.coordinatorStart', dispatch('intent-1', { prompt: 'changed' }), s));
  assertNativeRpc(NATIVE_ORIGIN, 'projects.coordinatorSend', dispatch('intent-2'), s);
  assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'projects.coordinatorSend', dispatch('intent-3'), s));
});
test('replayed cumulative projections do not inflate budget; newly observed excess is retained and fails', () => {
  const s = scope(true), first = projection();
  observeProjection(s, first); observeProjection(s, first); assert.equal(s.runs.size, 1);
  observeProjection(s, projection('worker', Array.from({ length: 6 }, (_, i) => ({ id: `run-${i + 1}`, status: 'completed' }))));
  assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'projects.coordinatorSend', dispatch(), s));
  assert.throws(() => observeProjection(s, projection('worker', [{ id: 'run-7', status: 'running' }])), /ceiling/);
  assert.equal(s.runs.size, 7); assert.equal(s.runs.get('run-7').status, 'running');
});
test('provider retries/turns and additional worker threads also consume the bound', () => {
  const s = scope(true), p = projection(); p.providerTurns = Array.from({ length: 7 }, (_, i) => ({ id: `turn-${i}` }));
  assert.throws(() => observeProjection(s, p), /ceiling/); assert.equal(s.providerTurns.size, 7);
  const a = scope(true), retry = projection(); retry.attempts = Array.from({ length: 7 }, (_, i) => ({ id: `attempt-${i}` }));
  assert.throws(() => observeProjection(a, retry), /ceiling/); assert.equal(a.attempts.size, 7);
  const threads = scope(true); observeProjection(threads, projection('coordinator', [])); observeProjection(threads, projection('worker', []));
  assert.throws(() => observeProjection(threads, projection('extra', [])), /extra worker/); assert.equal(threads.threadIds.size, 3);
});
test('foreign membership, reassigned run IDs, pending permission and native subagents fail closed', () => {
  const s = scope(true);
  assert.throws(() => observeProjection(s, { ...projection(), thread: { id: 'foreign', projectId: 'foreign' } }));
  assert.equal(s.threadIds.size, 0);
  observeProjection(s, projection()); assert.throws(() => observeProjection(s, projection('other')), /owner/);
  assert.throws(() => observeProjection(scope(), { ...projection(), runtimeRequests: [{ status: 'pending' }] }), /permission/);
  assert.throws(() => observeProjection(scope(), { ...projection(), subagents: [{ origin: 'provider_native', childThreadId: null }] }), /subagent/);
  observeProjection(scope(), { ...projection(), subagents: [{ origin: 'app_owned', childThreadId: 'child' }] });
});
test('interrupt fence accepts exact observed runs including excess, never arbitrary IDs', () => {
  const s = scope(true); observeProjection(s, projection());
  const command = { type: 'run.interrupt', threadId: 'worker', runId: 'run-1', commandId: 'stop' };
  assertNativeRpc(NATIVE_ORIGIN, 'orchestration.dispatchCommand', command, s);
  assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'orchestration.dispatchCommand', { ...command, threadId: 'foreign' }, s));
  assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'orchestration.dispatchCommand', { ...command, runId: 'unknown' }, s));
});
test('synthetic native proof requires real assistant marker output, no marker-bearing prompt and no worker tools', () => {
  const p = { runs: [{ id: 'run', userMessageId: 'm' }], messages: [{ id: 'm', role: 'user', text: 'Report injected markers.' }], nodes: [],
    turnItems: [{ type: 'assistant_message', runId: 'run', text: 'PROOF goal-token memory-token' }] };
  const result = syntheticAnswer(p, 'run', 'goal-token', 'memory-token'); assert.equal(result.present, true); assert.match(result.responseSha256, /^[a-f0-9]{64}$/);
  assert.equal(syntheticAnswer(p, 'run', 'goal-token', 'new-token').present, false);
  assert.throws(() => syntheticAnswer({ ...p, messages: [] }, 'run', 'goal-token', 'memory-token'));
  assert.throws(() => syntheticAnswer({ ...p, messages: [{ ...p.messages[0], text: 'goal-token memory-token' }] }, 'run', 'goal-token', 'memory-token'));
  assert.throws(() => syntheticAnswer({ ...p, nodes: [{ runId: 'run', kind: 'tool_call' }] }, 'run', 'goal-token', 'memory-token'));
});
test('second cycle directs ordinary retained-thread continuation, with one bounded wait and no new delegated lifecycle', () => {
  const prompts = cyclePrompts('claude-model', 'stable-intent');
  assert.match(prompts.first, /delegate_task/); assert.match(prompts.first, /mode async/);
  assert.match(prompts.second, /studio_thread_send/); assert.match(prompts.second, /studio_thread_wait/);
  assert.match(prompts.second, /timeoutMs 120000/); assert.match(prompts.second, /not a new delegated review round/);
  assert.match(prompts.second, /clientRequestId stable-intent/);
  const selected = cyclePrompts('claude-model', 'stable-intent', 'owned-worker').second;
  assert.ok(selected.includes('studio_thread_read({"threadId":"owned-worker","view":"messages"})'));
  assert.ok(selected.includes('"threadId":"owned-worker","runId":"<exact runId from send result>","timeoutMs":120000'));
});
test('RPC transport retains browser ticket only in memory and redacts server failure details', async () => {
  const Original = globalThis.WebSocket; let observedUrl, sent;
  class FakeSocket extends EventTarget {
    constructor(url) { super(); observedUrl = String(url); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(data) { sent = JSON.parse(data); queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Failure', cause: { code: 'paused', message: 'PRIVATE_API_TOKEN' } } }) }))); }
    close() {}
  }
  globalThis.WebSocket = FakeSocket;
  try {
    const context = { request: { post: async (url) => { assert.equal(url, NATIVE_ORIGIN + '/api/auth/websocket-ticket'); return { status: () => 200, json: async () => ({ ticket: 'PRIVATE_TICKET' }) }; } } };
    await assert.rejects(nativeRpc(context, NATIVE_ORIGIN, 'projects.workspaceRead', { projectId }, scope()), (error) => error.message === 'Native RPC denied: paused');
    assert.match(observedUrl, /wsTicket=PRIVATE_TICKET/); assert.equal(sent.tag, 'projects.workspaceRead');
    assert.ok(!JSON.stringify(sent).includes('PRIVATE_TICKET'));
  } finally { globalThis.WebSocket = Original; }
});

test('old reviews, broadened grants and mismatched tooling cannot authorize native approvals', () => {
  for (const patch of [{ schemaVersion: 1 }, { authorization: 'six-native-project-runs' }, { toolingSha256: 'e'.repeat(64) },
    { approvalPlan: { ...APPROVAL_PLAN, decision: 'acceptAlways' } }, { approvalPlan: { ...APPROVAL_PLAN, maxResponses: 6 } },
    { approvalPlan: { ...APPROVAL_PLAN, retry: true } }, { approvalPlan: { ...APPROVAL_PLAN, persistentGrants: true } }])
    assert.throws(() => validateReview({ ...review(), ...patch }, observed, now));
  const old = review(); delete old.approvalPlan; delete old.toolingSha256;
  assert.throws(() => validateReview(old, observed, now));
});
test('newest accepted context wins across old unknown-native and new known-native scope epochs', () => {
  const rows = [
    { threadId: 'worker', accepted: true, updatedAt: '2026-10-09T12:00:00.000Z', scopeSha256: 'a', snapshotSha256: 'old' },
    { threadId: 'worker', accepted: true, updatedAt: '2026-10-09T12:01:00.000Z', scopeSha256: 'b', snapshotSha256: 'new' },
    { threadId: 'worker', accepted: false, updatedAt: '2026-10-09T12:02:00.000Z', scopeSha256: 'c', snapshotSha256: null },
    { threadId: 'other', accepted: true, updatedAt: '2026-10-09T12:03:00.000Z', scopeSha256: 'd', snapshotSha256: 'foreign' },
  ];
  assert.equal(newestAcceptedContext(rows, 'worker').snapshotSha256, 'new');
  assert.equal(newestAcceptedContext([...rows].reverse(), 'worker').snapshotSha256, 'new');
  assert.equal(newestAcceptedContext(rows, 'missing'), undefined);
  assert.equal(newestAcceptedContext([rows[1], { ...rows[1], scopeSha256: 'a', snapshotSha256: 'tie' }], 'worker').snapshotSha256, 'tie');
  assert.equal(rows[0].snapshotSha256, 'old');
});
test('failure receipts retain only trusted assertion reasons, never private error data', () => {
  const error = new assert.AssertionError({ message: 'Updated worker memory marker absent', actual: 'PRIVATE_TOKEN', expected: 'PRIVATE_EXPECTED' });
  error.cause = { secret: 'PRIVATE_CAUSE' };
  assert.equal(sanitizedFailure(error).reason, 'Updated worker memory marker absent');
  assert.ok(!JSON.stringify(sanitizedFailure(error)).includes('PRIVATE'));
  for (const message of ['PRIVATE_TOKEN', 'Native approval refused: PRIVATE_TOKEN', 'Updated worker memory marker absent PRIVATE_TOKEN'])
    assert.equal(sanitizedFailure(new Error(message)).reason, 'Private details omitted');
});

test('reviewed run ceiling accepts only 4, 5 or 6 and prompts use the selected ceiling', () => {
  for (const maxRuns of [4, 5, 6]) {
    assert.equal(validateReview({ ...review(), maxRuns }, observed, now).maxRuns, maxRuns);
    const s = createNativeScope(projectId, true, maxRuns);
    assert.equal(s.maxRuns, maxRuns);
    assert.throws(() => { s.maxRuns = 6; }, TypeError, 'the reviewed budget cannot be changed');
    assert.match(cyclePrompts('worker', 'followup', undefined, maxRuns).first, new RegExp(`At most ${maxRuns} app runs`));
  }
  for (const maxRuns of [0, 3, 7, 4.5, '4', null, NaN]) {
    assert.throws(() => validateReview({ ...review(), maxRuns }, observed, now));
    assert.throws(() => createNativeScope(projectId, true, maxRuns));
  }
});
test('four-run ceiling retains the fifth observed run as failed evidence and denies a new dispatch at four', () => {
  const s = createNativeScope(projectId, true, 4);
  observeProjection(s, projection('worker', Array.from({ length: 4 }, (_, i) => ({ id: `run-${i}`, status: 'completed' }))));
  assert.equal(s.runs.size, 4);
  assert.throws(() => assertNativeRpc(NATIVE_ORIGIN, 'projects.coordinatorStart', dispatch(), s), /budget exhausted/);
  assert.equal(s.dispatches.size, 0);
  assert.throws(() => observeProjection(s, projection('worker', [{ id: 'fifth', status: 'running' }])), /run ceiling/);
  assert.equal(s.runs.size, 5, 'excess work remains in the failure evidence');
  for (const field of ['providerTurns', 'attempts']) {
    const t = createNativeScope(projectId, true, 4), p = projection();
    p[field] = Array.from({ length: 5 }, (_, i) => ({ id: `${field}-${i}` }));
    assert.throws(() => observeProjection(t, p), /attempt\/turn ceiling/);
    assert.equal(t[field].size, 5);
  }
});

test('dispatch receipt binds exact two commands and selected worker without retaining prompts',()=>{
  const s=createNativeScope(projectId,true,5);s.threadIds.add('owned-worker');
  assertNativeRpc(NATIVE_ORIGIN,'projects.coordinatorStart',{projectId,commandId:'start',prompt:'PRIVATE_PROMPT'},s);
  assertNativeRpc(NATIVE_ORIGIN,'projects.coordinatorSend',{projectId,commandId:'followup',sourceThreadId:'owned-worker',prompt:'PRIVATE_PROMPT'},s);
  assert.deepEqual(userDispatchReceipt(s),[
    {tag:'projects.coordinatorStart',commandId:'start',projectId,sourceThreadId:null},
    {tag:'projects.coordinatorSend',commandId:'followup',projectId,sourceThreadId:'owned-worker'},
  ]);
  assert.ok(!JSON.stringify(userDispatchReceipt(s)).includes('PRIVATE'));
});

test('coordinator answer links the worker in the server-built encoded form or as a raw ID',()=>{
  const id='thread:delegated-task:command%3Amcp%3Aa1%3Adelegate-task%3Afix';
  const encoded='studio://thread/'+encodeURIComponent(id);
  assert.ok(linksThread('Started [Fix]('+encoded+').',id));
  assert.ok(linksThread('Started [Fix](studio://thread/'+id+').',id));
  assert.ok(!linksThread('Started [Fix](studio://thread/'+encodeURIComponent(id+'x')+').',id));
  assert.ok(!linksThread('Started Fix.',id));
});
