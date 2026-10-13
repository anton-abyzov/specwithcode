#!/usr/bin/env node
// Real UI dispatch, native delegation and automatic relay, in a new private store.
// Inspect is read-only. Execute requires a fresh review binding every input.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { buildFingerprint, linksThread, nativeEnvironment, resolveRuntimeRoot } from './native-acceptance.mjs';
import { nativeRouteMetadata } from '../studio-verify/native-proof.mjs';
import { safeFailure } from './rpc.mjs';
import { APPROVAL_OPTIONS } from './native-approval.mjs';

export const ORIGIN = 'http://127.0.0.1:8433';
export const MAX_RUNS = 8;
const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);
const FINISHED = new Set(['completed']);
const ownPath = fileURLToPath(import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const pause = ms => new Promise(done => setTimeout(done, ms));
const invariant = (condition, code) => { if (!condition) throw new Error(code); };
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const saveJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const git = (root, args) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const SOURCE_FILES = ['coordinator-quality.mjs', 'native-acceptance.mjs', 'native-rpc.mjs', 'native-approval.mjs', 'native-tool-detail.mjs', 'rpc.mjs'];

export function parseOptions(args) {
  const options = { '--mode': 'inspect' };
  const allowed = new Set(['--mode', '--runtime-root', '--review', '--report-dir', '--easychamp-brief', '--specweave-brief', '--browser-deps', '--browser-executable']);
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    invariant(allowed.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--') && !seen.has(args[i]), 'invalid-options');
    seen.add(args[i]); options[args[i]] = args[i + 1];
  }
  invariant(['inspect', 'execute'].includes(options['--mode']), 'invalid-mode');
  for (const key of ['--runtime-root', '--easychamp-brief', '--specweave-brief']) invariant(isAbsolute(options[key] ?? ''), 'absolute-input-required');
  if (options['--mode'] === 'execute') invariant(isAbsolute(options['--review'] ?? '') && isAbsolute(options['--report-dir'] ?? ''), 'execution-inputs-required');
  else invariant(!options['--review'], 'inspect-cannot-execute');
  return options;
}

export function readBrief(path) {
  invariant(statSync(path).isFile() && statSync(path).size <= 16_384, 'invalid-brief-file');
  const bytes = readFileSync(path), brief = JSON.parse(bytes.toString('utf8'));
  invariant(Object.keys(brief).every(key => ['facts', 'mustMention', 'mustNotClaim'].includes(key)), 'invalid-brief-fields');
  for (const field of ['facts', 'mustMention', 'mustNotClaim']) {
    invariant(Array.isArray(brief[field]) && brief[field].length <= 20 && brief[field].every(s => typeof s === 'string' && s.trim() && s.length <= 1500), 'invalid-brief-values');
  }
  invariant(brief.facts.length > 0 && brief.mustMention.length > 0, 'empty-brief');
  return { ...brief, sha256: sha(bytes) };
}

export function validateReview(review, observed, now = Date.now()) {
  assert.deepEqual(Object.keys(review).sort(), ['authorization', 'briefs', 'buildSha256', 'coordinator', 'expiresAt', 'maxRuns', 'schemaVersion', 'sourceCommit', 'timeoutMs', 'toolingSha256', 'worker'].sort());
  invariant(review.schemaVersion === 1 && review.authorization === 'two-realistic-coordinator-ui-cycles', 'review-authorization');
  invariant(review.maxRuns === MAX_RUNS && Number.isInteger(review.timeoutMs) && review.timeoutMs >= 60_000 && review.timeoutMs <= 360_000, 'review-budget');
  invariant(Date.parse(review.expiresAt) > now && Date.parse(review.expiresAt) <= now + 3_600_000, 'review-expiry');
  for (const key of ['sourceCommit', 'buildSha256', 'toolingSha256']) invariant(review[key] === observed[key], 'review-binding');
  assert.deepEqual(review.briefs, observed.briefs, 'brief bindings differ');
  invariant(!observed.sourceDirty && !observed.toolingDirty, 'dirty-source');
  for (const role of ['coordinator', 'worker']) {
    const profile = review[role];
    assert.deepEqual(Object.keys(profile).sort(), ['binaryPath', 'binarySha256', 'instanceId', 'model'].sort());
    invariant(['codex', 'claudeAgent'].includes(profile.instanceId) && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,120}$/.test(profile.model), 'review-native-provider');
    invariant(isAbsolute(profile.binaryPath) && /^[a-f0-9]{64}$/.test(profile.binarySha256), 'review-native-binary');
  }
  if (review.coordinator.instanceId === review.worker.instanceId) invariant(review.coordinator.binaryPath === review.worker.binaryPath && review.coordinator.binarySha256 === review.worker.binarySha256, 'profile-binary-conflict');
  return review;
}

export function projectPrompt(kind) {
  const request = kind === 'easychamp'
    ? 'Develop one strong 30-second short-video concept for EasyChamp from the supplied factual brief: a title, hook, timed script, shot list and CTA. Aim for shareability without promising virality. Keep it to 220-400 words and preserve the factual constraints. Return the complete formatted brief in your worker answer; do not create or publish media.'
    : 'Assess the supplied SpecWeave release-readiness brief. Return a concise release decision, evidence already available, missing gates and the next three verification steps in 180-350 words. Clearly distinguish source checks from live acceptance and publication. Do not make a release or modify code.';
  return `${request}\n\nUse one worker for this task, then relay its completed result concisely with its working thread link. The factual brief is in project context. No external research is needed. No shell, filesystem, browser, network, publishing, schedules or extra workers are authorized; all facts needed are supplied. Delegate asynchronously and let completion return automatically. The worker should answer from context without tools. Do not poll. Your final relay should fit in 3 short sentences.`;
}

export function briefContext(brief) {
  return `Verified facts supplied for this QA task:\n${brief.facts.map(s => `- ${s}`).join('\n')}\nRequired factual terms: ${brief.mustMention.join('; ')}\nClaims that must not be made: ${brief.mustNotClaim.join('; ') || 'None specified'}`;
}

export function validateOutput(workerText, relayText, workerId, brief) {
  const words = text => text.trim().split(/\s+/).filter(Boolean).length;
  invariant(words(workerText) >= 100 && words(workerText) <= 650, 'worker-answer-length');
  invariant(/(^|\n)(?:#{1,4} |[-*] |\d+[.)] |\*\*[^*]+\*\*)/.test(workerText), 'worker-answer-format');
  for (const term of brief.mustMention) invariant(workerText.toLowerCase().includes(term.toLowerCase()), 'required-fact-missing');
  for (const term of brief.mustNotClaim) invariant(!workerText.toLowerCase().includes(term.toLowerCase()), 'forbidden-claim');
  invariant(words(relayText) >= 5 && words(relayText) <= 160 && relayText.split('\n').filter(s => s.trim()).length <= 12, 'relay-not-concise');
  invariant(linksThread(relayText, workerId), 'relay-worker-link');
  invariant(!/```|(?:node|run|task):delegated|<response_style|mcp__/.test(relayText), 'relay-internal-leak');
  return { workerWords: words(workerText), relayWords: words(relayText), requiredFacts: brief.mustMention.length, format: 'markdown', workerLinked: true };
}

/** Opening a worker changes only the selected side-pane thread on this project route. */
export function isWorkerSidepaneRoute(actualUrl, projectUrl, workerId) {
  try {
    const actual = new URL(actualUrl), project = new URL(projectUrl);
    const selected = actual.searchParams.getAll('thread');
    if (actual.origin !== project.origin || actual.pathname !== project.pathname ||
        typeof workerId !== 'string' || !workerId || selected.length !== 1 || selected[0] !== workerId) return false;
    const otherParams = url => [...url.searchParams.entries()]
      .filter(([key]) => key !== 'thread').map(entry => JSON.stringify(entry)).sort();
    return JSON.stringify(otherParams(actual)) === JSON.stringify(otherParams(project));
  } catch { return false; }
}

/** Server persistence strips defaults; settings.ts decodes an absent style as concise. */
export function persistedResponseStyle(settings) {
  invariant(settings && typeof settings === 'object' && !Array.isArray(settings), 'invalid-persisted-settings');
  if (!Object.hasOwn(settings, 'responseStyle')) return 'concise';
  invariant(['concise', 'detailed'].includes(settings.responseStyle), 'invalid-persisted-response-style');
  return settings.responseStyle;
}

/** Visibility precedes the WebSocket settings snapshot after a reload. */
export async function waitForReadyResponseStyle(control, expected, { timeoutMs = 15_000, now = Date.now, sleep = pause } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await control.isEnabled({ timeout: Math.max(1, deadline - now()) }) &&
        (await control.innerText({ timeout: Math.max(1, deadline - now()) })).trim() === expected) return;
    await sleep(Math.min(100, Math.max(1, deadline - now())));
  }
  throw new Error(`${expected.toLowerCase()}-setting-not-persisted`);
}

export function makeScope(projects, review) {
  return { projects: new Map(projects.map(p => [p.id, p])), review, runs: new Map(), turns: new Set(), attempts: new Set(), threads: new Map(), approvals: new Map(), toolCalls: new Map() };
}

function operation(item) {
  for (const prefix of ['studio-code.', 'mcp__studio_code__', 'mcp__studio-code__']) if (item.toolName?.startsWith(prefix)) return item.toolName.slice(prefix.length);
  return null;
}

export function validateTool(scope, projection, item) {
  const project = scope.projects.get(projection.thread.projectId);
  invariant(project && projection.thread.id === `project-coordinator:${project.id}`, 'worker-used-tool');
  const op = operation(item), input = item.input;
  invariant(input && typeof input === 'object' && !Array.isArray(input), 'invalid-tool-input');
  invariant(['studio_thread_list', 'orchestrator_capabilities', 'delegate_task', 'task_status', 'studio_thread_read', 'studio_project_memory_read'].includes(op), 'unapproved-tool');
  if (op === 'studio_thread_list') invariant(input.projectId === undefined || input.projectId === project.id, 'foreign-tool-project');
  if (op === 'studio_project_memory_read') invariant((input.projectId === undefined || input.projectId === project.id) && ['MEMORY.md', 'brief.md'].includes(input.name), 'foreign-memory-read');
  if (op === 'delegate_task') {
    invariant((input.mode === undefined || input.mode === 'async') && typeof input.task === 'string' && input.task.length > 40 && input.task.length < 12_000, 'invalid-delegation');
    invariant(input.runtimeMode === undefined || input.runtimeMode === 'approval-required', 'worker-permission-escalation');
    invariant(input.machine === undefined || input.machine === 'local', 'remote-worker-refused');
    if (input.target) invariant((input.target.providerInstanceId === undefined || input.target.providerInstanceId === scope.review.worker.instanceId) && (input.target.driverKind === undefined || input.target.driverKind === scope.review.worker.instanceId) && (input.target.model === undefined || input.target.model === scope.review.worker.model), 'worker-model-changed');
    const earlier = [...scope.toolCalls.values()].filter(c => c.projectId === project.id && c.op === op && c.id !== item.id);
    invariant(earlier.length === 0, 'extra-delegation');
  }
  if (op === 'task_status') {
    invariant((projection.subagents ?? []).some(s => s.taskId === input.taskId || s.id === input.taskId || s.nodeId === input.taskId), 'foreign-task-status');
  }
  if (op === 'studio_thread_read') invariant(scope.threads.get(input.threadId)?.projectId === project.id && input.threadId !== projection.thread.id, 'foreign-worker-read');
  const identity = { id: item.id, projectId: project.id, op, inputSha256: sha(JSON.stringify(input)) };
  if (scope.toolCalls.has(item.id)) assert.deepEqual(scope.toolCalls.get(item.id), identity, 'tool input changed');
  scope.toolCalls.set(item.id, identity);
  invariant(scope.toolCalls.size <= 16, 'tool-call-budget');
  return op;
}

export function observeQuality(scope, projection) {
  const project = scope.projects.get(projection.thread.projectId);
  invariant(project, 'foreign-project');
  scope.threads.set(projection.thread.id, projection.thread);
  for (const run of projection.runs) {
    const prior = scope.runs.get(run.id);
    invariant(!prior || prior.threadId === projection.thread.id, 'changed-run-owner');
    scope.runs.set(run.id, { id: run.id, threadId: projection.thread.id, status: run.status });
  }
  for (const turn of projection.providerTurns ?? []) scope.turns.add(turn.id);
  for (const attempt of projection.attempts ?? []) scope.attempts.add(attempt.id);
  invariant(scope.runs.size <= MAX_RUNS && scope.turns.size <= MAX_RUNS && scope.attempts.size <= MAX_RUNS, 'native-run-budget');
  invariant([...scope.threads.values()].filter(t => t.projectId === project.id).length <= 2, 'extra-worker');
  invariant((projection.subagents ?? []).every(s => s.origin === 'app_owned' && s.childThreadId), 'native-subagent-refused');
  const coordinator = projection.thread.id === `project-coordinator:${project.id}`;
  const expected = coordinator ? scope.review.coordinator : scope.review.worker;
  invariant(projection.thread.modelSelection.instanceId === expected.instanceId && projection.thread.modelSelection.model === expected.model, 'native-model-changed');
  invariant(projection.runs.every(r => !['failed', 'cancelled', 'interrupted'].includes(r.status)), 'native-run-failed');
  for (const item of projection.turnItems ?? []) if (item.type === 'dynamic_tool') validateTool(scope, projection, item);
  for (const node of projection.nodes ?? []) {
    invariant(node.kind !== 'hook', 'unexpected-hook');
    if (node.kind === 'tool_call') {
      invariant(coordinator, 'worker-used-tool');
      const item = projection.turnItems.find(i => i.nodeId === node.id);
      // Canonical nodes may precede their item publication; pending approvals are never accepted without it.
      if (item) invariant(item.type === 'dynamic_tool' && operation(item), 'unapproved-execution');
    }
  }
}

// Only an exact live Codex Studio MCP elicitation can be answered. No shell,
// native file permission, user question, broad-session grant or worker request.
export function approvalCandidate(scope, projection) {
  const pending = projection.runtimeRequests.filter(q => q.status === 'pending');
  invariant(pending.length <= 1, 'multiple-permission-requests');
  if (!pending.length) return null;
  const q = pending[0];
  invariant(projection.thread.id === `project-coordinator:${projection.thread.projectId}` && projection.thread.modelSelection.instanceId === 'codex', 'permission-withheld');
  invariant(q.kind === 'mcp-elicitation' && q.nativeRequestRef?.driver === 'codex' && q.nativeRequestRef?.nativeId === 'mcp-elicitation:studio-code' && q.responseCapability?.type === 'live', 'permission-withheld');
  const approvals = projection.turnItems.filter(i => i.type === 'approval_request' && i.requestId === q.id);
  if (!approvals.length) return null;
  invariant(approvals.length === 1, 'ambiguous-approval');
  const item = approvals[0];
  invariant(item.status === 'waiting' && item.nodeId === q.nodeId && item.providerTurnId === q.providerTurnId && item.appName === 'studio-code' && item.requestKind === 'mcp-elicitation', 'approval-binding');
  assert.deepEqual(item.options, APPROVAL_OPTIONS);
  const calls = projection.turnItems.filter(i => i.type === 'dynamic_tool' && i.runId === item.runId && i.providerTurnId === q.providerTurnId && ['running', 'waiting', 'queued'].includes(i.status));
  invariant(calls.length === 1, 'ambiguous-approval-call');
  const call = calls[0], op = validateTool(scope, projection, call);
  invariant(item.prompt === `Allow the studio-code MCP server to run tool "${op}"?` && item.ordinal > call.ordinal, 'approval-prompt');
  const run = projection.runs.find(r => r.id === item.runId);
  invariant(run && ACTIVE.has(run.status), 'approval-run-inactive');
  const attempt = projection.attempts.find(a => a.id === run.activeAttemptId);
  const turn = projection.providerTurns.find(t => t.id === q.providerTurnId);
  const provider = projection.providerThreads.find(t => t.id === run.providerThreadId);
  const session = projection.providerSessions.find(s => s.id === q.responseCapability.providerSessionId);
  invariant(attempt?.runId === run.id && attempt.providerTurnId === q.providerTurnId && attempt.providerThreadId === run.providerThreadId && ACTIVE.has(attempt.status), 'approval-attempt-binding');
  invariant(turn?.runAttemptId === attempt.id && turn.providerThreadId === run.providerThreadId && ACTIVE.has(turn.status), 'approval-turn-binding');
  invariant(provider?.appThreadId === projection.thread.id && provider.driver === 'codex' && provider.providerSessionId === session?.id && session?.driver === 'codex' && session.providerInstanceId === scope.review.coordinator.instanceId && ACTIVE.has(session.status), 'approval-session-binding');
  invariant(call.providerThreadId === provider.id && item.providerThreadId === provider.id, 'approval-provider-binding');
  const binding = { threadId: projection.thread.id, requestId: q.id, runId: run.id, providerTurnId: q.providerTurnId, providerSessionId: q.responseCapability.providerSessionId, callId: call.id, inputSha256: sha(JSON.stringify(call.input)), op };
  if (scope.approvals.has(q.id)) { assert.deepEqual(scope.approvals.get(q.id), binding); return null; }
  invariant(scope.approvals.size < 8, 'approval-budget');
  return binding;
}

function settingsFor(review) {
  const providerInstances = Object.fromEntries(['codex', 'claudeAgent', 'cursor', 'grok', 'pi', 'opencode', 'opencode2', 'antigravity'].map(driver => [driver, { driver, enabled: false, config: {} }]));
  for (const profile of [review.coordinator, review.worker]) providerInstances[profile.instanceId] = { driver: profile.instanceId, enabled: true, config: { binaryPath: profile.binaryPath, ...(profile.instanceId === 'codex' ? { setupMode: 'existing' } : { launchArgs: '--setting-sources project' }) } };
  return { providerInstances, providers: Object.fromEntries(Object.entries(providerInstances).map(([id, value]) => [id, { enabled: value.enabled, ...value.config }])), defaultRuntimeMode: 'approval-required', responseStyle: 'concise', providerLimitAction: 'ask', providerLimitSwitchAtPercent: null, autoResumeLimitedThreads: false, snoozeLimitedThreads: false, cursorKeychainUsageEnabled: false, enableAgentBrowserAccess: false, enableAgentDeviceAccess: false };
}

async function freePort() {
  await new Promise((done, reject) => { const server = net.createServer(); server.once('error', () => reject(new Error('owned-port-occupied'))); server.listen(8433, '127.0.0.1', () => server.close(done)); });
}

async function rpc(context, scope, tag, payload = {}) {
  const reads = ['server.getConfig', 'server.getSettings', 'projects.workspaceRead'];
  invariant(reads.includes(tag) || tag === 'orchestration.dispatchCommand', 'rpc-not-allowed');
  if (tag === 'projects.workspaceRead') invariant(scope.projects.has(payload.projectId), 'foreign-rpc-project');
  if (tag === 'orchestration.dispatchCommand') {
    if (payload.type === 'run.interrupt') invariant(scope.runs.get(payload.runId)?.threadId === payload.threadId, 'foreign-run-interrupt');
    else invariant(payload.type === 'runtime-request.respond' && payload.decision === 'accept' && scope.approvals.get(payload.requestId)?.threadId === payload.threadId, 'unreviewed-approval');
  }
  const ticketResponse = await context.request.post(ORIGIN + '/api/auth/websocket-ticket', { headers: { Origin: ORIGIN } });
  invariant(ticketResponse.status() === 200, 'ticket-failed');
  const { ticket } = await ticketResponse.json();
  const url = new URL('/ws', ORIGIN); url.protocol = 'ws:'; url.searchParams.set('wsTicket', ticket); url.searchParams.set('orchestrationProtocol', '2');
  return new Promise((done, reject) => {
    const ws = new WebSocket(url); let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); ws.close(); fn(value); };
    const timer = setTimeout(() => finish(reject, new Error('rpc-timeout')), 20_000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ _tag: 'Request', id: '1', tag, payload, headers: [] })));
    ws.addEventListener('error', () => finish(reject, new Error('rpc-transport')));
    ws.addEventListener('close', () => finish(reject, new Error('rpc-closed')));
    ws.addEventListener('message', event => {
      let data; try { data = JSON.parse(event.data); } catch { return; }
      for (const item of Array.isArray(data) ? data : [data]) if (item._tag === 'Exit' && String(item.requestId) === '1') {
        if (item.exit?._tag === 'Success') finish(done, item.exit.value);
        else finish(reject, new Error(`rpc-denied-${safeFailure(item.exit) ?? 'unknown'}`));
      }
    });
  });
}

export async function run(options) {
  invariant(process.versions.node === '22.20.0', 'node22-required');
  process.env.PWDEBUG = '0'; process.env.PLAYWRIGHT_HTML_OPEN = 'never';
  const root = resolveRuntimeRoot(options['--runtime-root']), dist = join(root, 'apps/server/dist');
  const briefs = { easychamp: readBrief(options['--easychamp-brief']), specweave: readBrief(options['--specweave-brief']) };
  const toolingRoot = resolve(dirname(ownPath), '../..');
  const observed = { sourceCommit: git(root, ['rev-parse', 'HEAD']), sourceDirty: Boolean(git(root, ['status', '--porcelain', '--untracked-files=no'])),
    buildSha256: buildFingerprint(dist).sha256, toolingSha256: sha(SOURCE_FILES.map(file => sha(readFileSync(join(dirname(ownPath), file)))).join('') + sha(readFileSync(join(dirname(ownPath), '../studio-verify/native-proof.mjs')))),
    toolingDirty: Boolean(git(toolingRoot, ['status', '--porcelain', '--untracked-files=no'])), briefs: Object.fromEntries(Object.entries(briefs).map(([name, value]) => [name, value.sha256])), runtimeRoot: root };
  if (options['--mode'] === 'inspect') { console.log(JSON.stringify({ ...observed, nativeRuns: 0 })); return; }
  const review = validateReview(readJson(options['--review']), observed);
  await freePort();
  const reportDir = options['--report-dir']; invariant(!existsSync(reportDir), 'fresh-report-required'); mkdirSync(reportDir, { recursive: true, mode: 0o700 });
  const stateDir = mkdtempSync(join(tmpdir(), 'studio-coordinator-quality-')), dataDir = join(stateDir, 'studio');
  mkdirSync(join(dataDir, 'userdata'), { recursive: true, mode: 0o700 });
  const projects = Object.keys(briefs).map(kind => ({ kind, id: randomUUID(), title: `${kind === 'easychamp' ? 'EasyChamp' : 'SpecWeave'} QA`, workspaceRoot: join(stateDir, kind) }));
  const scope = makeScope(projects, review), snapshots = new Map();
  const receipt = { schemaVersion: 1, ...observed, startedAt: new Date().toISOString(), reportDir, stateDir, origin: ORIGIN, maxRuns: MAX_RUNS, success: false, nativeProof: 'pending', projects: [], steps: [], approvals: [], observedRuns: [], browser: { headless: true, PWDEBUG: '0', PLAYWRIGHT_HTML_OPEN: 'never' }, limitations: ['Bounded observation stops unexpected activity but cannot prevent native read-only calls between polls.', 'Native provider requests inside an app run are not a subscription-spend measurement.', 'Factual assertions check supplied required and forbidden phrases; human editorial review remains separate.'] };
  const save = () => { receipt.observedRuns = [...scope.runs.values()]; receipt.observedProviderTurns = scope.turns.size; receipt.approvals = [...scope.approvals.values()].map(({ providerSessionId, ...binding }) => ({ ...binding, sessionSha256: sha(providerSessionId) })); saveJson(join(reportDir, 'receipt.json'), receipt); };
  const env = { ...nativeEnvironment(process.env, join(stateDir, 'unused-home'), true), STUDIO_DISABLE_AUTO_UPDATE: 'true' };
  let child, browser, context, page, stage = 'preflight', guardError, running = false, monitor;
  const log = step => { receipt.steps.push(step); save(); console.log(JSON.stringify({ step })); };
  const get = async path => { invariant(path === '/api/projects' || path === '/api/orchestration/shell' || [...scope.threads.keys()].some(id => path === '/api/orchestration/threads/' + encodeURIComponent(id)), 'foreign-http-read'); const result = await context.request.get(ORIGIN + path, { headers: { 'x-studio-orchestration-protocol': '2' }, timeout: 10_000 }); invariant(result.status() === 200, 'http-read-failed'); return result.json(); };
  const interrupt = async () => { for (const run of scope.runs.values()) if (ACTIVE.has(run.status)) await rpc(context, scope, 'orchestration.dispatchCommand', { type: 'run.interrupt', commandId: randomUUID(), threadId: run.threadId, runId: run.id }).catch(() => { receipt.interruptUncertain = true; }); };
  const interrupted = () => { guardError = new Error('interrupted'); running = false; void interrupt().finally(() => { if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGTERM'); void browser?.close(); }); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  const observe = async () => {
    const shell = await get('/api/orchestration/shell');
    for (const thread of [...shell.threads, ...(shell.archivedThreads ?? [])]) {
      invariant(scope.projects.has(thread.projectId), 'unowned-thread'); scope.threads.set(thread.id, thread);
    }
    for (const thread of scope.threads.values()) {
      const { projection } = await get('/api/orchestration/threads/' + encodeURIComponent(thread.id)); snapshots.set(thread.id, projection); observeQuality(scope, projection);
      const candidate = approvalCandidate(scope, projection);
      if (candidate) {
        const { projection: fresh } = await get('/api/orchestration/threads/' + encodeURIComponent(thread.id)); observeQuality(scope, fresh);
        assert.deepEqual(approvalCandidate(scope, fresh), candidate, 'approval changed');
        scope.approvals.set(candidate.requestId, candidate); save();
        await rpc(context, scope, 'orchestration.dispatchCommand', { type: 'runtime-request.respond', commandId: randomUUID(), threadId: candidate.threadId, requestId: candidate.requestId, decision: 'accept' });
      }
    }
    save();
  };
  try {
    for (const profile of new Map([review.coordinator, review.worker].map(p => [p.instanceId, p])).values()) {
      invariant(statSync(profile.binaryPath).isFile() && sha(readFileSync(profile.binaryPath)) === profile.binarySha256, 'native-binary-changed');
      const probe = args => { try { return execFileSync(profile.binaryPath, args, { cwd: stateDir, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'] }); } catch { throw new Error('native-auth-unavailable'); } };
      if (profile.instanceId === 'codex') {
        // login status normally writes to stderr, so use spawnSync-like piped output via a bounded child.
        const login = await new Promise(done => { let output = ''; const proc = spawn(profile.binaryPath, ['login', 'status'], { cwd: stateDir, env, stdio: ['ignore', 'pipe', 'pipe'] }); const timer = setTimeout(() => proc.kill('SIGTERM'), 20_000); proc.stdout.on('data', x => { output += x; }); proc.stderr.on('data', x => { output += x; }); proc.on('error', () => { clearTimeout(timer); done(false); }); proc.on('exit', code => { clearTimeout(timer); done(code === 0 && output.trim() === 'Logged in using ChatGPT'); }); });
        invariant(login && (await nativeRouteMetadata(profile.binaryPath, stateDir, env)).routeVerified, 'consumer-codex-required');
      } else {
        const auth = JSON.parse(probe(['auth', 'status', '--json'])); invariant(auth.loggedIn && auth.authMethod === 'claude.ai' && auth.apiProvider === 'firstParty', 'consumer-claude-required');
        invariant(probe(['--help']).includes('--setting-sources'), 'claude-isolation-unavailable');
      }
    }
    writeFileSync(join(dataDir, 'userdata/settings.json'), JSON.stringify(settingsFor(review)), { mode: 0o600 });
    for (const project of projects) {
      mkdirSync(project.workspaceRoot, { mode: 0o700 });
      writeFileSync(join(project.workspaceRoot, 'README.md'), briefContext(briefs[project.kind]) + '\n', { mode: 0o600 });
      for (const args of [['init', '-b', 'codex/coordinator-quality'], ['add', 'README.md'], ['-c', 'user.name=Coordinator QA', '-c', 'user.email=qa@example.invalid', 'commit', '-m', 'Owned factual brief']]) execFileSync('/usr/bin/git', args, { cwd: project.workspaceRoot, env: { HOME: stateDir, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'ignore' });
      project.baseline = sha(readFileSync(join(project.workspaceRoot, 'README.md')));
    }
    const deps = options['--browser-deps'] ?? join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
    const { chromium } = createRequire(import.meta.url)(join(deps, 'playwright'));
    browser = await chromium.launch({ headless: true, ...(options['--browser-executable'] ? { executablePath: realpathSync(options['--browser-executable']) } : {}) });
    context = await browser.newContext({ viewport: { width: 1512, height: 982 }, colorScheme: 'light' }); page = await context.newPage();
    stage = 'server-start';
    child = spawn(process.execPath, [join(dist, 'bin.mjs'), 'serve', '--host', '127.0.0.1', '--port', '8433', '--base-dir', dataDir, '--no-browser'], { cwd: stateDir, env, stdio: ['ignore', 'pipe', 'pipe'] }); receipt.serverPid = child.pid; save();
    const credential = await new Promise((done, reject) => { let buffer = '', settled = false; const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); buffer = ''; fn(value); }; const timer = setTimeout(() => finish(reject, new Error('private-startup-timeout')), 45_000); const read = data => { if (settled) return; buffer = (buffer + data).slice(-65536); const match = buffer.match(/(?:^|\n)Token: ([^\s]+)/); if (match) finish(done, match[1]); }; child.stdout.on('data', read); child.stderr.on('data', read); child.once('error', () => finish(reject, new Error('server-spawn-failed'))); child.once('exit', () => finish(reject, new Error('server-exited'))); });
    invariant((await context.request.post(ORIGIN + '/api/auth/browser-session', { headers: { Origin: ORIGIN }, data: { credential } })).status() === 200, 'private-auth-failed');
    const initial = await get('/api/projects'); invariant((Array.isArray(initial) ? initial : initial.projects).length === 0, 'store-not-empty');
    for (const project of projects) {
      const mutate = async fields => { const result = await context.request.post(ORIGIN + '/api/projects/mutate', { headers: { Origin: ORIGIN }, data: { commandId: randomUUID(), projectId: project.id, ...fields } }); invariant(result.status() === 200, 'project-setup-failed'); };
      await mutate({ type: 'project.create', title: project.title, workspaceRoot: project.workspaceRoot, defaultModelSelection: { instanceId: review.worker.instanceId, model: review.worker.model } });
      const workspace = await rpc(context, scope, 'projects.workspaceRead', { projectId: project.id });
      await mutate({ type: 'project.update', workspaceSettings: { expectedRevision: workspace.settings.revision, goal: briefContext(briefs[project.kind]), instructions: 'This is an owned QA project. Use only the supplied facts. Exactly one async delegated worker may answer the requested brief from context with no tools. Never edit files, use shell/browser/network, publish, schedule or change settings. Coordinators may use Studio thread list, delegation and completion-result tools. Finish after one concise relay.', coordinatorModelSelection: { instanceId: review.coordinator.instanceId, model: review.coordinator.model } } });
    }
    log('fresh-private-projects');
    stage = 'response-style-ui';
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
    // Complete only deterministic fresh-store onboarding; never import native history.
    for (let i = 0; i < 5; i++) {
      const skip = page.getByRole('button', { name: 'Do not import projects', exact: true }), next = page.getByRole('button', { name: 'Continue', exact: true }), project = page.locator('a[href*="/projects/"]').filter({ hasText: 'EasyChamp QA' }).first();
      await Promise.any([skip, next, project].map(x => x.waitFor({ state: 'visible', timeout: 30_000 })));
      if (await skip.isVisible()) await skip.click(); else if (await next.isVisible()) await next.click(); else break;
    }
    await page.goto(ORIGIN + '/settings/agents', { waitUntil: 'domcontentloaded' });
    const style = page.getByLabel('Response style', { exact: true }); await style.waitFor();
    await waitForReadyResponseStyle(style, 'Concise');
    const awaitSavedStyle = async value => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (persistedResponseStyle(readJson(join(dataDir, 'userdata/settings.json'))) === value) return;
        await pause(100);
      }
      throw new Error('response-style-not-saved');
    };
    await style.click(); await page.getByRole('option', { name: 'Detailed', exact: true }).click();
    await awaitSavedStyle('detailed');
    await page.reload({ waitUntil: 'domcontentloaded' }); await style.waitFor(); await waitForReadyResponseStyle(style, 'Detailed');
    log('response-style-detailed-saved-and-reloaded');
    await style.click(); await page.getByRole('option', { name: 'Concise', exact: true }).click();
    await awaitSavedStyle('concise');
    await page.reload({ waitUntil: 'domcontentloaded' }); await style.waitFor(); await waitForReadyResponseStyle(style, 'Concise');
    receipt.responseStyle = { detailedPersistedAndReloaded: true, concisePersistedAndReloaded: true, conciseDiskEncoding: Object.hasOwn(readJson(join(dataDir, 'userdata/settings.json')), 'responseStyle') ? 'explicit' : 'omitted-default' };
    await page.screenshot({ path: join(reportDir, 'response-style-concise.png'), fullPage: true }); log('response-style-saved-and-reloaded');
    stage = 'native-catalog';
    let ready = false; const catalogDeadline = Date.now() + 45_000;
    while (Date.now() < catalogDeadline) {
      const config = await rpc(context, scope, 'server.getConfig');
      ready = [review.coordinator, review.worker].every(p => config.providers.some(x => x.instanceId === p.instanceId && x.enabled && x.installed && x.status === 'ready' && x.auth?.status === 'authenticated' && x.availability !== 'unavailable' && x.models.some(m => m.slug === p.model)));
      if (ready) break; await pause(500);
    }
    invariant(ready, 'native-model-unavailable');
    running = true; monitor = (async () => { while (running) { try { await observe(); } catch (error) { guardError = error; running = false; await interrupt(); } if (running) await pause(150); } })();
    for (const project of projects) {
      stage = `${project.kind}-ui-dispatch`;
      await page.goto(ORIGIN, { waitUntil: 'domcontentloaded' });
      const entry = page.locator('a[href*="/projects/"]').filter({ hasText: project.title }).first(); await entry.waitFor(); await entry.click();
      const coordinator = page.getByRole('region', { name: 'Project coordinator', exact: true }); await coordinator.waitFor();
      const projectUrl = page.url(); const composer = page.getByLabel('Message the project coordinator', { exact: true }); await composer.fill(projectPrompt(project.kind));
      await composer.press('ControlOrMeta+Enter');
      const deadline = Date.now() + review.timeoutMs; let outcome, settledAt = null;
      while (Date.now() < deadline) {
        if (guardError) throw guardError;
        const parent = snapshots.get(`project-coordinator:${project.id}`), worker = [...snapshots.values()].find(p => p.thread.projectId === project.id && p.thread.id !== parent?.thread.id);
        if (parent && worker && parent.runs.length >= 2 && worker.runs.length === 1 && [...parent.runs, ...worker.runs].every(r => FINISHED.has(r.status))) {
          const delegated = parent.subagents.filter(s => s.origin === 'app_owned');
          invariant(delegated.length === 1 && delegated[0].childThreadId === worker.thread.id && delegated[0].status === 'completed', 'delegation-not-complete');
          invariant(['acknowledged', 'delivered'].includes(delegated[0].completionDelivery?.state), 'completion-not-delivered');
          const wake = [...parent.runs].sort((a, b) => a.ordinal - b.ordinal).at(-1);
          invariant(wake.delegatedCompletion, 'automatic-wake-missing');
          const textFor = (p, runId) => p.turnItems.filter(i => i.type === 'assistant_message' && i.runId === runId).map(i => i.text).join('\n');
          const workerText = textFor(worker, worker.runs[0].id), relayText = textFor(parent, wake.id);
          if (!workerText.trim() || !relayText.trim()) { await pause(250); continue; }
          settledAt ??= Date.now();
          if (Date.now() - settledAt < 750) { await pause(250); continue; }
          outcome = { worker, workerText, relayText, checks: validateOutput(workerText, relayText, worker.thread.id, briefs[project.kind]) }; break;
        } else settledAt = null;
        await pause(250);
      }
      invariant(outcome, 'native-cycle-timeout');
      // Retain completed inference before UI checks, so a visual failure never
      // erases useful output or justifies repeating subscription turns.
      writeFileSync(join(reportDir, `${project.kind}-brief.md`), outcome.workerText + '\n', { mode: 0o600 });
      writeFileSync(join(reportDir, `${project.kind}-relay.md`), outcome.relayText + '\n', { mode: 0o600 });
      const cycle = { kind: project.kind, projectId: project.id, workerId: outcome.worker.thread.id, checks: outcome.checks, autoRelay: true, sidepaneKeptCoordinator: false, sourceUnchanged: false };
      receipt.projects.push(cycle); save();
      stage = `${project.kind}-render-and-link`;
      await page.reload({ waitUntil: 'domcontentloaded' }); await coordinator.waitFor();
      const workerControl = page.locator('.project-conversation').getByRole('button', { name: `View thread ${outcome.worker.thread.title}`, exact: true });
      await workerControl.waitFor();
      await page.screenshot({ path: join(reportDir, `${project.kind}-coordinator.png`), fullPage: true });
      await workerControl.click();
      await page.waitForURL(url => isWorkerSidepaneRoute(url, projectUrl, outcome.worker.thread.id));
      await page.locator('.project-native-thread').waitFor();
      invariant(await coordinator.isVisible() && isWorkerSidepaneRoute(page.url(), projectUrl, outcome.worker.thread.id), 'coordinator-left-main-pane');
      invariant(await page.locator('.project-native-thread').getByText(outcome.worker.thread.title, { exact: true }).count() > 0 || await page.getByRole('heading', { name: outcome.worker.thread.title, exact: true }).count() > 0, 'worker-sidepane-missing');
      await page.locator('.project-native-thread [data-message-role="assistant"]').last().waitFor();
      invariant(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'horizontal-overflow');
      await page.screenshot({ path: join(reportDir, `${project.kind}-worker-sidepane.png`), fullPage: true });
      invariant(sha(readFileSync(join(project.workspaceRoot, 'README.md'))) === project.baseline && git(project.workspaceRoot, ['status', '--porcelain']) === '', 'scratch-source-modified');
      cycle.sidepaneKeptCoordinator = true; cycle.sourceUnchanged = true; log(`${project.kind}-passed`);
    }
    if (guardError) throw guardError;
    receipt.success = true; receipt.nativeProof = 'passed';
  } catch (error) {
    receipt.failure = { stage, code: /^[a-z0-9-]{3,80}$/.test(error?.message ?? '') ? error.message : 'private-details-omitted' }; receipt.nativeProof = 'failed'; process.exitCode = 1;
    if (page && !page.isClosed()) await page.screenshot({ path: join(reportDir, 'failure.png'), fullPage: true }).catch(() => {});
  } finally {
    running = false; if (monitor) await monitor;
    if (context) await interrupt();
    if (browser) await browser.close().catch(() => { receipt.browserCleanupUncertain = true; });
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await pause(100);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await pause(100);
    }
    receipt.ownedProcessStopped = !child || child.exitCode !== null || child.signalCode !== null;
    if (!receipt.ownedProcessStopped || guardError) { receipt.success = false; receipt.nativeProof = 'failed'; process.exitCode = 1; }
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
    receipt.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ receipt: join(reportDir, 'receipt.json'), success: receipt.success, nativeProof: receipt.nativeProof }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === ownPath) {
  if (process.argv.includes('--help')) console.log('coordinator-quality.mjs --mode inspect|execute --runtime-root ABS --easychamp-brief ABS.json --specweave-brief ABS.json [--review ABS.json --report-dir NEW_ABS_DIR --browser-deps NODE_MODULES --browser-executable ABS]\nBrief JSON: facts, mustMention and mustNotClaim string arrays. Execute requires a fresh reviewed native-only manifest; inspect prints exact bindings without native turns.');
  else run(parseOptions(process.argv.slice(2))).catch(() => { console.error('Coordinator QA preflight failed; private details omitted'); process.exitCode = 1; });
}
