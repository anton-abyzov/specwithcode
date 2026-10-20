#!/usr/bin/env node
// 0968: two isolated real servers prove which paired machine a limited thread may move to.
// M4 is the source, Minis the target. Usage is simulated per provider instance with
// STUDIO_SIMULATE_PROVIDER_USAGE; no provider turn runs and no live data is read.
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
  builtEntrypointSha256: NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(entrypoint))
    .digest("hex"),
  providerTurns: 0,
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
        PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        LANG: "en_US.UTF-8",
        STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        STUDIO_DISABLE_AUTO_UPDATE: "true",
        PWDEBUG: "0",
        PLAYWRIGHT_HTML_OPEN: "never",
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
    source: "local",
    commandPath: process.execPath,
    commandArgs: [agent, "--echo", NodePath.join(scratch, `agent-${name}.json`)],
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
  NodeFS.mkdirSync(NodePath.join(data, "userdata"), { recursive: true });
  const host = {
    label,
    dir,
    data,
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
async function createProject(host, title, remote) {
  const folder = NodePath.join(host.dir, title.replaceAll(" ", "-"));
  NodeFS.mkdirSync(folder);
  NodeFS.writeFileSync(NodePath.join(folder, "README.md"), "Synthetic limit handoff fixture.\n");
  const git = (...args) =>
    NodeChildProcess.execFileSync("/usr/bin/git", args, {
      cwd: folder,
      stdio: "ignore",
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
  git("init", "-q", "-b", "main");
  git("remote", "add", "origin", remote);
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

async function captureScreens(host, threadId) {
  const { chromium } = NodeModule.createRequire(import.meta.url)(
    process.env.PLAYWRIGHT_MODULE ??
      NodePath.join(
        NodeOS.homedir(),
        ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
      ),
  );
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });
  receipt.screenshots = [];
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
    "The limited thread lists each machine target with its reason, and Settings shows the ordered list (headless, 1440 and 390 px)",
  );
}

let proxy;
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
  await exchange(minis, await start(minis));
  const minisWork = await createProject(
    minis,
    "Limit fixture",
    "https://github.com/example/limit-fixture.git",
  );
  const minisEasychamp = await createProject(
    minis,
    "EasyChamp",
    "https://github.com/example/easychamp.git",
  );
  await providersReady(minis, minisInstances);

  const proxyPort = await port();
  proxy = NodeHttps.createServer(
    {
      key: NodeFS.readFileSync(NodePath.join(tls, "key.pem")),
      cert: NodeFS.readFileSync(NodePath.join(tls, "cert.pem")),
    },
    (incoming, outgoing) => {
      const forwarded = NodeHttp.request(
        `${minis.origin}${incoming.url}`,
        {
          method: incoming.method,
          headers: { ...incoming.headers, "x-forwarded-proto": "https" },
        },
        (response) => {
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      forwarded.on("error", () => outgoing.destroy());
      incoming.pipe(forwarded);
    },
  );
  await new Promise((done) => proxy.listen(proxyPort, "127.0.0.1", done));
  const deadPort = await port();
  const m1EnvironmentId = NodeCrypto.randomUUID();

  const target = (instanceId, environmentId = minis.environmentId, label = "Minis") => ({
    environmentId,
    label,
    modelSelection: { instanceId, model: "link-launch" },
  });
  const m4 = await makeHost(
    "M4",
    ["source"],
    {
      providerLimitSwitchAtPercent: 95,
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
      STUDIO_SIMULATE_PROVIDER_USAGE: "source=97@pool-m4",
      // Turns on M4's provider stop on a usage limit before any provider process starts.
      STUDIO_SIMULATE_USAGE_LIMIT: "source",
      NODE_EXTRA_CA_CERTS: NodePath.join(tls, "cert.pem"),
      NODE_OPTIONS: `--import=${NodeURL.pathToFileURL(NodePath.join(tls, "resolve.mjs")).href}`,
    },
  );
  hosts.push(m4);
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
  await exchange(m4, await start(m4));
  const work = await createProject(
    m4,
    "Limit fixture",
    "https://github.com/example/limit-fixture.git",
  );
  const easychamp = await createProject(
    m4,
    "EasyChamp",
    "https://github.com/example/easychamp.git",
  );
  const solo = await createProject(m4, "Solo fixture", "https://github.com/example/solo.git");
  await providersReady(m4, ["source"]);
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
  const thread = async (projectId, title) => {
    const threadId = `limit-${NodeCrypto.randomUUID()}`;
    await rpc(m4, "orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: NodeCrypto.randomUUID(),
      threadId,
      projectId,
      title,
      modelSelection: { instanceId: "source", model: "link-launch" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
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
  NodeAssert.equal(judged.available, false, "Without 0967's handOff nothing moves yet");
  NodeAssert.equal(seen["Minis/own"].reason, "eligible", JSON.stringify(judged));
  NodeAssert.equal(seen["Minis/own"].eligible, true);
  NodeAssert.equal(seen["Minis/own"].usedPercent, 40);
  NodeAssert.ok(seen["Minis/own"].resetsAt, "The reset time travels with the usage");
  check(`Another account below the threshold is eligible: "${seen["Minis/own"].text}"`);
  NodeAssert.equal(seen["Minis/twin"].reason, "same_account");
  NodeAssert.equal(seen["Minis/twin"].eligible, false);
  NodeAssert.match(seen["Minis/twin"].text, /^Minis: same .+ account as .+$/);
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

  // AC-10 in the app: the limited thread lists every target with its reason, and Settings
  // shows the ordered list. Headless Chromium against M4's built web app.
  await rpc(m4, "orchestration.dispatchCommand", {
    type: "message.dispatch",
    commandId: NodeCrypto.randomUUID(),
    threadId: workThread,
    messageId: NodeCrypto.randomUUID(),
    text: "Continue the fixture work.",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "start_immediately" },
  });
  if (NodeFS.existsSync(NodePath.join(root, "apps/server/dist/client/index.html")))
    await captureScreens(m4, workThread);
  else receipt.screenshots = "skipped: build apps/web before apps/server to capture the UI";

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
  if (proxy) await new Promise((done) => proxy.close(done));
  for (const host of hosts) await stop(host);
  save();
  if (receipt.success) NodeFS.rmSync(scratch, { recursive: true, force: true });
  else console.error(`Server data kept for inspection: ${scratch}`);
  console.log(`Receipt: ${NodePath.join(output, "receipt.json")}`);
}
