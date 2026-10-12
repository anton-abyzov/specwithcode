import assert from 'node:assert/strict';
import { join } from 'node:path';

const capacityPath = '/api/studio/capacity';
const protocol = { 'x-studio-orchestration-protocol': '2' };
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function dismissNotifications(page) {
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  for (let i = 0; i < 5 && await dismiss.count(); i++) {
    const clicked = await dismiss.first().elementHandle();
    await dismiss.first().click();
    // Track the clicked element, not a locator that can now resolve to the next toast.
    await clicked.waitForElementState('hidden', { timeout: 5000 });
  }
}

async function openOverview(page, origin) {
  await page.goto(origin + '/', { waitUntil: 'networkidle' });
  for (let i = 0; i < 2; i++) {
    const next = page.getByRole('button', { name: 'Continue', exact: true });
    if (await next.count()) { await next.click(); await sleep(300); }
  }
  const skip = page.getByRole('button', { name: 'Do not import projects', exact: true });
  if (await skip.count()) { await skip.click(); await sleep(1000); }
  await page.locator('.studio-desk').waitFor();
  await dismissNotifications(page);
}

/** Valid, deterministic capacity only. Native sessions and auth are never mocked. */
function fixtureSnapshot(now, aging = false) {
  const iso = value => new Date(value).toISOString();
  const observation = iso(now - (aging ? 14 * 60_000 + 55_000 : 30_000));
  const pool = 'codex:sha256:' + 'a'.repeat(64); // Synthetic fixture identity, not an account hash.
  const account = (id, status, overrides = {}) => ({
    id, provider: id.startsWith('codex') ? 'codex' : 'claude',
    label: id === 'codex-1' ? 'Codex primary — ' + 'long readable account label '.repeat(7) : id,
    authenticated: true, status, authError: null, providerInstanceId: id === 'codex-1' ? 'codex' : null,
    quotaPoolId: id.startsWith('codex') ? pool : null, quotaPoolObservedAt: iso(now - 30_000),
    quota: { window: { usedPercent: status === 'exhausted' ? 100 : 24, resetsAt: Math.floor((now + 3_600_000) / 1000) },
      weekly: { usedPercent: 55, resetsAt: Math.floor((now + 86_400_000) / 1000) },
      observedAt: observation, expiresAt: iso(now + (aging ? 5_000 : 14 * 60_000)),
      source: 'native-app-server', freshness: 'fresh' }, ...overrides,
  });
  return { schemaVersion: 1, observedAt: iso(now), source: 'specweave-switch', scope: 'environment-local',
    available: true, error: null, quotaPoolIdentity: 'partial', verifiedQuotaPoolCount: 1,
    accounts: [account('codex-1', 'ready'), account('codex-2', 'ready'), account('codex-3', 'exhausted'),
      account('codex-4', 'stale', { quota: { window: { usedPercent: 20, resetsAt: Math.floor((now + 3_600_000) / 1000) }, weekly: null,
        observedAt: iso(now - 60 * 60_000), expiresAt: iso(now - 45 * 60_000), source: 'native-app-server', freshness: 'stale' } }),
      account('claude-1', 'auth-required', { authenticated: false, quotaPoolId: null }),
      account('claude-2', 'blocked', { authenticated: null, authError: 'profile-isolation-unverified', quotaPoolId: null }),
      account('claude-3', 'unknown', { authenticated: null, quotaPoolId: null,
        quota: { window: null, weekly: null, observedAt: null, expiresAt: null, source: null, freshness: 'unknown' } })],
    policy: { mode: 'balanced', preferredProvider: null, selectedAccount: null },
    recommendations: [{ provider: 'any', id: 'codex-1', providerInstanceId: 'codex', reason: 'Deterministic visual fixture' }] };
}

export async function verifyScopedAuth({ browser, context, origin, step }) {
  const before = await (await context.request.get(origin + '/api/orchestration/shell', { headers: protocol })).json();
  const label = 'T05 temporary read-only verification';
  const issue = await context.request.post(origin + '/api/auth/pairing-token', { headers: { Origin: origin },
    data: { label, scopes: ['orchestration:read', 'diagnostics:read'] } });
  assert.equal(issue.status(), 200);
  const pairing = await issue.json(); // Credential is ephemeral and never logged or placed in a URL.
  const reader = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  try {
    const exchange = await reader.request.post(origin + '/api/auth/browser-session', { headers: { Origin: origin }, data: { credential: pairing.credential } });
    assert.equal(exchange.status(), 200);
    assert.equal((await reader.request.get(origin + capacityPath)).status(), 200);
    const denied = [];
    for (const [path, data] of [[capacityPath + '/refresh', {}], [capacityPath + '/policy', { mode: 'balanced' }], [capacityPath + '/select', { id: 'codex-1' }]]) {
      const response = await reader.request.post(origin + path, { headers: { Origin: origin }, data });
      assert.equal(response.status(), 403); denied.push({ path, status: response.status() });
    }
    const crossOrigin = await context.request.post(origin + capacityPath + '/refresh', { headers: { Origin: 'https://outside.invalid' }, data: {} });
    assert.equal(crossOrigin.status(), 403);
    step('scoped-http-denials', { issueStatus: 200, exchangeStatus: 200, readStatus: 200, denied, externalOriginStatus: 403 });
    const page = await reader.newPage();
    await openOverview(page, origin);
    const refresh = page.getByRole('button', { name: 'Refresh observations', exact: true });
    assert.ok(await refresh.count()); assert.equal(await refresh.first().isDisabled(), true);
    await page.getByRole('button', { name: 'New session', exact: true }).first().click();
    assert.ok(await page.getByText('No connected project is available', { exact: false }).count());
    const clientsResponse = await context.request.get(origin + '/api/auth/clients');
    assert.equal(clientsResponse.status(), 200);
    const clients = await clientsResponse.json();
    const client = clients.find(c => c.client?.label === label);
    assert.ok(client, 'The temporary scoped session must have attributable metadata');
    const revoke = await context.request.post(origin + '/api/auth/clients/revoke', { headers: { Origin: origin }, data: { sessionId: client.sessionId } });
    assert.equal(revoke.status(), 200); assert.equal((await revoke.json()).revoked, true);
    assert.equal((await reader.request.get(origin + capacityPath)).status(), 401);
    const after = await (await context.request.get(origin + '/api/orchestration/shell', { headers: protocol })).json();
    assert.equal(after.threads.length, before.threads.length);
    step('scoped-auth-real-server', { issueStatus: 200, exchangeStatus: 200, readStatus: 200,
      denied, externalOriginStatus: 403, disabledReadOnlyControls: true, noDraftCreated: true, temporarySessionRevoked: true });
  } finally {
    pairing.credential = '';
    await context.request.post(origin + '/api/auth/pairing-links/revoke', { headers: { Origin: origin }, data: { id: pairing.id } });
    await reader.close();
  }
}

export async function verifyNotifications({ browser, context, origin, reportDir, receipt, step, save }) {
  const cookies = (await context.storageState()).cookies; // Ephemeral cookie transfer within this owned verifier only.
  for (const width of [390, 1440]) {
    const fresh = await browser.newContext({ viewport: { width, height: width === 1440 ? 1000 : 844 },
      reducedMotion: 'reduce', storageState: { cookies, origins: [] } });
    try {
      const page = await fresh.newPage();
      await page.goto(origin + '/', { waitUntil: 'networkidle' });
      for (let i = 0; i < 2; i++) {
        const next = page.getByRole('button', { name: 'Continue', exact: true });
        if (await next.count()) { await next.click(); await sleep(300); }
      }
      const skip = page.getByRole('button', { name: 'Do not import projects', exact: true });
      if (await skip.count()) { await skip.click(); await sleep(1000); }
      await page.locator('.studio-desk').waitFor();
      const button = page.getByRole('button', { name: 'New session', exact: true }).first();
      const toastCount = await page.locator('[data-slot=toast-close]').count();
      const bounds = await page.locator('[data-position].dropdown-glass').evaluateAll(nodes => nodes.map(node => {
        const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
          ending: node.hasAttribute('data-ending-style'), transition: getComputedStyle(node).transitionDuration };
      }));
      let obstructed = false;
      try { await button.click({ trial: true, timeout: 1500 }); } catch { obstructed = true; }
      const before = join(reportDir, `actual-notification-${width}-before.png`);
      await page.screenshot({ path: before }); receipt.screenshots.push({ path: before, width, evidenceKind: 'real-provider-notification-before-dismissal' }); save();
      await dismissNotifications(page);
      await button.click({ trial: true, timeout: 3000 });
      const after = join(reportDir, `actual-notification-${width}-dismissed.png`);
      await page.screenshot({ path: after }); receipt.screenshots.push({ path: after, width, evidenceKind: 'real-provider-notification-normal-dismissal' }); save();
      step('real-notification-usability', { width, toastCount, toastBounds: bounds, primaryObstructedBeforeDismissal: obstructed,
        primaryAvailableAfterNormalDismissal: true, noDraftCreated: true, forcedClick: false });
    } finally { await fresh.close(); }
  }
}

export async function verifyLayouts({ context, page, origin, reportDir, receipt, step, save }) {
  const posts = [];
  const observe = request => { if (new URL(request.url()).pathname.startsWith(capacityPath) && request.method() !== 'GET') posts.push(request.method()); };
  page.on('request', observe);
  const before = await (await context.request.get(origin + '/api/orchestration/shell', { headers: protocol })).json();
  try {
    for (const width of [320, 390, 1440]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await openOverview(page, origin);
      assert.equal(new URL(page.url()).hash, '');
      const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
        desk: document.querySelector('.studio-desk').scrollWidth, deskWidth: document.querySelector('.studio-desk').clientWidth,
        scroll: document.querySelector('.studio-scroll').scrollWidth, scrollWidth: document.querySelector('.studio-scroll').clientWidth }));
      assert.ok(overflow.document <= overflow.viewport + 1, 'The page must fit the viewport');
      assert.ok(overflow.desk <= overflow.deskWidth + 1 && overflow.scroll <= overflow.scrollWidth + 1, 'The desk must not horizontally overflow');
      const newSession = page.getByRole('button', { name: 'New session', exact: true }).first();
      assert.ok((await newSession.boundingBox()).height >= 44);
      const path = join(reportDir, `actual-overview-${width}-${theme}.png`);
      await page.screenshot({ path }); receipt.screenshots.push({ path, width, theme, reducedMotion: true, evidenceKind: 'real-isolated-overview' }); save();
      step('real-layout', { width, theme, overflow, primaryTouchHeight: (await newSession.boundingBox()).height });
    }
    // Real navigation uses inherited settings surfaces; no action launches a provider.
    for (const [label, path] of [['Manage projects', '/settings/projects'], ['Connections', '/settings/connections'], ['Providers', '/settings/providers']]) {
      await openOverview(page, origin);
      await page.getByRole('link', { name: label, exact: true }).first().click();
      await page.waitForURL(url => url.pathname === path);
      step('real-navigation', { label, path });
    }
    await context.route('**/api/studio/capacity', async route => {
      assert.equal(route.request().method(), 'GET', 'Visual fixtures cannot permit capacity writes');
      await route.fulfill({ json: fixtureSnapshot(Date.now()) });
    });
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      await openOverview(page, origin);
      await page.locator('.studio-fleet').scrollIntoViewIfNeeded();
      const more = page.getByRole('button', { name: /Show \d+ more prepared profiles/ });
      if (await more.count()) await more.click();
      assert.ok(await page.getByText('1 verified quota pool', { exact: true }).count());
      for (const status of ['At limit', 'Stale observation', 'Sign-in required', 'Verification required', 'Auth unverified']) assert.ok(await page.getByText(status, { exact: true }).count(), status);
      assert.ok(await page.getByText(/Resets .* E[SD]T/).count(), 'Reset labels need explicit Eastern timezone');
      assert.equal(await page.locator('.studio-account').filter({ hasText: 'codex-3' }).getByRole('button', { name: 'Prefer', exact: true }).isDisabled(), true);
      const metrics = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, scroll: document.querySelector('.studio-scroll').scrollWidth, client: document.querySelector('.studio-scroll').clientWidth }));
      assert.ok(metrics.document <= metrics.viewport + 1 && metrics.scroll <= metrics.client + 1, 'Long fixture labels must wrap');
      for (const accountIndex of [0, 2, 4, 6]) {
        await page.locator('.studio-account').nth(accountIndex).scrollIntoViewIfNeeded();
        const path = join(reportDir, `fixture-capacity-${width}-dark-account-${accountIndex + 1}.png`);
        await page.screenshot({ path }); receipt.screenshots.push({ path, width, theme: 'dark', evidenceKind: 'deterministic-capacity-fixture', accountIndex,
          states: ['long-label', 'shared-pool', 'stale', 'auth-required', 'exhausted', 'blocked', 'unknown'] }); save();
      }
    }
    step('deterministic-capacity-layouts', { widths: [320, 390, 1440], overflow: false,
      sharedPoolDeduplicated: true, timezone: 'America/New_York', exhaustedPreferenceDisabled: true,
      states: ['long-label', 'shared-pool', 'stale', 'auth-required', 'exhausted', 'blocked', 'unknown'] });
    await context.unroute('**/api/studio/capacity');
    const agingNow = Date.now();
    // Install before mounting: clocks installed afterward cannot own an existing setInterval.
    await page.clock.install({ time: new Date(agingNow) });
    await context.route('**/api/studio/capacity', route => route.fulfill({ json: fixtureSnapshot(agingNow, true) }));
    await openOverview(page, origin);
    const primary = page.locator('.studio-account').filter({ hasText: 'Codex primary' });
    assert.equal(await primary.getByRole('button', { name: 'Prefer', exact: true }).isEnabled(), true);
    await page.clock.fastForward(31_000);
    for (let i = 0; i < 20 && !(await primary.getByRole('button', { name: 'Prefer', exact: true }).isDisabled()); i++) await sleep(100);
    assert.equal(await primary.getByRole('button', { name: 'Prefer', exact: true }).isDisabled(), true);
    assert.ok(await page.getByText('Independent capacity unknown', { exact: true }).count());
    step('display-only-expiry', { fastForwardMs: 31_000, preferenceDisabledAfterExpiry: true, independentPoolExpired: true, capacityMutations: posts.length });
    await context.unroute('**/api/studio/capacity');
    await page.clock.resume();
    await context.setOffline(true);
    await page.waitForTimeout(400);
    assert.ok(await page.getByText('This device is offline.', { exact: false }).count());
    const offlinePath = join(reportDir, 'actual-offline-overview.png');
    await page.screenshot({ path: offlinePath }); receipt.screenshots.push({ path: offlinePath, evidenceKind: 'real-browser-offline-state' }); save();
    await context.setOffline(false);
    await openOverview(page, origin);
    const after = await (await context.request.get(origin + '/api/orchestration/shell', { headers: protocol })).json();
    assert.equal(after.threads.length, before.threads.length);
    assert.equal(posts.length, 0, 'Overview, clock, offline and settings navigation must not refresh native quota or write capacity');
    step('overview-passive-no-write', { nativeRefreshesOrCapacityWrites: posts.length, noAutoDraft: true, reconnected: true });
  } finally { page.off('request', observe); await context.unroute('**/api/studio/capacity'); await context.setOffline(false); }
}
