#!/usr/bin/env node
// 0968: two isolated real servers prove which paired machine a limited thread may move to,
// and that it moves there through 0967's handoff, once, under faults. M4 is the source,
// Minis the target. Usage is simulated per provider instance with
// STUDIO_SIMULATE_PROVIDER_USAGE. M4's model-free `source` actually starts a turn, writes
// partial work and returns a structured ACP limit error after we observe it running.
// No paid provider runs and no live data is read. Faults are injected in the network between
// the two (a TLS proxy) and by stopping or killing a server.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

NodeAssert.equal(
  Number(process.versions.node.split(".")[0]),
  22,
  "Use the project's Node 22 runtime",
);
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const output = NodePath.resolve(
  process.argv[2] ??
    NodePath.join(NodeOS.tmpdir(), `limit-handoff-proof-${NodeCrypto.randomUUID()}`),
);
NodeFS.mkdirSync(output, { recursive: true, mode: 0o700 });
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "limit-handoff-servers-"));
const entrypoint = NodePath.join(root, "apps/server/dist/bin.mjs");
const agent = NodePath.join(root, "scripts/studio-logical-projects/link-launch-agent.mjs");
const receipt = {
  source: NodeChildProcess.execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  evidenceKind: "two-real-isolated-servers-with-simulated-usage",
  fixtureSha256: Object.fromEntries(
    [NodeURL.fileURLToPath(import.meta.url), agent].map((file) => [
      NodePath.relative(root, file),
      NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex"),
    ]),
  ),
  builtEntrypointSha256: NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(entrypoint))
    .digest("hex"),
  paidProviderTurns: 0,
  /** Prompts each model-free echo agent instance received, by machine and instance. */
  stubAgentTurns: {},
  checks: [],
  candidates: {},
  success: false,
};
const save = () =>
  NodeFS.writeFileSync(
    NodePath.join(output, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
const check = (text) => {
  receipt.checks.push(text);
  console.log(`ok - ${text}`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const port = () =>
  new Promise((done, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => done(value));
    });
  });

async function stop(host) {
  const child = host.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}
async function start(host) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      entrypoint,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(host.port),
      "--base-dir",
      host.data,
      "--no-browser",
    ],
    {
      cwd: host.dir,
      env: {
        // host.bin names the machine ("M4", "Minis") through a scutil stand-in.
        PATH: `${host.bin}:${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        LANG: "en_US.UTF-8",
        STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        STUDIO_DISABLE_AUTO_UPDATE: "true",
        PWDEBUG: "0",
        PLAYWRIGHT_HTML_OPEN: "never",
        SHELL: NodePath.join(host.bin, "login-shell"),
        ...host.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  host.child = child;
  const log = NodePath.join(output, `${host.label}.log`);
  NodeFS.writeFileSync(log, "");
  return new Promise((done, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`${host.label} startup timeout`)),
      45000,
    );
    const inspect = (chunk) => {
      // Server logs, minus the bootstrap credential line.
      NodeFS.writeFileSync(log, String(chunk).replace(/Token: [^\s]+/g, "Token: <redacted>"), {
        flag: "a",
      });
      if (settled) return;
      buffer = (buffer + chunk).slice(-65536);
      const token = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (token) finish(done, token[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", () => finish(reject, new Error(`${host.label} exited during startup`)));
  });
}
async function request(host, path, data, method = "POST") {
  const response = await fetch(host.origin + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: host.origin,
      Authorization: `Bearer ${host.token}`,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  NodeAssert.equal(response.status, 200, `${host.label} request failed: ${path}`);
  return response.json();
}
async function rpc(host, tag, payload) {
  const { ticket } = await request(host, "/api/auth/websocket-ticket");
  const url = new URL(host.origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return new Promise((done, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${host.label} RPC timeout: ${tag}`));
    }, 60000);
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${host.label} RPC transport failed`));
    });
    socket.addEventListener("message", (event) => {
      let values;
      try {
        const value = JSON.parse(event.data);
        values = Array.isArray(value) ? value : [value];
      } catch {
        return;
      }
      for (const value of values)
        if (value._tag === "Exit" && String(value.requestId) === "1") {
          clearTimeout(timer);
          socket.close();
          if (value.exit?._tag === "Success") done(value.exit.value);
          else
            reject(new Error(`${host.label} RPC rejected: ${tag} ${JSON.stringify(value.exit)}`));
        }
    });
  });
}
async function exchange(host, credential) {
  const response = await fetch(host.origin + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:specweave-studio:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Limit handoff verifier",
    }),
  });
  NodeAssert.equal(response.status, 200, `${host.label} token exchange failed`);
  host.token = (await response.json()).access_token;
}
/** The loopback OAuth steps a coordinator's Allow workers drives, for a raw MCP read. */
async function mintWorkerGrant(worker, coordinatorEnvironmentId) {
  const clientName = `SpecWithCode workers · ${coordinatorEnvironmentId}`;
  const redirectUri = "http://127.0.0.1/specwithcode-workers";
  const resource = `${worker.origin}/mcp`;
  const pairing = await request(worker, "/api/auth/pairing-token", {
    label: clientName,
    scopes: ["orchestration:read", "orchestration:operate"],
  });
  const json = { "Content-Type": "application/json" };
  const registered = await fetch(worker.origin + "/oauth/mcp/register", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri] }),
  });
  NodeAssert.ok([200, 201].includes(registered.status), "Worker client registration failed");
  const clientId = (await registered.json()).client_id;
  const verifier = NodeCrypto.randomBytes(48).toString("base64url");
  const decision = await fetch(worker.origin + "/oauth/mcp/decision", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      authorization: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: NodeCrypto.randomUUID(),
        resource,
      },
      decision: { _tag: "pairing-code", access: "full-access", code: pairing.credential },
    }),
  });
  NodeAssert.equal(decision.status, 200, "Worker grant approval failed");
  const code = new URL((await decision.json()).redirectTo).searchParams.get("code");
  const token = await fetch(worker.origin + "/oauth/mcp/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }),
  });
  NodeAssert.equal(token.status, 200, "Worker grant token exchange failed");
  return (await token.json()).access_token;
}
async function mcpCall(host, token, name, args) {
  const post = (body, session) =>
    fetch(host.origin + "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
        ...(session ? { "Mcp-Session-Id": session } : {}),
      },
      body: JSON.stringify(body),
    });
  const read = async (response) => {
    const text = await response.text();
    if (!(response.headers.get("content-type") ?? "").includes("text/event-stream"))
      return text ? JSON.parse(text) : null;
    return text
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5)))
      .find((message) => message.id !== undefined);
  };
  const initialized = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "limit-handoff-verifier", version: "1" },
    },
  });
  NodeAssert.equal(initialized.status, 200, "MCP initialize failed");
  const session = initialized.headers.get("mcp-session-id");
  await read(initialized);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  const called = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    session,
  );
  const body = await read(called);
  return body?.result?.structuredContent ?? JSON.parse(body?.result?.content?.[0]?.text ?? "null");
}

// M4 reaches Minis over HTTPS at a Tailscale-style name that resolves, only inside M4's
// server process, to a local TLS proxy in front of Minis.
const tls = NodePath.join(scratch, "fleet-tls");
NodeFS.mkdirSync(tls);
NodeChildProcess.execFileSync(
  "/usr/bin/openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    NodePath.join(tls, "key.pem"),
    "-out",
    NodePath.join(tls, "cert.pem"),
    "-subj",
    "/CN=minis.fixture.ts.net",
    "-addext",
    "subjectAltName=DNS:minis.fixture.ts.net,DNS:m1.fixture.ts.net",
  ],
  { stdio: "ignore" },
);
NodeFS.writeFileSync(
  NodePath.join(tls, "resolve.mjs"),
  `import dns from "node:dns";
const lookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof hostname === "string" && hostname.endsWith(".fixture.ts.net")) {
    const done = typeof options === "function" ? options : callback;
    const all = typeof options === "object" && options !== null && options.all;
    return process.nextTick(() =>
      all ? done(null, [{ address: "127.0.0.1", family: 4 }]) : done(null, "127.0.0.1", 4),
    );
  }
  return lookup.call(this, hostname, options, callback);
};
`,
);

const agentInstance = (name) => ({
  driver: "acpRegistry",
  displayName: `Agent ${name}`,
  enabled: true,
  config: {
    source: name === "source" ? "registry" : "local",
    ...(name === "source" ? { agentId: "mistral-vibe" } : {}),
    commandPath: process.execPath,
    commandArgs: [
      agent,
      "--echo",
      NodePath.join(scratch, `agent-${name}.json`),
      name === "own" ? "--hold-resume-fixture" : "--fixture-sessions",
    ],
    customModels: ["link-launch"],
  },
});
const disabled = [
  "codex",
  "claudeAgent",
  "claude-agent",
  "cursor",
  "grok",
  "pi",
  "opencode",
  "opencode2",
  "antigravity",
];
async function makeHost(label, instances, settings, env) {
  const dir = NodePath.join(scratch, label);
  const data = NodePath.join(dir, "data");
  const bin = NodePath.join(dir, "bin");
  NodeFS.mkdirSync(NodePath.join(data, "userdata"), { recursive: true });
  NodeFS.mkdirSync(bin);
  if (instances.includes("source")) {
    // The release classifies Mistral's structured -31001 ACP error as a usage limit.
    // Use that existing path with a cached fixture entry and our Node executable only.
    // No registry lookup, package installation or actual Mistral process is needed.
    const registry = NodePath.join(data, "caches/acp-registry");
    NodeFS.mkdirSync(registry, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(registry, "registry.json"),
      JSON.stringify({
        version: "1",
        agents: [
          {
            id: "mistral-vibe",
            name: "Model-free limit fixture",
            version: "1.0.0",
            description: "Isolated ACP structured-limit fixture; no model calls.",
            distribution: {
              binary: {
                [`${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`]:
                  {
                    archive: "https://fixture.invalid/never-downloaded",
                    cmd: "never-run",
                    args: [
                      agent,
                      "--echo",
                      NodePath.join(scratch, "agent-source.json"),
                      "--limit-fixture",
                    ],
                  },
              },
            },
          },
        ],
      }),
    );
  }
  // The server names its machine from macOS's ComputerName; this one answers with the label.
  NodeFS.writeFileSync(
    NodePath.join(bin, "scutil"),
    `#!/bin/sh\ncase "$*" in\n  "--get ComputerName"|"--get LocalHostName") echo "${label}" ;;\n  *) exec /usr/sbin/scutil "$@" ;;\nesac\n`,
    { mode: 0o755 },
  );
  // The server reads PATH from the login shell first; this one keeps the stand-in on it
  // (and reads no dotfiles of the person running the verifier).
  NodeFS.writeFileSync(
    NodePath.join(bin, "login-shell"),
    `#!/bin/sh\nexport PATH="${bin}:$PATH"\nshift\nexec /bin/sh -c "$1"\n`,
    { mode: 0o755 },
  );
  const host = {
    label,
    dir,
    data,
    bin,
    instances,
    port: await port(),
    environmentId: NodeCrypto.randomUUID(),
    env,
  };
  host.origin = `http://127.0.0.1:${host.port}`;
  NodeFS.writeFileSync(NodePath.join(data, "userdata/environment-id"), host.environmentId);
  NodeFS.writeFileSync(
    NodePath.join(data, "userdata/settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(disabled.map((driver) => [driver, { enabled: false }])),
      providerInstances: {
        ...Object.fromEntries(
          disabled.map((driver) => [driver, { driver, enabled: false, config: {} }]),
        ),
        ...Object.fromEntries(instances.map((name) => [name, agentInstance(name)])),
      },
      cursorKeychainUsageEnabled: false,
      ...settings,
    }),
  );
  return host;
}
const fixtureGit = (cwd, ...args) =>
  NodeChildProcess.execFileSync(
    "/usr/bin/git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    {
      cwd,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    },
  );
/**
 * A fixture checkout with one commit and an ignored `.env.local`. Minis's copy is a clone of
 * M4's, so both hold the base commit, and it has its own `.env.local` (secrets never travel).
 */
function prepareRepo(host, title, remote, cloneFrom) {
  const folder = NodePath.join(host.dir, title.replaceAll(" ", "-"));
  if (cloneFrom === undefined) {
    NodeFS.mkdirSync(folder);
    NodeFS.writeFileSync(NodePath.join(folder, "README.md"), "Synthetic limit handoff fixture.\n");
    NodeFS.writeFileSync(NodePath.join(folder, ".gitignore"), ".env.local\n");
    fixtureGit(folder, "init", "-q", "-b", "main");
    fixtureGit(folder, "add", "README.md", ".gitignore");
    fixtureGit(folder, "commit", "-q", "-m", "Fixture base");
    fixtureGit(folder, "remote", "add", "origin", remote);
  } else {
    fixtureGit(host.dir, "clone", "-q", cloneFrom, folder);
    fixtureGit(folder, "remote", "set-url", "origin", remote);
  }
  NodeFS.writeFileSync(NodePath.join(folder, ".env.local"), `FIXTURE_TOKEN=${host.label}-only\n`);
  return folder;
}
async function registerProject(host, title, folder) {
  const projectId = NodeCrypto.randomUUID();
  await request(host, "/api/projects/mutate", {
    type: "project.create",
    commandId: NodeCrypto.randomUUID(),
    projectId,
    title,
    workspaceRoot: folder,
  });
  return projectId;
}
async function providersReady(host, names) {
  let last;
  for (let attempt = 0; attempt < 60; attempt++) {
    const config = await rpc(host, "server.getConfig", {});
    last = config.providers
      .filter((p) => names.includes(p.instanceId))
      .map((p) => `${p.instanceId}:${p.status}`);
    if (last.length === names.length && last.every((row) => row.endsWith(":ready"))) return;
    await sleep(1000);
  }
  throw new Error(`${host.label} providers never became ready: ${last?.join(", ")}`);
}
async function boot(host) {
  await exchange(host, await start(host));
  await providersReady(host, host.instances);
}
/** Waits for `read` to return something truthy. */
async function until(what, read, timeoutMs = 150_000, everyMs = 1000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    last = await read();
    if (last) return last;
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
/** The persisted handoff document (0967's handoff-mode.json), read the way a restart reads it. */
function handoffDoc(host) {
  try {
    return JSON.parse(
      NodeFS.readFileSync(NodePath.join(host.data, "userdata/handoff-mode.json"), "utf8"),
    );
  } catch {
    return null;
  }
}
const recordOf = (host, threadId) => handoffDoc(host)?.threads?.[threadId] ?? null;
const incomingOf = (host, sourceThreadId) =>
  (handoffDoc(host)?.incoming ?? []).find((entry) => entry.sourceThreadId === sourceThreadId) ??
  null;
const projection = (host, threadId) => rpc(host, "orchestration.getThreadProjection", { threadId });
/** Every prompt one echo agent instance received (the verifier's count of stub turns). */
function agentTurns(name) {
  const file = NodePath.join(scratch, `agent-${name}.json.jsonl`);
  if (!NodeFS.existsSync(file)) return [];
  return NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}
const settledRuns = (view) =>
  view.runs.filter((run) => !["queued", "running"].includes(run.status));

async function shotThread(browser, host, threadId, name, waitText) {
  for (const [width, theme] of [
    [1440, "dark"],
    [390, "light"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      colorScheme: theme,
      reducedMotion: "reduce",
    });
    await context.addInitScript(() =>
      localStorage.setItem(
        "studio:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: "2026-10-20T00:00:00.000Z" }),
      ),
    );
    const pairing = await request(host, "/api/auth/pairing-token", {
      label: "Limit handoff verifier browser",
    });
    const auth = await context.request.post(host.origin + "/api/auth/browser-session", {
      data: { credential: pairing.credential },
      headers: { Origin: host.origin },
    });
    NodeAssert.equal(auth.status(), 200, "Browser session failed");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${host.origin}/${host.environmentId}/${threadId}`);
    // The banner also renders a hidden copy for the other layout; wait for the shown one.
    const notice = page.getByText(waitText, { exact: false }).locator("visible=true").first();
    await notice.waitFor({ timeout: 45000 }).catch(async (error) => {
      NodeFS.writeFileSync(
        NodePath.join(output, `${name}-failure-${width}.txt`),
        (await page.locator("body").innerText()).slice(0, 12000),
      );
      throw error;
    });
    await notice.scrollIntoViewIfNeeded();
    const file = NodePath.join(output, `${name}-${width}-${theme}.png`);
    await page.screenshot({ path: file, fullPage: false });
    receipt.screenshots.push(file);
    NodeFS.writeFileSync(
      NodePath.join(output, `${name}-${width}.txt`),
      (await page.locator("body").innerText()).slice(0, 12000),
    );
    NodeAssert.deepEqual(errors, [], `Page errors: ${errors.join(" | ")}`);
    await context.close();
  }
}
const launchBrowser = () => {
  const { chromium } = NodeModule.createRequire(import.meta.url)(
    process.env.PLAYWRIGHT_MODULE ??
      NodePath.join(
        NodeOS.homedir(),
        ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
      ),
  );
  return chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });
};
const webBuilt = () =>
  [
    NodePath.join(root, "apps/server/dist/client/index.html"),
    NodePath.join(root, "apps/web/dist/index.html"),
  ].some((file) => NodeFS.existsSync(file));

/** The limit banner lists each target with its reason, and Settings the ordered list. */
async function captureCandidates(host, threadId) {
  const browser = await launchBrowser();
  try {
    for (const [width, theme] of [
      [1440, "dark"],
      [390, "light"],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      await context.addInitScript(() =>
        localStorage.setItem(
          "studio:client-settings:v1",
          JSON.stringify({ onboardingCompletedAt: "2026-10-20T00:00:00.000Z" }),
        ),
      );
      const pairing = await request(host, "/api/auth/pairing-token", {
        label: "Limit handoff verifier browser",
      });
      const auth = await context.request.post(host.origin + "/api/auth/browser-session", {
        data: { credential: pairing.credential },
        headers: { Origin: host.origin },
      });
      NodeAssert.equal(auth.status(), 200, "Browser session failed");
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const shot = async (name) => {
        const file = NodePath.join(output, `${name}-${width}-${theme}.png`);
        await page.screenshot({ path: file, fullPage: false });
        receipt.screenshots.push(file);
      };
      const dump = async (name) =>
        NodeFS.writeFileSync(
          NodePath.join(output, `${name}-${width}.txt`),
          (await page.locator("body").innerText()).slice(0, 12000),
        );
      await page.goto(`${host.origin}/${host.environmentId}/${threadId}`);
      const list = page.getByRole("list").filter({ hasText: "Minis: ACP Registry at 40%" });
      await list.waitFor({ timeout: 45000 }).catch(async (error) => {
        await dump("thread-failure");
        throw error;
      });
      const items = await list.locator("li").allInnerTexts();
      NodeAssert.ok(
        items.some((text) => /^\d\. Minis: same .+ account as /.test(text)),
        `Same-account reason listed: ${items.join(" | ")}`,
      );
      NodeAssert.ok(items.some((text) => text.endsWith("Minis: ACP Registry at 96%")));
      NodeAssert.ok(items.some((text) => text.endsWith("Minis: ACP Registry usage unknown")));
      await list.scrollIntoViewIfNeeded();
      await shot("limited-thread");
      await dump("limited-thread");
      await page.goto(`${host.origin}/settings/general`);
      const row = page.locator("#provider-limit-machine-targets");
      await row.waitFor({ timeout: 30000 }).catch(async (error) => {
        await dump("settings-failure");
        throw error;
      });
      // The paired list loads after the settings: wait until M1 reads offline.
      await row
        .getByText("offline")
        .waitFor({ timeout: 30000 })
        .catch(async (error) => {
          await dump("settings-failure");
          throw error;
        });
      const rows = await row
        .getByRole("list", { name: "Machine targets" })
        .locator("li")
        .allInnerTexts();
      NodeAssert.ok(
        rows.every((text) => !text.includes("not paired")),
        `Every target is paired: ${rows.join(" | ")}`,
      );
      NodeAssert.ok(rows.at(-1)?.includes("offline"), `M1 reads offline: ${rows.at(-1)}`);
      await row.evaluate((element) => element.scrollIntoView({ block: "start" }));
      await shot("settings-fallback");
      await dump("settings");
      NodeAssert.deepEqual(errors, [], `Page errors: ${errors.join(" | ")}`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  check(
    "The held thread lists each machine target with its reason, and Settings shows the ordered list (headless, 1440 and 390 px)",
  );
}

// Faults live in the network between the machines: the proxy can hold a takeover's answer
// (the source dies waiting) or drop the takeover before it arrives (the target is gone).
let proxy;
let fault = null;
const heldAnswers = [];
const hosts = [];
try {
  // Minis offers four sign-ins of one driver: the same account as M4's, its own account with
  // room, its own account near the limit, and one whose usage it can't read.
  const minisInstances = ["twin", "own", "busy", "mystery"];
  const minis = await makeHost(
    "Minis",
    minisInstances,
    {},
    {
      STUDIO_SIMULATE_PROVIDER_USAGE:
        "twin=20@pool-m4,own=40@pool-minis,busy=96@pool-busy,mystery=?@pool-mystery",
    },
  );
  hosts.push(minis);
  const proxyPort = await port();
  const deadPort = await port();
  const m1EnvironmentId = NodeCrypto.randomUUID();
  const target = (instanceId, environmentId = minis.environmentId, label = "Minis") => ({
    environmentId,
    label,
    modelSelection: { instanceId, model: "link-launch" },
    modelLabel: "Link launch",
  });
  // M4's `source` stops on its limit; `hot` is the same account at 96% (it still runs, so an
  // idle thread can sit at the threshold); `local` is this machine's own fallback model.
  const m4Instances = ["source", "hot", "local"];
  const m4 = await makeHost(
    "M4",
    m4Instances,
    {
      providerLimitSwitchAtPercent: 95,
      providerLimitAction: "switch",
      providerLimitFallbackModels: [{ instanceId: "local", model: "link-launch" }],
      providerLimitWaitUnderMinutes: 0,
      providerLimitTargetOrder: "other-machine-first",
      providerLimitMachineTargets: [
        target("twin"),
        target("own"),
        target("busy"),
        target("mystery"),
        target("own", m1EnvironmentId, "M1"),
      ],
    },
    {
      // `local` reports no usage, like an ACP agent: it takes a turn as long as it is ready.
      STUDIO_SIMULATE_PROVIDER_USAGE: "source=97@pool-m4,hot=96@pool-m4",
      NODE_EXTRA_CA_CERTS: NodePath.join(tls, "cert.pem"),
      NODE_OPTIONS: `--import=${NodeURL.pathToFileURL(NodePath.join(tls, "resolve.mjs")).href}`,
    },
  );
  hosts.push(m4);
  const remotes = {
    "Limit fixture": "https://github.com/example/limit-fixture.git",
    EasyChamp: "https://github.com/example/easychamp.git",
  };
  const m4Folders = Object.fromEntries(
    Object.entries(remotes).map(([title, remote]) => [title, prepareRepo(m4, title, remote)]),
  );
  const soloFolder = prepareRepo(m4, "Solo fixture", "https://github.com/example/solo.git");
  const minisFolders = Object.fromEntries(
    Object.entries(remotes).map(([title, remote]) => [
      title,
      prepareRepo(minis, title, remote, m4Folders[title]),
    ]),
  );

  await boot(minis);
  const minisWork = await registerProject(minis, "Limit fixture", minisFolders["Limit fixture"]);
  const minisEasychamp = await registerProject(minis, "EasyChamp", minisFolders.EasyChamp);

  proxy = NodeHttps.createServer(
    {
      key: NodeFS.readFileSync(NodePath.join(tls, "key.pem")),
      cert: NodeFS.readFileSync(NodePath.join(tls, "cert.pem")),
    },
    (incoming, outgoing) => {
      const active = incoming.url?.startsWith("/api/handoff/v1/takeover") ? fault : null;
      if (active !== null) fault = null;
      if (active?.kind === "drop-takeover") {
        // The target is gone before the takeover reaches it.
        incoming.socket.destroy();
        active.hit();
        return;
      }
      const forwarded = NodeHttp.request(
        `${minis.origin}${incoming.url}`,
        {
          method: incoming.method,
          headers: { ...incoming.headers, "x-forwarded-proto": "https" },
        },
        (response) => {
          if (active?.kind === "stall-takeover") {
            // Minis answered; M4 never hears it.
            let body = "";
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => active.hit({ status: response.statusCode, body }));
            heldAnswers.push(outgoing);
            return;
          }
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      forwarded.on("error", () => outgoing.destroy());
      incoming.pipe(forwarded);
    },
  );
  await new Promise((done) => proxy.listen(proxyPort, "127.0.0.1", done));
  const armFault = (kind) =>
    new Promise((hit) => {
      fault = { kind, hit };
    });

  const fleetFile = NodePath.join(m4.data, "studio-fleet.json");
  NodeFS.writeFileSync(
    fleetFile,
    JSON.stringify({
      version: 1,
      machines: [
        {
          id: "minis",
          label: "Minis",
          environmentId: minis.environmentId,
          url: `https://minis.fixture.ts.net:${proxyPort}/`,
        },
        {
          id: "m1",
          label: "M1",
          environmentId: m1EnvironmentId,
          url: `https://m1.fixture.ts.net:${deadPort}/`,
        },
      ],
    }),
    { mode: 0o600 },
  );
  NodeFS.chmodSync(fleetFile, 0o600);
  await boot(m4);
  const work = await registerProject(m4, "Limit fixture", m4Folders["Limit fixture"]);
  const easychamp = await registerProject(m4, "EasyChamp", m4Folders.EasyChamp);
  const solo = await registerProject(m4, "Solo fixture", soloFolder);
  // No push of hidden refs to the fixture's (fake) GitHub origin, and no note model call.
  await rpc(m4, "handoffMode.updateConfig", { pushToOrigin: false, noteModel: "off" });
  // Work crosses machines only between linked copies of a project, so link both pairs the way
  // Link projects does: M4 keeps the coordinator, Minis joins. Solo fixture stays unlinked.
  for (const [kept, joining] of [
    [work, minisWork],
    [easychamp, minisEasychamp],
  ]) {
    const joiner = await rpc(minis, "projectLink.preview", { projectId: joining });
    const operationId = NodeCrypto.randomUUID();
    const prepared = await rpc(m4, "projectLink.prepare", {
      operationId,
      projectId: kept,
      joining: joiner.member,
    });
    const accepted = await rpc(minis, "projectLink.accept", {
      operationId,
      projectId: joining,
      kept: prepared.kept,
      logicalProject: prepared.logicalProject,
      coordinatorBinding: prepared.coordinatorBinding,
      keptFingerprint: prepared.fingerprint,
    });
    const committed = await rpc(m4, "projectLink.commit", {
      operationId,
      projectId: kept,
      joining: accepted.member,
      notes: [],
    });
    NodeAssert.deepEqual(
      committed.logicalProject.members.map((member) => member.environmentId).sort(),
      [m4.environmentId, minis.environmentId].sort(),
    );
  }
  check("Limit fixture and EasyChamp are linked between M4 and Minis; Solo fixture is not");
  const thread = async (projectId, title, instanceId = "source") => {
    const threadId = `limit-${NodeCrypto.randomUUID()}`;
    await rpc(m4, "orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: NodeCrypto.randomUUID(),
      threadId,
      projectId,
      title,
      modelSelection: { instanceId, model: "link-launch" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  };
  const send = (threadId, text) =>
    rpc(m4, "orchestration.dispatchCommand", {
      type: "message.dispatch",
      commandId: NodeCrypto.randomUUID(),
      threadId,
      messageId: NodeCrypto.randomUUID(),
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      dispatchMode: { type: "start_immediately" },
    });
  const partialText = (name) => `Partial fixture work: ${name}. Wrote notes/${name}.md.`;
  const partialFile = (name) => `Partial work from ${name}.\n`;
  const limitTurn = async (threadId, name) => {
    await send(threadId, `Continue the fixture work.\nLIMIT-WORK ${name}`);
    const running = await until(`${name} to produce partial work while running`, async () => {
      const view = await projection(m4, threadId);
      return view.runs.some((run) => run.status === "running") &&
        view.messages.some(
          (message) => message.role === "assistant" && message.text.includes(partialText(name)),
        )
        ? view
        : null;
    });
    const prompt = agentTurns("source").find((turn) => turn.text.includes(`LIMIT-WORK ${name}`));
    NodeAssert.ok(prompt?.cwd, `${name}: the source agent actually received the turn`);
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(prompt.cwd, "notes", `${name}.md`), "utf8"),
      partialFile(name),
    );
    const run = running.runs.find((run) => run.status === "running");
    receipt.runningTurns ??= {};
    receipt.runningTurns[name] = {
      threadId,
      runId: run.id,
      status: run.status,
      partialOutput: partialText(name),
      cwd: prompt.cwd,
    };
    NodeFS.writeFileSync(NodePath.join(scratch, `agent-source.json.${name}.release`), "release\n");
    const failed = await until(`${name} to fail on a structured usage limit`, async () => {
      const view = await projection(m4, threadId);
      return view.runs.find((entry) => entry.id === run.id)?.status === "failed" ? view : null;
    });
    const failure = failed.turnItems.find(
      (item) => item.type === "error" && item.runId === run.id,
    )?.failure;
    NodeAssert.equal(failure?.class, "usage_limit", `${name}: real ACP error classification`);
    NodeAssert.equal(failure.code, "-31001");
    NodeAssert.equal(failure.message, "Usage limit reached after partial fixture work.");
    receipt.runningTurns[name].failure = failure;
    check(
      `${name}: source turn was running with agent-written partial output and file before its structured usage-limit error`,
    );
  };
  const assertPartialCheckpoint = (threadId, name, view) => {
    const record = recordOf(m4, threadId);
    const incoming = handoffDoc(minis)?.incomingDetails?.[`${m4.environmentId}/${threadId}`];
    NodeAssert.ok(
      incoming?.transcript.some(
        (message) => message.role === "assistant" && message.text.includes(partialText(name)),
      ),
      `${name}: checkpoint transcript carries the partial output`,
    );
    NodeAssert.equal(
      NodeFS.readFileSync(NodePath.join(view.thread.worktreePath, "notes", `${name}.md`), "utf8"),
      partialFile(name),
    );
    NodeAssert.ok(
      record?.checkpoint?.ref && record.checkpoint.commit,
      `${name}: a portable Git checkpoint exists`,
    );
    receipt.runningTurns[name].checkpoint = record.checkpoint;
    receipt.runningTurns[name].continuedThreadId = view.thread.id;
    check(
      `${name}: portable checkpoint carries the running turn's partial transcript and uncommitted file`,
    );
  };
  const workThread = await thread(work, "Limited worker");
  const easychampThread = await thread(easychamp, "EasyChamp worker");
  const soloThread = await thread(solo, "Solo worker");

  // AC-08: what Minis shares about each sign-in, read the way a paired machine reads it.
  // The read uses M4's worker identity, which also creates M4's grant record on Minis.
  const reader = await mintWorkerGrant(minis, m4.environmentId);
  const capabilities = await mcpCall(minis, reader, "orchestrator_capabilities", {});
  const shared = Object.fromEntries(
    capabilities.providers
      .filter((p) => minisInstances.includes(p.providerInstanceId))
      .map((p) => [p.providerInstanceId, p.usage]),
  );
  receipt.sharedUsage = shared;
  for (const name of minisInstances) {
    NodeAssert.match(
      shared[name]?.accountFingerprint ?? "",
      /^sha256:[a-f0-9]{64}$/,
      `${name} shares a fingerprint`,
    );
    NodeAssert.equal(shared[name].signedIn, true);
  }
  NodeAssert.equal(shared.own.usedPercent, 40);
  NodeAssert.equal(shared.busy.usedPercent, 96);
  NodeAssert.equal(shared.mystery.usedPercent, null);
  NodeAssert.ok(
    shared.own.resetsAt && shared.own.observedAt,
    "Reset and read times travel with it",
  );
  NodeAssert.notEqual(shared.twin.accountFingerprint, shared.own.accountFingerprint);
  const raw = JSON.stringify(capabilities);
  for (const secret of ["pool-m4", "pool-minis", "pool-busy", "pool-mystery"])
    NodeAssert.ok(!raw.includes(secret), `The account id ${secret} never leaves the machine`);
  check(
    "Minis shares usage percent, reset time and a sha256 account fingerprint per sign-in; no account id leaves it",
  );

  // M4's grant on Minis covers only the Limit fixture project, set before M4's first probe.
  await request(minis, "/api/studio/fleet/work-grants/update", {
    coordinatorEnvironmentId: m4.environmentId,
    projects: { kind: "listed", projectIds: [minisWork] },
  });
  const pairing = await request(minis, "/api/auth/pairing-token", {
    label: `SpecWithCode workers · ${m4.environmentId}`,
    scopes: ["orchestration:read", "orchestration:operate"],
  });
  const allowed = await request(m4, "/api/studio/fleet/workers/allow", {
    id: "minis",
    access: "full-access",
    pairingCode: pairing.credential,
  });
  NodeAssert.ok(
    ["allowed", "expiring"].includes(allowed.workers?.status) && !allowed.workers?.problem,
    `M4 holds a grant on Minis: ${JSON.stringify(allowed)}`,
  );
  const grant = (
    await request(minis, "/api/studio/fleet/work-grants", undefined, "GET")
  ).grants.find((row) => row.coordinatorEnvironmentId === m4.environmentId);
  NodeAssert.deepEqual(grant?.projects, { kind: "listed", projectIds: [minisWork] });
  check("M4 holds a worker grant on Minis limited to the Limit fixture project");

  // AC-09 and AC-10: M4 judges every target and names why each one can't take the thread.
  const candidates = (threadId) => rpc(m4, "limitHandoff.candidates", { threadId });
  const byKey = (result) =>
    Object.fromEntries(
      result.candidates.map((c) => [`${c.machineLabel}/${c.modelSelection.instanceId}`, c]),
    );
  let judged;
  for (let attempt = 0; attempt < 20; attempt++) {
    judged = await candidates(workThread);
    if (byKey(judged)["Minis/own"]?.reason === "eligible") break;
    await sleep(2000);
  }
  receipt.candidates.work = judged;
  const seen = byKey(judged);
  NodeAssert.equal(judged.order, "other-machine-first");
  NodeAssert.equal(judged.thresholdPercent, 95);
  NodeAssert.equal(judged.available, true, "0967's handOff moves threads now");
  NodeAssert.equal(seen["Minis/own"].reason, "eligible", JSON.stringify(judged));
  NodeAssert.equal(seen["Minis/own"].eligible, true);
  NodeAssert.equal(seen["Minis/own"].usedPercent, 40);
  NodeAssert.ok(seen["Minis/own"].resetsAt, "The reset time travels with the usage");
  check(`Another account below the threshold is eligible: "${seen["Minis/own"].text}"`);
  NodeAssert.equal(seen["Minis/twin"].reason, "same_account");
  NodeAssert.equal(seen["Minis/twin"].eligible, false);
  NodeAssert.equal(seen["Minis/twin"].text, "Minis: same ACP Registry account as M4");
  check(`Same-account target skipped: "${seen["Minis/twin"].text}"`);
  NodeAssert.equal(seen["Minis/busy"].reason, "at_threshold");
  NodeAssert.match(seen["Minis/busy"].text, /at 96%$/);
  check(`Target at or above the threshold refused: "${seen["Minis/busy"].text}"`);
  NodeAssert.equal(seen["Minis/mystery"].reason, "unknown_usage");
  NodeAssert.equal(seen["Minis/mystery"].eligible, false);
  check(`Unknown usage is not capacity by default: "${seen["Minis/mystery"].text}"`);
  NodeAssert.ok(["needs_grant", "offline"].includes(seen["M1/own"].reason), seen["M1/own"].text);
  NodeAssert.equal(seen["M1/own"].eligible, false);
  check(`Machine without a work grant refused: "${seen["M1/own"].text}"`);

  const other = await candidates(easychampThread);
  receipt.candidates.easychamp = other;
  const elsewhere = byKey(other);
  NodeAssert.equal(elsewhere["Minis/own"].reason, "no_project_grant", JSON.stringify(other));
  NodeAssert.equal(elsewhere["Minis/own"].text, "Minis: no work grant for EasyChamp");
  check(`Linked project outside the grant refused: "${elsewhere["Minis/own"].text}"`);

  const unlinked = byKey(await candidates(soloThread));
  receipt.candidates.solo = unlinked;
  NodeAssert.equal(unlinked["Minis/own"].reason, "not_linked", unlinked["Minis/own"].text);
  NodeAssert.equal(unlinked["Minis/own"].text, "Minis: Solo fixture isn't linked there");
  check(`Project without a copy on the target refused: "${unlinked["Minis/own"].text}"`);

  await rpc(m4, "server.updateSettings", { patch: { providerLimitUnknownUsageEligible: true } });
  const permissive = byKey(await candidates(workThread));
  NodeAssert.equal(permissive["Minis/mystery"].eligible, true);
  NodeAssert.equal(permissive["Minis/twin"].eligible, false, "No policy makes a shared pool room");
  NodeAssert.equal(permissive["Minis/busy"].eligible, false);
  await rpc(m4, "server.updateSettings", { patch: { providerLimitUnknownUsageEligible: false } });
  check("Unknown-usage policy on: the unknown target qualifies, the same account never does");

  // ---- Moves (AC-07, AC-12). Each source thread is listed with what it must end as. ----
  const sources = {};
  const continuationOf = (threadId) => incomingOf(minis, threadId)?.continuedThreadId ?? null;

  // 1. A running model-free turn writes partial work, then reaches its usage limit.
  //    Its checkpoint carries the file and output; `.env.local` stays Minis's own.
  sources.limited = { threadId: workThread, resumed: true };
  // 2. Threshold premove: an idle thread at 96% whose turn just finished moves, unresumed.
  const idleThread = await thread(work, "Idle at threshold", "hot");
  sources.idle = { threadId: idleThread, resumed: false };
  // 3. No machine qualifies (Solo fixture isn't linked on Minis): M4's own fallback runs.
  sources.fallback = { threadId: soloThread, local: true };
  await Promise.all([
    limitTurn(workThread, "limited"),
    send(idleThread, "Summarize the fixture."),
    limitTurn(soloThread, "solo"),
  ]);
  const moved = await until(
    "the limited and the idle thread to continue on Minis",
    () => {
      const a = recordOf(m4, workThread)?.continuedOn;
      const b = recordOf(m4, idleThread)?.continuedOn;
      return a && b ? { limited: a, idle: b } : null;
    },
    240_000,
  );
  receipt.moves = { limited: moved.limited, idle: moved.idle };

  const limitedView = await until("the source's note", async () => {
    const view = await projection(m4, workThread);
    return view.thread.movedTo?.note ? view : null;
  });
  const link = limitedView.thread.movedTo;
  NodeAssert.equal(link.kind, "handoff");
  NodeAssert.equal(link.environmentId, minis.environmentId);
  NodeAssert.equal(link.machineLabel, "Minis");
  NodeAssert.equal(link.threadId, moved.limited.threadId);
  NodeAssert.equal(
    link.note,
    "ACP Registry limit reached on M4 · continued on Minis with Link launch",
  );
  NodeAssert.equal(limitedView.thread.archivedAt ?? null, null, "The source is never archived");
  const continued = await until("the resumed turn on Minis to finish", async () => {
    const view = await projection(minis, moved.limited.threadId);
    return settledRuns(view).length > 0 ? view : null;
  });
  NodeAssert.equal(continued.runs.length, 1, "One resumed turn on Minis");
  NodeAssert.equal(continued.runs[0].providerInstanceId, "own");
  NodeAssert.equal(continued.thread.execution?.sourceRoot?.threadId, workThread);
  NodeAssert.equal(continued.thread.execution?.sourceRoot?.environmentId, m4.environmentId);
  const seed = continued.messages.find((message) => message.role === "user")?.text ?? "";
  NodeAssert.match(seed, /^Continue where you left off\./);
  NodeAssert.match(seed, /handed off from M4 after its usage limit was reached/);
  const worktree = continued.thread.worktreePath;
  NodeAssert.ok(worktree, "The continuation runs in its own worktree");
  assertPartialCheckpoint(workThread, "limited", continued);
  NodeAssert.equal(
    NodeFS.readFileSync(NodePath.join(worktree, ".env.local"), "utf8"),
    "FIXTURE_TOKEN=Minis-only\n",
    "Secrets come from Minis's own checkout, never from M4",
  );
  receipt.limitedMove = {
    note: link.note,
    continuation: moved.limited.threadId,
    worktree,
    seed: seed.slice(0, 400),
  };
  check(
    `Usage-limit stop moved the thread to Minis/own with its uncommitted work and one resumed turn; source note: "${link.note}"`,
  );
  NodeAssert.equal(continued.thread.modelSelection.instanceId, "own");
  NodeAssert.equal(agentTurns("twin").length, 0);
  check("While moving, the same-account target (Minis/twin) was skipped and Minis/own took it");

  const idleView = await until("the idle thread's note", async () => {
    const view = await projection(m4, idleThread);
    return view.thread.movedTo?.note ? view : null;
  });
  NodeAssert.equal(
    idleView.thread.movedTo.note,
    "Hit 95% of ACP Registry on M4 · continued on Minis with Link launch",
  );
  const idleThere = await projection(minis, moved.idle.threadId);
  NodeAssert.equal(idleThere.runs.length, 0, "An idle premove starts no turn");
  NodeAssert.equal(idleThere.messages.filter((m) => m.role === "user").length, 0);
  check(`Idle thread at the threshold moved with no resume: "${idleView.thread.movedTo.note}"`);

  const fellBack = await until("the same-machine fallback on M4", async () => {
    const view = await projection(m4, soloThread);
    return view.messages.some((m) => m.id.startsWith("limit-fallback:")) &&
      settledRuns(view).length >= 2
      ? view
      : null;
  });
  NodeAssert.equal(fellBack.runs.at(-1).providerInstanceId, "local");
  NodeAssert.equal(recordOf(m4, soloThread)?.continuedOn ?? null, null);
  NodeAssert.equal(continuationOf(soloThread), null);
  check("No machine qualified (Solo fixture not linked on Minis): M4's own fallback continued it");

  // 4. A stopped thread is never resumed: a turn on the 96% account that the user stops.
  const stoppedThread = await thread(work, "User stopped", "hot");
  sources.stopped = { threadId: stoppedThread };
  await send(stoppedThread, "HOLD-TURN until stopped.");
  const running = await until("the held turn to run", async () => {
    const view = await projection(m4, stoppedThread);
    return view.runs.find((run) => run.status === "running") ?? null;
  });
  await rpc(m4, "orchestration.dispatchCommand", {
    type: "run.interrupt",
    commandId: NodeCrypto.randomUUID(),
    threadId: stoppedThread,
    runId: running.id,
    cause: "user",
    holdQueue: true,
  });
  await until("the user's stop to land", async () => {
    const view = await projection(m4, stoppedThread);
    return settledRuns(view).length === 1 ? view : null;
  });

  // 5. The limit hits, then the source goes offline: Minis took over, M4 never heard it.
  const sourceDown = await thread(work, "Source goes offline");
  sources.sourceDown = { threadId: sourceDown, resumed: true };
  const stalled = armFault("stall-takeover");
  await limitTurn(sourceDown, "source-down");
  const answer = await Promise.race([
    stalled,
    sleep(240_000).then(() => {
      throw new Error("The takeover never reached Minis");
    }),
  ]);
  NodeAssert.equal(answer.status, 200, `Minis took over: ${answer.body}`);
  m4.child.kill("SIGKILL");
  await new Promise((done) =>
    m4.child.exitCode !== null || m4.child.signalCode !== null
      ? done()
      : m4.child.once("exit", done),
  );
  for (const held of heldAnswers.splice(0)) held.destroy();
  const orphaned = recordOf(m4, sourceDown);
  NodeAssert.equal(orphaned?.lease?.state, "handing-off", JSON.stringify(orphaned));
  NodeAssert.equal(orphaned?.continuedOn ?? null, null);
  const tookOver = JSON.parse(answer.body).threadId;
  NodeAssert.equal(continuationOf(sourceDown), tookOver);
  receipt.sourceOffline = { continuation: tookOver, leaseAfterKill: orphaned.lease };
  await boot(m4);
  // The persisted lease holds the thread from the first sweep; the heartbeat then fences it.
  const fenced = await until(
    "M4's heartbeat to fence the thread Minis continued",
    () => recordOf(m4, sourceDown)?.continuedOn ?? null,
    150_000,
  );
  NodeAssert.equal(fenced.threadId, tookOver);
  NodeAssert.equal(fenced.environmentId, minis.environmentId);
  const downView = await projection(m4, sourceDown);
  NodeAssert.equal(downView.runs.length, 1, "M4 never ran the turn again after the restart");
  NodeAssert.equal(downView.thread.movedTo?.threadId, tookOver);
  const downThere = await until("Minis's resumed turn", async () => {
    const view = await projection(minis, tookOver);
    return settledRuns(view).length > 0 ? view : null;
  });
  NodeAssert.equal(downThere.runs.length, 1);
  assertPartialCheckpoint(sourceDown, "source-down", downThere);
  check(
    "Limit hit, then M4 died before Minis's takeover answer: Minis continued once; restarted M4 stayed handing-off, ran nothing, and its heartbeat fenced the thread",
  );

  // 6. The target goes offline during the resume: the takeover never reaches Minis.
  const targetDown = await thread(work, "Target goes offline");
  sources.targetDown = { threadId: targetDown, resumed: true };
  const dropped = armFault("drop-takeover");
  await limitTurn(targetDown, "target-down");
  await Promise.race([
    dropped,
    sleep(240_000).then(() => {
      throw new Error("M4 never sent the takeover");
    }),
  ]);
  await stop(minis);
  const inDoubt = await until(
    "M4 to hold the thread in doubt",
    () => {
      const record = recordOf(m4, targetDown);
      return record?.lease?.state === "handing-off" && record.lastError ? record : null;
    },
    60_000,
  );
  NodeAssert.ok(inDoubt.pendingTakeover, "The exact takeover request is persisted for retry");
  receipt.targetOffline = {
    faultPoint:
      "Target unavailable before takeover request delivery; pending resume retried after reconnect",
    lease: inDoubt.lease,
    lastError: inDoubt.lastError,
    pendingTakeoverEpoch: inDoubt.pendingTakeover.request.epoch,
  };
  // Two more sweeps with Minis gone: nothing runs here, no fallback is sent.
  await sleep(65_000);
  const heldView = await projection(m4, targetDown);
  NodeAssert.equal(heldView.runs.length, 1, "Nothing ran on M4 while the move is in doubt");
  NodeAssert.ok(!heldView.messages.some((m) => /^limit-(fallback|resume):/.test(m.id)));
  const waiting = (await candidates(targetDown)).waiting;
  NodeAssert.ok(waiting, "The thread says why it waits");
  receipt.targetOffline.waiting = waiting;
  NodeAssert.equal(continuationOf(targetDown), null, "Minis received no takeover while offline");
  await boot(minis);
  // #550 re-sends the persisted takeover at its original epoch after Minis reconnects.
  const recovered = await until(
    "one continuation after Minis reconnects",
    async () => {
      const continuation = continuationOf(targetDown);
      if (!continuation || recordOf(m4, targetDown)?.continuedOn?.threadId !== continuation)
        return null;
      const view = await projection(minis, continuation);
      return settledRuns(view).length === 1 ? view : null;
    },
    180_000,
  );
  NodeAssert.equal(recovered.runs.length, 1, "The reconnect starts exactly one target turn");
  NodeAssert.equal(recovered.runs[0].providerInstanceId, "own");
  const recoveredRecord = recordOf(m4, targetDown);
  NodeAssert.equal(
    recoveredRecord.pendingTakeover,
    null,
    "Acknowledgement clears the pending request",
  );
  const recoveredIncoming = handoffDoc(minis).incomingDetails[`${m4.environmentId}/${targetDown}`];
  NodeAssert.equal(recoveredIncoming.takeoverEpoch, inDoubt.pendingTakeover.request.epoch);
  assertPartialCheckpoint(targetDown, "target-down", recovered);
  // Two further sweeps establish that retry/heartbeat convergence cannot start another turn.
  await sleep(65_000);
  NodeAssert.equal(
    (await projection(m4, targetDown)).runs.length,
    1,
    "The source never reruns after reconnect",
  );
  NodeAssert.equal(
    (await projection(minis, recovered.thread.id)).runs.length,
    1,
    "The target never resumes twice",
  );
  receipt.targetOffline.afterTargetBack = {
    lease: recoveredRecord.lease,
    continuedOn: recoveredRecord.continuedOn,
    targetRuns: recovered.runs.length,
    sourceRuns: 1,
    takeoverEpoch: recoveredIncoming.takeoverEpoch,
  };
  check(
    `Target offline during takeover: M4 holds ("${waiting}") without fallback; after reconnect Minis resumes exactly once at the original epoch and M4 never reruns`,
  );

  // 7. A distinct fault after the target provider actually starts its resumed turn.
  const resumeDown = await thread(work, "Target stops during running resume");
  sources.resumeDown = { threadId: resumeDown, resumed: true, restarted: true };
  NodeFS.writeFileSync(NodePath.join(scratch, "agent-own.json.hold-next"), "hold\n");
  await limitTurn(resumeDown, "resume-down");
  const resuming = await until(
    "the target continuation to be running before stopping Minis",
    async () => {
      const continuation = continuationOf(resumeDown);
      if (!continuation || recordOf(m4, resumeDown)?.continuedOn?.threadId !== continuation)
        return null;
      const view = await projection(minis, continuation);
      return view.runs.some((run) => run.status === "running") &&
        view.messages.some((message) =>
          message.text.includes("Target continuation is running before the offline fault."),
        )
        ? view
        : null;
    },
  );
  assertPartialCheckpoint(resumeDown, "resume-down", resuming);
  const beforeOfflineTurns = agentTurns("own").length;
  receipt.targetRunningOffline = {
    faultPoint:
      "Target provider emitted output and was running its resumed turn before its server stopped",
    continuation: resuming.thread.id,
    runId: resuming.runs[0].id,
    statusBeforeOffline: resuming.runs[0].status,
  };
  await stop(minis);
  NodeAssert.equal((await projection(m4, resumeDown)).runs.length, 1);
  await boot(minis);
  await sleep(65_000);
  const afterResumeRestart = await projection(minis, resuming.thread.id);
  NodeAssert.equal(continuationOf(resumeDown), resuming.thread.id);
  NodeAssert.equal(
    afterResumeRestart.runs.length,
    2,
    "One interrupted target run and one restart continuation",
  );
  NodeAssert.equal(afterResumeRestart.runs[0].id, resuming.runs[0].id);
  NodeAssert.equal(afterResumeRestart.runs[0].status, "cancelled");
  const restartRun = afterResumeRestart.runs[1];
  NodeAssert.equal(restartRun.restartContinuationOfRunId, resuming.runs[0].id);
  NodeAssert.equal(restartRun.status, "completed");
  NodeAssert.equal(restartRun.providerInstanceId, "own");
  NodeAssert.equal(
    afterResumeRestart.messages.filter(
      (message) => message.id === `message:restart-continuation:${resuming.runs[0].id}`,
    ).length,
    1,
  );
  NodeAssert.equal(
    agentTurns("own").length,
    beforeOfflineTurns + 1,
    "Exactly one prompt continues the interrupted target after restart",
  );
  NodeAssert.equal(
    (await projection(m4, resumeDown)).runs.length,
    1,
    "The source stays fenced while the target restarts",
  );
  receipt.targetRunningOffline.statusAfterRestart = restartRun.status;
  receipt.targetRunningOffline.restartRunId = restartRun.id;
  receipt.targetRunningOffline.restartContinuationOfRunId = restartRun.restartContinuationOfRunId;
  receipt.targetRunningOffline.targetRuns = afterResumeRestart.runs.length;
  check(
    "Target went offline during an observed running resume: same handoff thread, one cancelled target run with exactly one completed restart continuation, no source rerun",
  );

  // A separate thread held by explicit policy keeps candidate reasons visible after recovery.
  await rpc(m4, "server.updateSettings", { patch: { providerLimitAction: "wait" } });
  const waitingThread = await thread(work, "Waiting under explicit policy");
  sources.waiting = { threadId: waitingThread };
  await limitTurn(waitingThread, "waiting");
  // AC-10 in the app: every target with its reason, and the ordered list in Settings.
  receipt.screenshots = [];
  if (webBuilt()) {
    await captureCandidates(m4, waitingThread);
    const browser = await launchBrowser();
    try {
      await shotThread(browser, m4, workThread, "notice-source", "Continued on Minis");
      await shotThread(
        browser,
        minis,
        moved.limited.threadId,
        "notice-target",
        "Continued here from M4",
      );
    } finally {
      await browser.close();
    }
    for (const name of ["notice-source-1440.txt", "notice-source-390.txt"])
      NodeAssert.ok(
        NodeFS.readFileSync(NodePath.join(output, name), "utf8").includes(link.note),
        `${name} shows the note`,
      );
    check(
      'Both threads show the move: "Continued on Minis" with the note on M4, "Continued here from M4" on Minis (headless, 1440 and 390 px)',
    );
  } else receipt.screenshots = "skipped: build apps/web to capture the UI";

  // The stopped thread, after every sweep since: never resumed, moved or continued.
  const stoppedView = await projection(m4, stoppedThread);
  NodeAssert.equal(stoppedView.runs.length, 1, "The user-stopped turn never ran again");
  NodeAssert.equal(stoppedView.thread.movedTo ?? null, null);
  NodeAssert.equal(continuationOf(stoppedThread), null);
  check("A thread the user stopped (on the 96% account) was never resumed or moved");

  // No turn runs twice: per source run, the runs after it on M4 plus Minis's continuation runs.
  const ledger = {};
  for (const [name, source] of Object.entries(sources)) {
    const here = await projection(m4, source.threadId);
    const continuation = continuationOf(source.threadId);
    const there = continuation === null ? null : await projection(minis, continuation);
    const stopped = here.runs[0];
    const restarts =
      there?.runs.filter((run) => run.restartContinuationOfRunId !== undefined) ?? [];
    NodeAssert.equal(
      restarts.length,
      source.restarted ? 1 : 0,
      `${name}: each restart has one continuation`,
    );
    // The target-running fault adds a second interrupted run, with its own successor.
    const continuations = here.runs.length - 1 + (there?.runs.length ?? 0) - restarts.length;
    ledger[name] = {
      sourceRun: stopped.id,
      sourceRunStatus: stopped.status,
      runsHere: here.runs.length,
      continuation,
      runsThere: there?.runs.length ?? null,
      continuations,
      restartContinuations: restarts.map((run) => ({
        runId: run.id,
        sourceRunId: run.restartContinuationOfRunId,
      })),
    };
    NodeAssert.ok(continuations <= 1, `${name}: ${JSON.stringify(ledger[name])}`);
  }
  receipt.noTurnTwice = ledger;
  NodeAssert.equal(ledger.limited.continuations, 1);
  NodeAssert.equal(ledger.sourceDown.continuations, 1);
  NodeAssert.equal(ledger.fallback.continuations, 1);
  NodeAssert.equal(ledger.idle.runsThere, 0);
  NodeAssert.equal(ledger.stopped.continuations, 0);
  NodeAssert.equal(ledger.targetDown.continuations, 1);
  NodeAssert.equal(ledger.resumeDown.continuations, 1);
  NodeAssert.equal(ledger.waiting.continuations, 0);
  for (const name of [...minisInstances, ...m4Instances])
    receipt.stubAgentTurns[name] = agentTurns(name).length;
  NodeAssert.deepEqual(receipt.stubAgentTurns, {
    twin: 0,
    own: 5,
    busy: 0,
    mystery: 0,
    source: 6,
    hot: 2,
    local: 1,
  });
  check(
    "No turn ran twice: each source run has at most one continuation across both servers, and the echo agents saw exactly the expected prompts",
  );

  // Minis goes offline: once its cached reading ages out it is named offline, not eligible.
  await stop(minis);
  await new Promise((done) => proxy.close(done));
  proxy = undefined;
  let offline;
  for (let attempt = 0; attempt < 30; attempt++) {
    offline = byKey(await candidates(workThread));
    if (offline["Minis/own"].reason === "offline") break;
    await sleep(5000);
  }
  receipt.candidates.offline = offline;
  NodeAssert.equal(offline["Minis/own"].reason, "offline", offline["Minis/own"].text);
  NodeAssert.equal(offline["Minis/own"].text, "Minis: offline");
  NodeAssert.ok(
    Object.values(offline).every((c) => !c.eligible),
    "Nothing offline counts as room",
  );
  check(`Target offline refused: "${offline["Minis/own"].text}"`);

  receipt.success = true;
} catch (error) {
  receipt.error = error instanceof Error ? error.stack : String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const held of heldAnswers) held.destroy();
  if (proxy) await new Promise((done) => proxy.close(done));
  for (const host of hosts) await stop(host);
  save();
  if (receipt.success) NodeFS.rmSync(scratch, { recursive: true, force: true });
  else console.error(`Server data kept for inspection: ${scratch}`);
  console.log(`Receipt: ${NodePath.join(output, "receipt.json")}`);
}
