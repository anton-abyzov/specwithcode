// Headless end-to-end check of the Google account against the built server.
//
// Runs the real server in a new private home with STUDIO_GOOGLE_API_URL
// pointed at a local fake Google (consent screen, token, revoke). Saves an
// OAuth client from Settings > Google, signs in through the fake consent
// redirect, turns Gmail on for a Personal project, opens the morning briefing
// template, signs in again by pasting the redirect address, and disconnects.
// No real Google account, provider turn or personal browser is involved.
//
// Usage: node scripts/studio-google/verify.mjs /absolute/report-dir
// Use --frozen-108 only when checking the frozen 1.0.8 build, before the chat-link follow-up.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const out = NodePath.resolve(process.argv[2] ?? ".studio-build-evidence/google");
// The linked chat editor follow-up is tested separately from the frozen 1.0.8 candidate.
const verifyLinkedEditors = !process.argv.includes("--frozen-108");
NodeFS.mkdirSync(out, { recursive: true });
const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-google-"));
NodeFS.mkdirSync(NodePath.join(state, "userdata"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(state, "userdata/settings.json"),
  JSON.stringify({ providerInstances: {} }),
);

const CLIENT_ID = "123456789012-verifystudio.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-verify-client-secret-01";
const REFRESH_TOKEN = "1//verify-refresh-token-value";
const EMAIL = "verifier@example.com";
const freePort = () =>
  new Promise((done, reject) => {
    const socket = NodeNet.createServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const port = socket.address().port;
      socket.close(() => done(port));
    });
  });

// A fake Google: the consent screen approves at once and redirects back with
// a code; the token endpoint checks the client, the redirect and PKCE.
const challenges = new Map();
const google = { authorizations: [], exchanges: 0, revoked: [] };
const base64Url = (buffer) => buffer.toString("base64url");
const googlePort = await freePort();
const fakeGoogle = NodeHttp.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${googlePort}`);
    const json = (status, value) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/o/oauth2/v2/auth") {
      const params = Object.fromEntries(url.searchParams);
      google.authorizations.push(params);
      const code = `code-${google.authorizations.length}`;
      challenges.set(code, {
        challenge: params.code_challenge,
        redirectUri: params.redirect_uri,
        scope: params.scope,
      });
      const back = new URL(params.redirect_uri);
      back.searchParams.set("state", params.state);
      back.searchParams.set("code", code);
      response.writeHead(302, { location: back.toString() });
      response.end();
      return;
    }
    const form = new URLSearchParams(body);
    if (url.pathname === "/token") {
      const issued = challenges.get(form.get("code"));
      const verifier = form.get("code_verifier") ?? "";
      const pkce = base64Url(NodeCrypto.createHash("sha256").update(verifier).digest());
      if (
        form.get("client_id") !== CLIENT_ID ||
        form.get("client_secret") !== CLIENT_SECRET ||
        !issued ||
        issued.challenge !== pkce ||
        issued.redirectUri !== form.get("redirect_uri")
      ) {
        return json(400, { error: "invalid_grant" });
      }
      challenges.delete(form.get("code"));
      google.exchanges++;
      return json(200, {
        access_token: `access-${google.exchanges}`,
        expires_in: 3599,
        refresh_token: REFRESH_TOKEN,
        scope: issued.scope
          .split(" ")
          .filter((scope) => scope.startsWith("https://"))
          .join(" "),
        id_token: `h.${base64Url(Buffer.from(JSON.stringify({ email: EMAIL })))}.s`,
      });
    }
    if (url.pathname === "/revoke") {
      google.revoked.push(form.get("token"));
      return json(200, {});
    }
    json(404, { error: "not_found" });
  });
});
await new Promise((done) => fakeGoogle.listen(googlePort, "127.0.0.1", done));

const port = await freePort();
const origin = `http://127.0.0.1:${port}`;
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    NodePath.join(root, "apps/server/dist/bin.mjs"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    state,
    "--no-browser",
  ],
  {
    cwd: state,
    env: {
      PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: state,
      CODEX_HOME: NodePath.join(state, "codex"),
      CLAUDE_CONFIG_DIR: NodePath.join(state, "claude"),
      XDG_CONFIG_HOME: NodePath.join(state, "config"),
      XDG_CACHE_HOME: NodePath.join(state, "cache"),
      LANG: "en_US.UTF-8",
      STUDIO_GOOGLE_API_URL: `http://127.0.0.1:${googlePort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverLog = "";
child.stdout.on("data", (chunk) => (serverLog += chunk));
child.stderr.on("data", (chunk) => (serverLog += chunk));

const rpc = async (context, tag, payload = {}) => {
  const response = await context.request.post(origin + "/api/auth/websocket-ticket", {
    headers: { Origin: origin },
  });
  NodeAssert.equal(response.status(), 200);
  const { ticket } = await response.json();
  const url = new URL(origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`RPC timed out: ${tag}`));
    }, 15000);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    ws.addEventListener("message", (event) => {
      const items = [JSON.parse(event.data)].flat();
      for (const item of items) {
        if (item._tag !== "Exit" || String(item.requestId) !== "1") continue;
        clearTimeout(timer);
        ws.close();
        if (item.exit?._tag === "Success") resolve(item.exit.value);
        else reject(new Error(`RPC failed: ${tag}: ${JSON.stringify(item.exit)}`));
      }
    });
  });
};

let browser;
let activePage;
const receipt = {
  headless: true,
  realBuiltServer: true,
  fakeGoogle: true,
  nativeTurns: 0,
  linkedTaskEditorsIncluded: verifyLinkedEditors,
  checks: [],
  screenshots: [],
};
try {
  const credential = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error("Private server did not become ready")), 45000);
    const observe = () => {
      const match = serverLog.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Private server exited: ${code}`));
    });
  });
  const { chromium } = NodeModule.createRequire(import.meta.url)(
    NodePath.join(root, "node_modules/.pnpm/playwright-core@1.60.0/node_modules/playwright-core"),
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await context.addInitScript(() => {
    localStorage.setItem(
      "studio:themes:v1",
      JSON.stringify([
        {
          id: "cancel-test-light",
          label: "Cancel test light",
          appearance: "light",
          colors: { canvas: "#ffffff" },
          collection: { id: "cancel-test", label: "Cancel test" },
        },
        {
          id: "cancel-test-soft",
          label: "Cancel test soft",
          appearance: "light",
          colors: { canvas: "#eeeeee" },
          collection: { id: "cancel-test", label: "Cancel test" },
        },
      ]),
    );
    if (!localStorage.getItem("studio:client-settings:v1"))
      localStorage.setItem(
        "studio:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: "2026-10-09T00:00:00.000Z" }),
      );
  });
  const auth = await context.request.post(origin + "/api/auth/browser-session", {
    data: { credential },
    headers: { Origin: origin },
  });
  NodeAssert.equal(auth.status(), 200);
  // Read the actual compiled default with no runtime Google client variables.
  // Official release checks require this so an isolated checkout cannot silently
  // ship a build whose Google sign-in button is unavailable.
  const initialGoogle = await rpc(context, "googleAccount.status");
  const hasBuiltInClient = initialGoogle.clientSource === "studio";
  if (process.env.STUDIO_TEST_REQUIRE_BUILTIN_GOOGLE === "1") {
    NodeAssert.equal(hasBuiltInClient, true, "Release must include its Google OAuth client");
    NodeAssert.equal(initialGoogle.clientConfigured, true);
  }
  NodeAssert.equal(initialGoogle.connected, false);
  receipt.checks.push({
    compiledGoogleClientAvailable: hasBuiltInClient,
    noRuntimeGoogleClient: true,
  });

  const project = await rpc(context, "projects.createNew", { kind: "personal", name: "Errands" });
  const config = await rpc(context, "server.getConfig");
  const scopedSearch = `?machine=${encodeURIComponent(config.environment.environmentId)}`;
  receipt.checks.push({ personalProjectCreated: project.projectId });

  const page = await context.newPage();
  activePage = page;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/settings/google");
  const shot = async (name, target = page) => {
    const file = NodePath.join(out, name);
    await target.screenshot({ path: file, fullPage: true, animations: "disabled" });
    receipt.screenshots.push(file);
  };
  const idInput = page.getByLabel("Google OAuth client ID", { exact: true });
  if (hasBuiltInClient) {
    await page.getByRole("button", { name: "Connect Google", exact: true }).waitFor();
    await shot("0-google-built-in.png");
    await page.getByRole("button", { name: "Use your own OAuth client", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    NodeAssert.equal(page.url(), origin + "/settings/google");
    await page.getByRole("button", { name: "Use your own OAuth client", exact: true }).click();
    receipt.checks.push({ inlineGoogleClientCancelStaysInSettings: true });
  }
  await idInput.waitFor({ timeout: 20000 });
  await shot("1-google-empty.png");

  // A malformed client id is caught before it reaches the host.
  await idInput.fill("not-a-client");
  NodeAssert.ok(
    await page.getByText("ends in .apps.googleusercontent.com", { exact: false }).count(),
  );
  NodeAssert.equal(await page.getByRole("button", { name: "Save client" }).isDisabled(), true);
  await idInput.fill(CLIENT_ID);
  await page.getByLabel("Google OAuth client secret", { exact: true }).fill(CLIENT_SECRET);
  await page.getByRole("button", { name: "Save client" }).click();
  await page.getByRole("button", { name: "Connect Google" }).waitFor({ timeout: 15000 });

  // Untick Drive, then sign in: the consent tab redirects back to the host's callback.
  await page.getByRole("checkbox", { name: "Ask Google for Drive" }).click();
  const [consent] = await Promise.all([
    context.waitForEvent("page"),
    page.getByRole("button", { name: "Connect Google" }).click(),
  ]);
  await consent.getByText("Google account connected").waitFor({ timeout: 15000 });
  NodeAssert.match(new URL(consent.url()).pathname, /^\/api\/google\/oauth\/callback$/u);
  await shot("2-google-callback.png", consent);
  await consent.close();
  const authorization = google.authorizations[0];
  NodeAssert.equal(authorization.client_id, CLIENT_ID);
  NodeAssert.equal(authorization.redirect_uri, `${origin}/api/google/oauth/callback`);
  NodeAssert.equal(authorization.code_challenge_method, "S256");
  NodeAssert.equal(
    authorization.scope,
    "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
  );
  NodeAssert.equal(authorization.scope.includes("drive"), false);
  receipt.checks.push({ readOnlyScopesOnly: true, pkce: true, loopbackRedirect: true });

  await page.getByText(`Signed in as ${EMAIL}`, { exact: false }).waitFor({ timeout: 15000 });
  const connected = await rpc(context, "googleAccount.status");
  NodeAssert.equal(connected.connected, true);
  NodeAssert.deepEqual(connected.services, ["gmail", "calendar"]);
  for (const secret of [CLIENT_SECRET, REFRESH_TOKEN]) {
    NodeAssert.equal(
      JSON.stringify(connected).includes(secret),
      false,
      "status never returns secrets",
    );
  }
  receipt.checks.push({ connected: true, email: connected.email, services: connected.services });

  // A new account starts with every granted service on for personal projects only; Drive
  // cannot be switched on because it was not granted. Switch Gmail off and on again.
  NodeAssert.deepEqual(connected.projects, [
    { projectId: project.projectId, services: ["gmail", "calendar"] },
  ]);
  NodeAssert.equal(
    await page.getByRole("switch", { name: "Drive for Errands" }).isDisabled(),
    true,
  );
  const gmail = page.getByRole("switch", { name: "Gmail for Errands" });
  await gmail.click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Gmail for Errands"]')?.getAttribute("aria-checked") ===
      "false",
    null,
    { timeout: 15000 },
  );
  NodeAssert.deepEqual((await rpc(context, "googleAccount.status")).projects, [
    { projectId: project.projectId, services: ["calendar"] },
  ]);
  await gmail.click();
  await page.waitForFunction(
    () =>
      document.querySelector('[aria-label="Gmail for Errands"]')?.getAttribute("aria-checked") ===
      "true",
    null,
    { timeout: 15000 },
  );
  await page.getByRole("link", { name: "Morning briefing" }).waitFor({ timeout: 15000 });
  const granted = await rpc(context, "googleAccount.status");
  NodeAssert.deepEqual(granted.projects, [
    { projectId: project.projectId, services: ["gmail", "calendar"] },
  ]);
  await shot("3-google-connected.png");
  receipt.checks.push({ projectAccess: granted.projects });

  // Every dismissal returns to the exact originating settings URL. A local
  // editor and a directly opened template have different, explicit fallbacks.
  // Use a persistent fragment; recognized Settings search targets are intentionally
  // consumed after scrolling and therefore are no longer the editor's origin.
  const googleHref = origin + "/settings/google" + scopedSearch + "#cancel-origin";
  await page.goto(googleHref);
  const titleInput = page.locator("#scheduled-task-title");
  const dismiss = async (method) => {
    if (method === "cancel")
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
    else if (method === "close")
      await page.getByRole("button", { name: "Close", exact: true }).click();
    else if (method === "escape") await page.keyboard.press("Escape");
    else await page.mouse.click(5, 850);
  };
  const tasksBefore = await rpc(context, "scheduledTasks.list");
  for (const method of ["cancel", "close", "escape", "backdrop"]) {
    await page.getByRole("link", { name: "Morning briefing" }).click();
    await titleInput.waitFor({ timeout: 15000 });
    NodeAssert.equal(await titleInput.inputValue(), "Morning briefing");
    const prompt = await page.locator("textarea").first().inputValue();
    NodeAssert.ok(prompt.includes("studio_google_calendar_events"));
    NodeAssert.ok(prompt.includes("never send, change or delete anything"));
    if (method === "cancel") await shot("4-morning-briefing-template.png");
    await dismiss(method);
    await page.waitForURL(googleHref, { timeout: 5000 }).catch((error) => {
      throw new Error(`Dismiss ${method}: expected ${googleHref}, received ${page.url()}`, {
        cause: error,
      });
    });
    await titleInput.waitFor({ state: "detached" });
    receipt.checks.push({ morningBriefingDismissal: method, exactOriginRestored: true });
  }
  // Escape in a nested select closes only that control, then closes the editor.
  await page.getByRole("link", { name: "Morning briefing" }).click();
  await titleInput.waitFor();
  const templateHref = page.url();
  await page.getByRole("dialog").getByRole("combobox").first().click();
  await page.getByRole("listbox").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("listbox").waitFor({ state: "detached" });
  NodeAssert.equal(page.url(), templateHref);
  NodeAssert.equal(await titleInput.isVisible(), true);
  await page.keyboard.press("Escape");
  await page.waitForURL(googleHref);
  receipt.checks.push({ nestedSelectEscapeStaysInEditor: true });

  const taskListHref = origin + "/settings/scheduled-tasks" + scopedSearch;
  const directTemplateHref =
    taskListHref + `&template=morning-briefing&projectId=${project.projectId}`;
  await page.goto(directTemplateHref);
  await titleInput.waitFor();
  await dismiss("cancel");
  await page.waitForURL(taskListHref);
  await page.reload();
  await page.getByRole("button", { name: "New task", exact: true }).waitFor();
  NodeAssert.equal(await titleInput.count(), 0);
  await page.goBack();
  await page.goForward();
  NodeAssert.equal(page.url(), taskListHref);
  NodeAssert.equal(await titleInput.count(), 0);
  for (const method of ["cancel", "escape"]) {
    await page.getByRole("button", { name: "New task", exact: true }).click();
    await titleInput.waitFor();
    await dismiss(method);
    await titleInput.waitFor({ state: "detached" });
    NodeAssert.equal(page.url(), taskListHref);
  }
  NodeAssert.deepEqual(await rpc(context, "scheduledTasks.list"), tasksBefore);
  receipt.checks.push({
    directLinkFallbackAndHistory: true,
    localTaskCancelStaysOnList: true,
    noTasksCreatedByCancel: true,
  });

  // Saving is a different outcome: keep the list and consume the template.
  // Disable the fixture before saving so this check can never start a turn.
  await page.goto(googleHref);
  await page.getByRole("link", { name: "Morning briefing" }).click();
  await titleInput.waitFor();
  const enabledSwitch = page.getByRole("dialog").getByRole("switch");
  await enabledSwitch.click();
  NodeAssert.equal(await enabledSwitch.getAttribute("aria-checked"), "false");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await titleInput.waitFor({ state: "detached" });
  await page.waitForURL(taskListHref);
  const savedTasks = await rpc(context, "scheduledTasks.list");
  NodeAssert.equal(savedTasks.tasks.length, tasksBefore.tasks.length + 1);
  const savedTask = savedTasks.tasks.find((task) => task.title === "Morning briefing");
  NodeAssert.equal(savedTask.enabled, false);
  NodeAssert.equal(savedTask.runCount, 0);
  await page.getByRole("button", { name: "Actions for Morning briefing", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await titleInput.waitFor();
  await titleInput.fill("Unsaved title");
  await dismiss("cancel");
  await titleInput.waitFor({ state: "detached" });
  NodeAssert.equal(page.url(), taskListHref);
  NodeAssert.deepEqual(await rpc(context, "scheduledTasks.list"), savedTasks);
  receipt.checks.push({
    saveStaysOnTaskList: true,
    editCancelPreservesTask: true,
    disabledFixtureNeverRan: true,
  });
  if (verifyLinkedEditors) {
    const linkedEditHref = taskListHref + `&taskId=${savedTask.id}`;
    await page.goto(
      linkedEditHref + `&returnTo=${encodeURIComponent(googleHref.slice(origin.length))}`,
    );
    await titleInput.waitFor();
    await dismiss("escape");
    await page.waitForURL(googleHref);
    await page.goto(linkedEditHref);
    await titleInput.waitFor();
    await dismiss("cancel");
    await page.waitForURL(taskListHref);
    await page.reload();
    await page.getByRole("button", { name: "New task", exact: true }).waitFor();
    NodeAssert.equal(await titleInput.count(), 0);
    receipt.checks.push({ linkedEditReturnsToOrigin: true, directEditConsumesTaskId: true });
  }

  const providersHref = origin + "/settings/providers" + scopedSearch + "#cancel-origin";
  await page.goto(providersHref);
  for (const method of ["cancel", "escape"]) {
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    // Settings is itself a dialog; wait on the wizard nested inside it.
    const wizard = page.locator('[role="dialog"]:not([data-settings-dialog])');
    await wizard.waitFor();
    await dismiss(method);
    await wizard.waitFor({ state: "detached" });
    NodeAssert.equal(page.url(), providersHref);
  }
  receipt.checks.push({ providerWizardCancelAndEscapeStayInSettings: true });

  const appearanceHref = origin + "/settings/appearance" + scopedSearch + "#cancel-origin";
  await page.goto(appearanceHref);
  const variant = page.getByRole("button", {
    name: "Choose light variant, 2 options, currently light",
    exact: true,
  });
  await variant.waitFor();
  const radialOption = variant
    .locator("..")
    .getByRole("button", { name: /for light mode/ })
    .first();
  const waitForRadial = async (open) => {
    const element = await radialOption.elementHandle();
    await page.waitForFunction(
      ([option, visible]) =>
        option !== null && Number(getComputedStyle(option).opacity) === (visible ? 1 : 0),
      [element, open],
    );
  };
  // Focus outside the picker proves hover-only opening also owns Escape.
  await variant.evaluate((element) => element.blur());
  await page.mouse.move(0, 0);
  await variant.hover();
  await waitForRadial(true);
  await page.keyboard.press("Escape");
  await waitForRadial(false);
  NodeAssert.equal(page.url(), appearanceHref);
  await variant.focus();
  await waitForRadial(true);
  await page.keyboard.press("Escape");
  await waitForRadial(false);
  NodeAssert.equal(page.url(), appearanceHref);
  receipt.checks.push({ themeVariantHoverAndFocusEscapeStayInSettings: true });
  await shot("5-cancel-settings-verified.png");

  // A forged callback is refused without touching the sign-in.
  const forged = await context.request.get(
    `${origin}/api/google/oauth/callback?state=forged&code=code-1`,
  );
  NodeAssert.ok((await forged.text()).includes("did not finish"));

  // Paste flow, for a browser on another machine: start, follow the consent
  // redirect without loading it, and paste the address into the page.
  await page.goto(origin + "/settings/google");
  const started = await rpc(context, "googleAccount.startSignIn", { services: ["gmail"] });
  const consentResponse = await context.request.get(started.signIn.authorizationUrl, {
    maxRedirects: 0,
  });
  const landed = consentResponse.headers().location;
  NodeAssert.ok(landed?.includes("code="));
  const pasteInput = page.getByLabel("Address Google sent you to", { exact: true });
  await pasteInput.waitFor({ timeout: 15000 });
  await pasteInput.fill(landed);
  await page.getByRole("button", { name: "Finish sign-in" }).click();
  await pasteInput.waitFor({ state: "detached", timeout: 15000 });
  const repasted = await rpc(context, "googleAccount.status");
  NodeAssert.deepEqual(repasted.services, ["gmail"]);
  // The same address cannot be used twice.
  await NodeAssert.rejects(
    rpc(context, "googleAccount.completeSignIn", { callbackUrl: landed }),
    /not the one SpecWithCode started/u,
  );
  receipt.checks.push({ pastedSignIn: true, singleUseState: true, forgedCallbackRefused: true });

  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.getByRole("button", { name: "Connect Google" }).waitFor({ timeout: 15000 });
  NodeAssert.deepEqual(google.revoked, [REFRESH_TOKEN]);
  await page.getByRole("button", { name: "Remove" }).click();
  if (hasBuiltInClient) {
    await page
      .getByRole("button", { name: "Use your own OAuth client", exact: true })
      .waitFor({ timeout: 15000 });
  } else {
    await page.getByLabel("Google OAuth client ID", { exact: true }).waitFor({ timeout: 15000 });
  }
  const removed = await rpc(context, "googleAccount.status");
  NodeAssert.equal(removed.clientConfigured, hasBuiltInClient);
  NodeAssert.equal(removed.clientSource, hasBuiltInClient ? "studio" : null);
  NodeAssert.equal(removed.connected, false);
  NodeAssert.deepEqual(removed.projects, []);
  NodeAssert.deepEqual(errors, []);
  receipt.checks.push({ revokedOnDisconnect: true, removed: true, pageErrors: errors });
  for (const secret of [CLIENT_SECRET, REFRESH_TOKEN, "code-1", "code-2"]) {
    NodeAssert.equal(serverLog.includes(secret), false, `the server log never contains ${secret}`);
  }
  receipt.checks.push({ secretsNotLogged: true });
} catch (error) {
  if (activePage) {
    await activePage.screenshot({ path: NodePath.join(out, "failure-page.png"), fullPage: true });
    NodeFS.writeFileSync(
      NodePath.join(out, "failure-page.txt"),
      await activePage.locator("body").innerText(),
    );
  }
  NodeFS.writeFileSync(
    NodePath.join(out, "failure-server-log.txt"),
    serverLog
      .slice(-20000)
      .replace(/(Token: )[^\s]+/g, "$1[redacted]")
      .replace(/(\/pair#token=)[^\s]+/g, "$1[redacted]"),
  );
  throw error;
} finally {
  await browser?.close();
  fakeGoogle.close();
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  NodeFS.rmSync(state, { recursive: true, force: true });
  receipt.privateHomeRemoved = true;
}
NodeFS.writeFileSync(
  NodePath.join(out, "google-receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(JSON.stringify(receipt.checks));
