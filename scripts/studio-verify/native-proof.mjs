import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

// Fixed, authenticated server RPC only. Tickets stay in memory; no URLs are logged.
export async function serverRpc(context, origin, tag, payload = {}) {
  const allowed = new Set(['server.getConfig', 'server.getSettings', 'orchestration.getTurnItem', 'orchestration.dispatchCommand']);
  assert.ok(allowed.has(tag), 'The verifier cannot dispatch arbitrary native commands');
  if (tag === 'orchestration.getTurnItem') {
    assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
    assert.deepEqual(Object.keys(payload).sort(), ['itemId', 'threadId'], 'Detail reads require only exact thread/item IDs');
    assert.ok(typeof payload.threadId === 'string' && payload.threadId.length > 0);
    assert.ok(typeof payload.itemId === 'string' && payload.itemId.length > 0);
  }
  if (tag === 'orchestration.dispatchCommand') {
    assert.ok(['thread.archive','thread.delete','run.interrupt'].includes(payload.type),'Only owned-fixture terminal archive/delete or bounded exact-run interrupt is allowed');
    assert.ok(typeof payload.threadId==='string'&&payload.threadId.length>0);
    if(payload.type==='run.interrupt')assert.ok(typeof payload.runId==='string'&&payload.runId.length>0);
  }
  const response = await context.request.post(origin + '/api/auth/websocket-ticket', { headers: { Origin: origin } });
  assert.equal(response.status(), 200);
  const { ticket } = await response.json();
  const url = new URL(origin); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'; url.pathname = '/ws'; url.searchParams.set('wsTicket', ticket); url.searchParams.set('orchestrationProtocol', '2');
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error('Authenticated observation RPC timed out')); }, 15000);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ _tag: 'Request', id: '1', tag, payload, headers: [] })));
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Authenticated observation RPC transport failed')); });
    ws.addEventListener('message', event => {
      let items; try { const value = JSON.parse(event.data); items = Array.isArray(value) ? value : [value]; } catch { return; }
      for (const item of items) {
        if (item._tag !== 'Exit' || String(item.requestId) !== '1') continue;
        clearTimeout(timer); ws.close();
        if (item.exit?._tag === 'Success') resolve(item.exit.value);
        else reject(new Error('Authenticated observation RPC failed: ' + tag));
      }
    });
  });
}

// Native config/read at the exact execution workspace, with no inference call.
export async function nativeRouteMetadata(binary, cwd, env, validateConfig, nativeThreadId) {
  const child = spawn(binary, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let nextId = 0;
  const pending = new Map();
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
    while (stdout.includes('\n')) {
      const end = stdout.indexOf('\n'); const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      let value; try { value = JSON.parse(line); } catch { continue; }
      const waiter = pending.get(value.id);
      if (!waiter) continue;
      pending.delete(value.id);
      value.error ? waiter.reject(new Error('Native metadata request failed')) : waiter.resolve(value.result);
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); }); // Private and never saved.
  async function request(method, params) {
    const id = ++nextId;
    return await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  const timer = setTimeout(() => { for (const p of pending.values()) p.reject(new Error('Native metadata timeout')); child.kill('SIGTERM'); }, 12000);
  try {
    await request('initialize', { clientInfo: { name: 'studio_verification', title: 'Studio verification', version: '1.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
    const config = (await request('config/read', { cwd, includeLayers: false })).config;
    const override = config?.model_providers?.openai;
    const canonical = config.chatgpt_base_url === 'https://chatgpt.com/backend-api/' || config.chatgpt_base_url === 'https://chatgpt.com/backend-api';
    const routeVerified = (config.model_provider == null || config.model_provider === 'openai') &&
      (config.forced_login_method == null || config.forced_login_method === 'chatgpt') &&
      (config.chatgpt_base_url == null || canonical) && config.openai_base_url == null &&
      (config.model_providers == null || (typeof config.model_providers === 'object' && !Array.isArray(config.model_providers))) &&
      (override == null || (typeof override === 'object' && !Array.isArray(override))) &&
      (override == null || ['base_url', 'websocket_base_url', 'env_key', 'http_headers', 'env_http_headers', 'experimental_bearer_token'].every(key => override[key] == null));
    const thread = nativeThreadId ? (await request('thread/read', { threadId: nativeThreadId, includeTurns: false })).thread : null;
    const turns = nativeThreadId ? await request('thread/turns/list', { threadId: nativeThreadId, limit: 10, cursor: null, sortDirection: 'desc', itemsView: 'summary' }) : null;
    return { modelProvider: config.model_provider == null ? null : config.model_provider==='openai' ? 'openai' : 'other',
      consumerLoginMethod: config.forced_login_method == null ? null : config.forced_login_method==='chatgpt' ? 'chatgpt' : 'other',
      routeVerified, endpointOverride: !routeVerified,
      deniedFields: ['model_provider', 'forced_login_method', 'chatgpt_base_url', 'openai_base_url'].filter(key =>
        key === 'model_provider' ? config[key] != null && config[key] !== 'openai' : key === 'forced_login_method' ? config[key] != null && config[key] !== 'chatgpt' : key === 'chatgpt_base_url' ? config[key] != null && !canonical : config[key] != null),
      canonicalChatgptBaseUrl: canonical,
      ...(validateConfig ? { reviewedGuardVerified: validateConfig(config) } : {}),
      ...(thread ? { nativeExecution: { modelProvider: thread.modelProvider == null ? null : thread.modelProvider==='openai' ? 'openai' : 'other', cwd: thread.cwd ?? null,
        observedTurnCount: turns.data.length, moreTurns: turns.nextCursor !== null } } : {}),
      overrideType: override == null ? null : typeof override,
      overrideConfigured:override!=null, observedAt: new Date().toISOString(), cwd };
  } finally {
    clearTimeout(timer); stdout = ''; stderr = ''; child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    await Promise.race([new Promise(done => child.once('exit', done)), new Promise(done => setTimeout(done, 3000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

export function safeProjection(projection) {
  const thread = projection.thread;
  return { threadId: thread.id, projectId: thread.projectId, providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, worktreePath: thread.worktreePath, branch: thread.branch,
    runs: projection.runs.map(run => ({ id: run.id, status: run.status, ordinal: run.ordinal, providerInstanceId: run.providerInstanceId,
      modelSelection: run.modelSelection, requestedAt: run.requestedAt, startedAt: run.startedAt, completedAt: run.completedAt, checkpointId: run.checkpointId })),
    providerThreadCount: projection.providerThreads.length, providerTurnCount: projection.providerTurns.length,
    nodeKinds: [...new Set(projection.nodes.map(node => node.kind))], nodeStatuses: [...new Set(projection.nodes.map(node => node.status))],
    checkpoints: projection.checkpoints.map(point => ({ id: point.id, runId: point.runId, ref: point.ref, status: point.status,
      ordinalWithinScope: point.ordinalWithinScope, files: point.files.map(file => ({ path: file.path, kind: file.kind })) })),
    checkpointScopes: projection.checkpointScopes.map(scope => ({ id: scope.id, cwd: scope.cwd })),
    pendingRequestKinds: projection.runtimeRequests.filter(r => r.status === 'pending').map(r => r.kind) };
}
