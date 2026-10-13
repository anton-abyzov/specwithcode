import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalCandidate, briefContext, isWorkerSidepaneRoute, makeScope, observeQuality, parseOptions, persistedResponseStyle, projectPrompt, readBrief, validateOutput, validateAutomaticWake, validateReview, validateTool, waitForReadyResponseStyle } from './coordinator-quality.mjs';
import { APPROVAL_OPTIONS } from './native-approval.mjs';

const now = Date.parse('2026-10-13T12:00:00Z');
function manifest() {
  const observed = { sourceCommit: 'a'.repeat(40), buildSha256: 'b'.repeat(64), toolingSha256: 'c'.repeat(64), briefs: { easychamp: 'd'.repeat(64), specweave: 'e'.repeat(64) }, sourceDirty: false, toolingDirty: false };
  const profile = { instanceId: 'codex', model: 'gpt-6.1-sol', binaryPath: '/owned/codex', binarySha256: 'f'.repeat(64) };
  const review = { schemaVersion: 1, authorization: 'two-realistic-coordinator-ui-cycles', sourceCommit: observed.sourceCommit, buildSha256: observed.buildSha256, toolingSha256: observed.toolingSha256, briefs: observed.briefs, expiresAt: new Date(now + 60_000).toISOString(), coordinator: profile, worker: profile, maxRuns: 8, timeoutMs: 240_000 };
  return { observed, review };
}
function fixture() {
  const { review } = manifest(), projectId = 'owned-project', threadId = `project-coordinator:${projectId}`;
  const scope = makeScope([{ id: projectId }], review);
  const owner = { runId: 'run', providerThreadId: 'provider', providerTurnId: 'turn' };
  const call = { ...owner, id: 'call', nodeId: 'tool', type: 'dynamic_tool', toolName: 'studio-code.delegate_task', input: { task: 'Prepare the requested video brief using supplied project facts only; use no tools.', mode: 'async' }, status: 'running', ordinal: 1 };
  const projection = {
    thread: { id: threadId, projectId, modelSelection: { instanceId: 'codex', model: 'gpt-6.1-sol' } },
    runs: [{ id: 'run', threadId, status: 'running', providerThreadId: 'provider', activeAttemptId: 'attempt' }],
    attempts: [{ id: 'attempt', runId: 'run', providerTurnId: 'turn', providerThreadId: 'provider', status: 'running' }],
    providerTurns: [{ id: 'turn', runAttemptId: 'attempt', providerThreadId: 'provider', status: 'running' }],
    providerThreads: [{ id: 'provider', appThreadId: threadId, providerSessionId: 'session', driver: 'codex' }],
    providerSessions: [{ id: 'session', driver: 'codex', providerInstanceId: 'codex', status: 'running' }],
    subagents: [], nodes: [],
    runtimeRequests: [{ id: 'request', nodeId: 'approval-node', providerTurnId: 'turn', kind: 'mcp-elicitation', status: 'pending', nativeRequestRef: { driver: 'codex', nativeId: 'mcp-elicitation:studio-code' }, responseCapability: { type: 'live', providerSessionId: 'session' } }],
    turnItems: [call, { ...owner, id: 'approval', nodeId: 'approval-node', requestId: 'request', type: 'approval_request', status: 'waiting', appName: 'studio-code', requestKind: 'mcp-elicitation', options: APPROVAL_OPTIONS, prompt: 'Allow the studio-code MCP server to run tool "delegate_task"?', ordinal: 2 }],
  };
  return { scope, projection, call };
}

test('inspect is the default and cannot consume an execution review', () => {
  const args = ['--runtime-root', '/repo', '--easychamp-brief', '/e.json', '--specweave-brief', '/s.json'];
  assert.equal(parseOptions(args)['--mode'], 'inspect');
  assert.throws(() => parseOptions([...args, '--review', '/review.json']), /inspect-cannot-execute/);
  assert.throws(() => parseOptions([...args, '--mode', 'execute']), /execution-inputs-required/);
  assert.throws(() => parseOptions([...args, '--headless', 'false']), /invalid-options/);
  assert.throws(() => parseOptions([...args, '--runtime-root', '/other']), /invalid-options/);
});

test('review pins build, source, tooling, both briefs, native binaries and a short execution window', () => {
  const { observed, review } = manifest();
  assert.equal(validateReview(review, observed, now), review);
  for (const key of ['sourceCommit', 'buildSha256', 'toolingSha256']) assert.throws(() => validateReview({ ...review, [key]: 'wrong' }, observed, now), /review-binding/);
  assert.throws(() => validateReview({ ...review, briefs: { ...review.briefs, easychamp: 'changed' } }, observed, now));
  assert.throws(() => validateReview(review, { ...observed, sourceDirty: true }, now), /dirty-source/);
  assert.throws(() => validateReview(review, { ...observed, toolingDirty: true }, now), /dirty-source/);
  for (const delta of [-1, 3_600_001]) assert.throws(() => validateReview({ ...review, expiresAt: new Date(now + delta).toISOString() }, observed, now), /review-expiry/);
  assert.throws(() => validateReview({ ...review, maxRuns: 100 }, observed, now), /review-budget/);
  assert.throws(() => validateReview({ ...review, timeoutMs: 999_999 }, observed, now), /review-budget/);
  assert.throws(() => validateReview({ ...review, coordinator: { ...review.coordinator, instanceId: 'openai-api' } }, observed, now), /review-native-provider/);
  assert.throws(() => validateReview({ ...review, worker: { ...review.worker, binaryPath: '/other-codex' } }, observed, now), /profile-binary-conflict/);
});

test('brief parser accepts bounded factual JSON and rejects unreviewed fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'coordinator-brief-test-')), path = join(directory, 'brief.json');
  try {
    writeFileSync(path, JSON.stringify({ facts: ['EasyChamp organizes sports competitions.'], mustMention: ['EasyChamp'], mustNotClaim: ['guaranteed viral'] }));
    const brief = readBrief(path); assert.match(brief.sha256, /^[a-f0-9]{64}$/); assert.match(briefContext(brief), /EasyChamp organizes sports competitions/);
    writeFileSync(path, JSON.stringify({ facts: [], mustMention: [], mustNotClaim: [] })); assert.throws(() => readBrief(path), /empty-brief/);
    writeFileSync(path, JSON.stringify({ facts: ['fact'], mustMention: ['fact'], mustNotClaim: [], execute: 'something' })); assert.throws(() => readBrief(path), /invalid-brief-fields/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('realistic prompts ask for substantive useful output and forbid external effects', () => {
  assert.match(projectPrompt('easychamp'), /timed script, shot list and CTA/);
  assert.match(projectPrompt('specweave'), /missing gates and the next three verification steps/);
  for (const kind of ['easychamp', 'specweave']) { assert.match(projectPrompt(kind), /one worker/); assert.match(projectPrompt(kind), /No shell, filesystem, browser, network, publishing, schedules or extra workers/); assert.match(projectPrompt(kind), /Do not poll/); }
});

test('format checks preserve a substantive worker brief and demand a short linked relay', () => {
  const workerId = 'thread:delegated-task:one', brief = { mustMention: ['EasyChamp'], mustNotClaim: ['guaranteed viral'] };
  const output = `# EasyChamp concept\n\n${'Verified sports competition facts shape the timed video brief and its practical call to action. '.repeat(14)}\n- Film authentic sports footage.`;
  const relay = `The EasyChamp brief is ready, with a timed script and shot list. [View the worker](studio://thread/${encodeURIComponent(workerId)})`;
  assert.equal(validateOutput(output, relay, workerId, brief).workerLinked, true);
  assert.throws(() => validateOutput(output.replace('EasyChamp', 'Something'), relay, workerId, brief), /required-fact-missing/);
  assert.throws(() => validateOutput(output + ' guaranteed viral', relay, workerId, brief), /forbidden-claim/);
  assert.throws(() => validateOutput(output, 'No worker link in this response.', workerId, brief), /relay-worker-link/);
  assert.throws(() => validateOutput(output, relay + ' word'.repeat(160), workerId, brief), /relay-not-concise/);
  assert.throws(() => validateOutput(output, relay + ' mcp__private', workerId, brief), /relay-internal-leak/);
});

test('observed runs preserve exceeded budgets and reject foreign projects and native subagents', () => {
  const { scope, projection } = fixture(); observeQuality(scope, projection); assert.equal(scope.runs.size, 1);
  assert.throws(() => observeQuality(scope, { ...projection, thread: { ...projection.thread, projectId: 'foreign' } }), /foreign-project/);
  assert.throws(() => observeQuality(scope, { ...projection, subagents: [{ origin: 'provider_native' }] }), /native-subagent-refused/);
  assert.throws(() => observeQuality(scope, { ...projection, runs: Array.from({ length: 9 }, (_, i) => ({ id: `run${i}`, status: 'running' })) }), /native-run-budget/);
  assert.equal(scope.runs.size, 10, 'over-budget observations must remain in evidence');
});

test('a smaller reviewed run budget preserves the cumulative cap after an earlier attempt', () => {
  const { observed, review } = manifest();
  for (const maxRuns of [1, 7, 8]) assert.equal(validateReview({ ...review, maxRuns }, observed, now).maxRuns, maxRuns);
  for (const maxRuns of [0, -1, 9, 7.5, '7']) assert.throws(() => validateReview({ ...review, maxRuns }, observed, now), /review-budget/);
  const { scope, projection } = fixture(); scope.review.maxRuns = 7;
  for (let i = 0; i < 7; i++) observeQuality(scope, { ...projection, runs: [{ id: `run${i}`, status: 'running' }] });
  assert.throws(() => observeQuality(scope, { ...projection, runs: [{ id: 'run7', status: 'running' }] }), /native-run-budget/);
  assert.equal(scope.runs.size, 8, 'over-budget evidence remains retained');
});

test('exactly one local async worker can be delegated and no workspace permission can be broadened', () => {
  for (const [input, message] of [[{ mode: 'wait' }, /invalid-delegation/], [{ runtimeMode: 'full-access' }, /worker-permission-escalation/], [{ machine: 'remote' }, /remote-worker-refused/], [{ target: { providerInstanceId: 'paid-api', model: 'gpt-6.1-sol' } }, /worker-model-changed/]]) {
    const { scope, projection, call } = fixture(); assert.throws(() => validateTool(scope, projection, { ...call, input: { ...call.input, ...input } }), message);
  }
  const { scope, projection, call } = fixture(); validateTool(scope, projection, call);
  assert.throws(() => validateTool(scope, projection, { ...call, id: 'another' }), /extra-delegation/);
  assert.throws(() => validateTool(scope, projection, { ...call, input: { ...call.input, task: call.input.task + ' altered' } }), /tool input changed/);
  assert.throws(() => validateTool(scope, projection, { ...call, toolName: 'studio-code.schedule_task' }), /unapproved-tool/);
  assert.throws(() => validateTool(scope, { ...projection, thread: { ...projection.thread, id: 'worker' } }, call), /worker-used-tool/);
});

test('approval is bound to one live Studio call, run, attempt, native turn and session', () => {
  const { scope, projection } = fixture(); observeQuality(scope, projection);
  const candidate = approvalCandidate(scope, projection); assert.equal(candidate.op, 'delegate_task');
  scope.approvals.set(candidate.requestId, candidate); assert.equal(approvalCandidate(scope, projection), null, 'never submit the same approval twice');
  for (const mutate of [
    p => { p.runtimeRequests[0].kind = 'command'; },
    p => { p.runtimeRequests[0].nativeRequestRef.nativeId = 'mcp-elicitation:external'; },
    p => { p.runtimeRequests[0].responseCapability.type = 'message'; },
    p => { p.turnItems[1].prompt = 'Run this shell command?'; },
    p => { p.attempts[0].providerTurnId = 'foreign-turn'; },
    p => { p.providerTurns[0].runAttemptId = 'foreign-attempt'; },
    p => { p.providerThreads[0].providerSessionId = 'foreign-session'; },
    p => { p.providerSessions[0].driver = 'other'; },
  ]) {
    const f = fixture(); mutate(f.projection); assert.throws(() => approvalCandidate(f.scope, f.projection));
  }
});

test('native approval accepts a nullable forward turn link only with one exact active reverse binding', () => {
  const realShape = () => {
    const f = fixture();
    // Native run-attempt.updated retains null; provider-turn.updated owns the reverse link.
    f.projection.attempts[0].providerTurnId = null;
    f.projection.providerSessions[0].status = 'ready';
    return f;
  };
  const valid = realShape();
  assert.equal(approvalCandidate(valid.scope, valid.projection).providerTurnId, 'turn');
  for (const mutate of [
    p => { p.attempts[0].providerTurnId = undefined; },
    p => { p.attempts[0].providerTurnId = 'conflicting-turn'; },
    p => { p.attempts[0].runId = 'foreign-run'; },
    p => { p.attempts[0].providerThreadId = 'foreign-provider'; },
    p => { p.attempts[0].status = 'completed'; },
    p => { p.providerTurns[0].runAttemptId = 'foreign-attempt'; },
    p => { p.providerTurns[0].providerThreadId = 'foreign-provider'; },
    p => { p.providerTurns[0].status = 'completed'; },
    p => { p.providerTurns.push({ ...p.providerTurns[0], id: 'ambiguous-turn' }); },
    p => { p.providerTurns.push({ ...p.providerTurns[0] }); },
    p => { p.providerThreads[0].providerSessionId = 'foreign-session'; },
    ...['starting', 'stopped', 'error', 'queued', undefined].map(status => p => { p.providerSessions[0].status = status; }),
  ]) {
    const f = realShape(); mutate(f.projection);
    assert.throws(() => approvalCandidate(f.scope, f.projection));
  }
  const previous = realShape();
  previous.projection.providerTurns.push({ ...previous.projection.providerTurns[0], id: 'older-completed-turn', status: 'completed' });
  assert.equal(approvalCandidate(previous.scope, previous.projection).providerTurnId, 'turn');
});

test('incomplete approval publication never authorizes a request', () => {
  const { scope, projection } = fixture(); projection.turnItems.pop(); assert.equal(approvalCandidate(scope, projection), null);
});


test('worker side-pane routing keeps the exact project and other route parameters', () => {
  const project = 'http://127.0.0.1:8433/projects/local%3Aeasychamp?checkout=feature%2Fvideo&view=plan';
  const workerId = 'thread:delegated-task:video/one';
  const worker = new URL(project); worker.searchParams.set('thread', workerId);
  assert.equal(isWorkerSidepaneRoute(worker, project, workerId), true);
  const reordered = new URL(worker); reordered.searchParams.sort();
  assert.equal(isWorkerSidepaneRoute(reordered, project, workerId), true, 'query order is not route identity');
  const previousSelection = new URL(project); previousSelection.searchParams.set('thread', 'previous-worker');
  assert.equal(isWorkerSidepaneRoute(worker, previousSelection, workerId), true, 'a prior thread can be replaced');
  for (const mutate of [
    url => { url.host = '127.0.0.1:8434'; },
    url => { url.protocol = 'https:'; },
    url => { url.pathname = '/projects/local%3Aspecweave'; },
    url => { url.pathname = '/thread/' + encodeURIComponent(workerId); },
    url => { url.searchParams.delete('thread'); },
    url => { url.searchParams.set('thread', 'another-worker'); },
    url => { url.searchParams.append('thread', workerId); },
    url => { url.searchParams.delete('checkout'); },
    url => { url.searchParams.set('checkout', 'other-checkout'); },
    url => { url.searchParams.append('checkout', 'feature/video'); },
    url => { url.searchParams.set('extra', 'changed'); },
  ]) {
    const changed = new URL(worker); mutate(changed);
    assert.equal(isWorkerSidepaneRoute(changed, project, workerId), false, changed.href);
  }
  assert.equal(isWorkerSidepaneRoute(project, project, workerId), false, 'unchanged project URL has no selected worker');
  assert.equal(isWorkerSidepaneRoute('not a URL', project, workerId), false);
  assert.equal(isWorkerSidepaneRoute(worker, 'not a URL', workerId), false);
  assert.equal(isWorkerSidepaneRoute(worker, project, ''), false);
});


test('response-style persistence waits for an enabled control with the expected hydrated value', async () => {
  let elapsed = 0, state = 0, textReads = 0;
  const states = [
    { enabled: false, text: 'Detailed' },
    { enabled: true, text: 'Concise' },
    { enabled: true, text: 'Detailed' },
  ];
  const control = {
    isEnabled: async () => states[state].enabled,
    innerText: async () => { textReads++; return states[state].text; },
  };
  await waitForReadyResponseStyle(control, 'Detailed', {
    timeoutMs: 1000, now: () => elapsed,
    sleep: async ms => { elapsed += ms; state++; },
  });
  assert.equal(state, 2, 'neither the disabled default nor enabled stale value establishes persistence');
  assert.equal(textReads, 2);
});

test('response-style persistence fails within the bound when connection or saved value never arrives', async () => {
  for (const current of [{ enabled: false, text: 'Detailed' }, { enabled: true, text: 'Concise' }]) {
    let elapsed = 0;
    await assert.rejects(waitForReadyResponseStyle({
      isEnabled: async () => current.enabled, innerText: async () => current.text,
    }, 'Detailed', { timeoutMs: 250, now: () => elapsed, sleep: async ms => { elapsed += ms; } }), /detailed-setting-not-persisted/);
    assert.equal(elapsed, 250);
  }
});


test('persisted response-style readback accepts omitted concise defaults but rejects invalid stored values', () => {
  assert.equal(persistedResponseStyle({}), 'concise');
  assert.equal(persistedResponseStyle({ responseStyle: 'concise' }), 'concise');
  assert.equal(persistedResponseStyle({ responseStyle: 'detailed' }), 'detailed');
  for (const responseStyle of [null, '', 'verbose', false])
    assert.throws(() => persistedResponseStyle({ responseStyle }), /invalid-persisted-response-style/);
  for (const value of [null, [], 'concise'])
    assert.throws(() => persistedResponseStyle(value), /invalid-persisted-settings/);
});


test('automatic completion is bound through its canonical server-created user message and acknowledged task', () => {
  const fixture = () => ({
    parent: { thread: { id: 'parent' }, runs: [{ id: 'original', ordinal: 1, delegatedCompletion: { nextGeneration: 2 } }, { id: 'wake', ordinal: 2 }],
      subagents: [{ id: 'task', origin: 'app_owned', threadId: 'parent', runId: 'original', childThreadId: 'child', status: 'completed', completionWake: 'always', completionDelivery: { state: 'acknowledged', observedByRunId: 'wake' } }],
      messages: [{ id: 'wake-message', threadId: 'parent', runId: 'wake', role: 'user', createdBy: 'agent', creationSource: 'server', delegatedCompletion: { parentRunId: 'original', generation: 1, taskIds: ['task'] } }] },
    worker: { thread: { id: 'child' } }, wake: { id: 'wake', ordinal: 2, userMessageId: 'wake-message' },
  });
  const good = fixture(); assert.equal(validateAutomaticWake(good.parent, good.worker, good.wake).generation, 1);
  for (const mutate of [
    f => { f.wake.userMessageId = 'foreign'; },
    f => { f.parent.messages[0].createdBy = 'user'; },
    f => { f.parent.messages[0].creationSource = 'web'; },
    f => { f.parent.messages[0].role = 'assistant'; },
    f => { f.parent.messages[0].runId = 'foreign'; },
    f => { f.parent.messages[0].threadId = 'foreign'; },
    f => { f.parent.messages[0].delegatedCompletion.parentRunId = 'foreign'; },
    f => { f.parent.messages[0].delegatedCompletion.generation = 0; },
    f => { f.parent.messages[0].delegatedCompletion.generation = 2; },
    f => { f.parent.messages[0].delegatedCompletion.taskIds = ['foreign']; },
    f => { f.parent.messages[0].delegatedCompletion.taskIds.push('task'); },
    f => { f.parent.subagents[0].completionDelivery.observedByRunId = 'foreign'; },
    f => { f.parent.subagents[0].completionDelivery.state = 'pending'; },
    f => { f.parent.subagents[0].childThreadId = 'foreign'; },
    f => { f.parent.subagents.push({ ...f.parent.subagents[0] }); },
    f => { f.parent.messages.push({ ...f.parent.messages[0] }); },
  ]) { const f = fixture(); mutate(f); assert.throws(() => validateAutomaticWake(f.parent, f.worker, f.wake)); }
});

test('reviewed project selection can continue only the unexecuted SpecWeave cycle', () => {
  const { review, observed } = manifest();
  assert.deepEqual(validateReview({ ...review, projectKinds: ['specweave'], maxRuns: 4 }, observed, now).projectKinds, ['specweave']);
  for (const projectKinds of [[], ['easychamp'], ['foreign'], ['specweave','specweave'], 'specweave'])
    assert.throws(() => validateReview({ ...review, projectKinds }, observed, now), /review-project-selection/);
});
