#!/usr/bin/env node
// Run on > Add to another machine between two real server processes on this Mac.
//
// A ("M4") holds the projects; B ("Minis") is where they are added. Each server
// has its own temp home, state folder and loopback port. They are paired the
// product's way: `fleet invite` on one, `fleet add` on the other, over a
// private-looking Tailscale name (`*.fixture.ts.net`) that resolves to a local
// TLS proxy, only inside these processes, with a throwaway certificate. A
// stand-in `tailscale` on their PATH reports that name and its Serve route.
// Origins are local bare repositories cloned over file://.
//
// Drives the real WebSocket RPC API and the real web client (headless):
//   a. clone to B with progress events, link as a member, Run on lists B
//   b. ignored non-secret files copy, .env* secrets do not
//   c. existing folder: same, behind, ahead, diverged, dirty, unrelated
//   d. cancel mid-clone, then restart B: no half-linked member
//   e. a nickname rename on A shows on B
// Never touches the live app stores, a real Tailscale or another machine.
//
// Usage: node scripts/studio-fleet/add-to-machine-live.mjs [/absolute/report/dir]
// Needs `apps/web` and `apps/server` built. STUDIO_TEST_PLAYWRIGHT_MODULE and
// STUDIO_TEST_CHROMIUM override the Playwright module and browser.
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

const assert = NodeAssert.default;
const { execFileSync, spawn } = NodeChildProcess;
const { createHash, randomBytes, randomUUID } = NodeCrypto;
const {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} = NodeFS;
const { request: httpRequest } = NodeHttp;
const { createServer: createHttpsServer } = NodeHttps;
const { createRequire } = NodeModule;
const { connect: netConnect, createServer: createNetServer } = NodeNet;
const { homedir, tmpdir } = NodeOS;
const { dirname, join, resolve } = NodePath;
const { fileURLToPath, pathToFileURL } = NodeURL;

assert.equal(Number(process.versions.node.split(".")[0]), 22, "Use the project's Node 22 runtime");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? join(root, "artifacts/0966-live"));
mkdirSync(output, { recursive: true, mode: 0o700 });
for (const name of readdirSync(output))
  if (/^server-.*\.log$/u.test(name)) rmSync(join(output, name));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "swc-0966-live-")));
const entrypoint = join(root, "apps/server/dist/bin.mjs");
const GIT = "/usr/bin/git";

const receipt = {
  source: execFileSync(GIT, ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  evidenceKind: "two-real-isolated-servers-local-bare-origins",
  builtEntrypointSha256: createHash("sha256").update(readFileSync(entrypoint)).digest("hex"),
  browser: { headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
  providerTurns: 0,
  scenarios: {},
  screenshots: [],
  pids: [],
  success: false,
};
const save = () =>
  writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
const scenario = (name, passed, evidence) => {
  receipt.scenarios[name] = { passed, evidence };
  save();
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(evidence)}\n`);
};
const log = (line) => process.stdout.write(`${line}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, what, timeout = 60_000, every = 250) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}
const freePort = () =>
  new Promise((done, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => done(value));
    });
  });

// ---------------------------------------------------------------- git fixtures
const gitEnv = {
  PATH: "/usr/bin:/bin",
  HOME: scratch,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const git = (cwd, ...args) =>
  execFileSync(GIT, args, { cwd, env: gitEnv, encoding: "utf8", stdio: "pipe" }).trim();
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const GITIGNORE = "notes/\nnode_modules/\n.env*\n";

/** A bare origin with two commits, and the URL a checkout records for it. */
function makeOrigin(name, { bigMegabytes = 0 } = {}) {
  const seed = join(scratch, "seeds", name);
  mkdirSync(seed, { recursive: true });
  git(seed, "-c", "init.defaultBranch=main", "init", "-q");
  write(join(seed, ".gitignore"), GITIGNORE);
  write(join(seed, "README.md"), `${name}\n`);
  write(join(seed, "src/app.js"), "export const version = 1;\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "First");
  if (bigMegabytes > 0) {
    // Incompressible blobs so a clone spends seconds receiving objects.
    for (let index = 0; index < bigMegabytes / 8; index += 1)
      write(join(seed, "blobs", `blob-${index}.bin`), randomBytes(8 * 1024 * 1024));
    git(seed, "add", "-A");
    git(seed, "commit", "-qm", "Blobs");
  }
  write(join(seed, "src/app.js"), "export const version = 2;\n");
  git(seed, "commit", "-qam", "Second");
  const bare = join(scratch, "origins", `${name}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  git(scratch, "clone", "-q", "--bare", seed, bare);
  return { name, bare, url: pathToFileURL(bare).href };
}

// ---------------------------------------------------------- fleet name and TLS
const tls = join(scratch, "tls");
mkdirSync(tls);
execFileSync(
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
    join(tls, "key.pem"),
    "-out",
    join(tls, "cert.pem"),
    "-subj",
    "/CN=m4.fixture.ts.net",
    "-addext",
    "subjectAltName=DNS:m4.fixture.ts.net,DNS:minis.fixture.ts.net",
  ],
  { stdio: "ignore" },
);
writeFileSync(
  join(tls, "resolve.mjs"),
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
// The stand-in tailscale: signed in, this host's fixture name, one Serve route to its port.
const shimDir = join(scratch, "bin");
mkdirSync(shimDir);
writeFileSync(
  join(shimDir, "tailscale"),
  `#!${process.execPath}
const args = process.argv.slice(2);
const name = process.env.STUDIO_FIXTURE_TS_NAME;
const servePort = process.env.STUDIO_FIXTURE_TS_SERVE_PORT;
const localPort = process.env.STUDIO_FIXTURE_TS_LOCAL_PORT;
if (!name) { process.stderr.write("Logged out.\\n"); process.exit(1); }
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({ BackendState: "Running", Self: { DNSName: name + "." } }));
} else if (args[0] === "serve" && args[1] === "status") {
  process.stdout.write(JSON.stringify({ Web: { [name + ":" + servePort]: { Handlers: { "/": { Proxy: "http://127.0.0.1:" + localPort } } } } }));
} else if (args[0] === "serve") {
  process.exit(0);
} else {
  process.exit(1);
}
`,
);
chmodSync(join(shimDir, "tailscale"), 0o755);

/** HTTPS at the fixture name in front of one server, websockets included. */
function startProxy(host) {
  const server = createHttpsServer(
    { key: readFileSync(join(tls, "key.pem")), cert: readFileSync(join(tls, "cert.pem")) },
    (req, res) => {
      const upstream = httpRequest(
        {
          host: "127.0.0.1",
          port: host.port,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    },
  );
  server.on("upgrade", (req, socket, head) => {
    const upstream = netConnect(host.port, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  return new Promise((done) => server.listen(host.proxyPort, "127.0.0.1", () => done(server)));
}

// ------------------------------------------------------------------ the hosts
const DRIVERS = [
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
async function makeHost(label, tsName) {
  const dir = join(scratch, label.toLowerCase());
  const home = join(dir, "home");
  const data = join(dir, "data");
  mkdirSync(join(data, "userdata"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(data, "userdata/settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(DRIVERS.map((driver) => [driver, { enabled: false }])),
      providerInstances: Object.fromEntries(
        DRIVERS.map((driver) => [driver, { driver, enabled: false, config: {} }]),
      ),
      cursorKeychainUsageEnabled: false,
    }),
  );
  const host = {
    label,
    dir,
    home,
    data,
    tsName,
    port: await freePort(),
    proxyPort: await freePort(),
    environmentId: randomUUID(),
  };
  host.origin = `http://127.0.0.1:${host.port}`;
  host.fleetUrl = `https://${tsName}:${host.proxyPort}`;
  writeFileSync(join(data, "userdata/environment-id"), host.environmentId);
  return host;
}
const hostEnv = (host) => ({
  PATH: `${shimDir}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  HOME: host.home,
  LANG: "en_US.UTF-8",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
  STUDIO_DISABLE_AUTO_UPDATE: "true",
  SPECWITHCODE_DISABLE_AUTO_UPDATE: "true",
  STUDIO_FIXTURE_TS_NAME: host.tsName,
  STUDIO_FIXTURE_TS_SERVE_PORT: String(host.proxyPort),
  STUDIO_FIXTURE_TS_LOCAL_PORT: String(host.port),
  NODE_EXTRA_CA_CERTS: join(tls, "cert.pem"),
  NODE_OPTIONS: `--import=${pathToFileURL(join(tls, "resolve.mjs")).href}`,
  PWDEBUG: "0",
  PLAYWRIGHT_HTML_OPEN: "never",
});

async function startServer(host) {
  const child = spawn(
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
    { cwd: host.dir, env: hostEnv(host), stdio: ["ignore", "pipe", "pipe"] },
  );
  host.child = child;
  receipt.pids.push({ label: host.label, pid: child.pid });
  save();
  const logFile = join(output, `server-${host.label.toLowerCase()}.log`);
  const token = await new Promise((done, reject) => {
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
      60_000,
    );
    const inspect = (chunk) => {
      const text = chunk.toString();
      writeFileSync(logFile, text.replace(/(Token: |token=)\S+/g, "$1<redacted>"), { flag: "a" });
      if (settled) return;
      buffer = (buffer + text).slice(-65536);
      const match = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) finish(done, match[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", () => finish(reject, new Error(`${host.label} exited during startup`)));
  });
  await exchange(host, token);
  host.rpc = new RpcClient(host);
}
async function stopServer(host) {
  host.rpc?.close();
  host.rpc = null;
  const child = host.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once("exit", done));
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 8000);
  await exited;
  clearTimeout(timer);
}
async function exchange(host, credential) {
  const response = await fetch(`${host.origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:specweave-studio:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Add to machine live verifier",
    }),
  });
  assert.equal(response.status, 200, `${host.label} token exchange failed`);
  host.token = (await response.json()).access_token;
}
async function http(host, path, data, method = "POST") {
  const response = await fetch(host.origin + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: host.origin,
      Authorization: `Bearer ${host.token}`,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `${host.label} ${path} failed: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

/** One WebSocket per host speaking the Effect RPC wire format the web client uses. */
class RpcClient {
  constructor(host) {
    this.host = host;
    this.next = 1;
    this.pending = new Map();
    this.streams = new Map();
    this.ready = this.open();
  }
  async open() {
    const { ticket } = await http(this.host, "/api/auth/websocket-ticket");
    const url = new URL(this.host.origin);
    url.protocol = "ws:";
    url.pathname = "/ws";
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    const socket = new WebSocket(url);
    this.socket = socket;
    await new Promise((done, reject) => {
      socket.addEventListener("open", done, { once: true });
      socket.addEventListener("error", () => reject(new Error("RPC socket failed")), {
        once: true,
      });
    });
    socket.addEventListener("message", (event) => this.receive(event.data));
    socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("RPC socket closed"));
      this.pending.clear();
    });
  }
  receive(data) {
    let values;
    try {
      const value = JSON.parse(data);
      values = Array.isArray(value) ? value : [value];
    } catch {
      return;
    }
    for (const value of values) {
      const id = String(value.requestId ?? "");
      if (value._tag === "Ping") {
        this.socket.send(JSON.stringify({ _tag: "Pong" }));
        continue;
      }
      if (value._tag === "Chunk") {
        const stream = this.streams.get(id);
        if (stream) {
          for (const item of value.values ?? []) stream(item);
          this.socket.send(JSON.stringify({ _tag: "Ack", requestId: id }));
        }
        continue;
      }
      if (value._tag === "Exit") {
        const waiter = this.pending.get(id);
        this.pending.delete(id);
        this.streams.delete(id);
        if (!waiter) continue;
        if (value.exit?._tag === "Success") waiter.resolve(value.exit.value);
        else waiter.reject(new RpcError(waiter.tag, value.exit));
      }
    }
  }
  async call(tag, payload, timeout = 60_000) {
    await this.ready;
    const id = String(this.next++);
    return new Promise((resolveCall, rejectCall) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectCall(new Error(`${this.host.label} RPC timeout: ${tag}`));
      }, timeout);
      this.pending.set(id, {
        tag,
        resolve: (value) => {
          clearTimeout(timer);
          resolveCall(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectCall(error);
        },
      });
      this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }
  async subscribe(tag, payload, onValue) {
    await this.ready;
    const id = String(this.next++);
    this.streams.set(id, onValue);
    this.pending.set(id, { tag, resolve: () => undefined, reject: () => undefined });
    this.socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    return () => {
      if (!this.streams.has(id)) return;
      this.streams.delete(id);
      this.pending.delete(id);
      this.socket.send(JSON.stringify({ _tag: "Interrupt", requestId: id, interruptors: [] }));
    };
  }
  close() {
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
  }
}
class RpcError extends Error {
  constructor(tag, exit) {
    const failure = JSON.stringify(exit?.cause ?? exit).slice(0, 2000);
    super(`RPC ${tag} failed: ${failure}`);
    this.exit = exit;
    this.failure = failure;
  }
}
const rpcFails = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof RpcError
      ? error
      : (() => {
          throw error;
        })();
  }
};

async function fleetCli(host, ...args) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [entrypoint, "fleet", ...args, "--base-dir", host.data], {
      cwd: host.dir,
      env: hostEnv(host),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.once("exit", (code) =>
      code === 0 ? done(out) : reject(new Error(`fleet ${args[0]} failed (${code}): ${out}`)),
    );
  });
}

// --------------------------------------------------------------- copy helpers
const COPY_SETTLED = new Set(["previewed", "applied", "undone", "failed", "cancelled"]);
async function pollCopy(host, operationId) {
  for (;;) {
    const status = await host.rpc.call("machineHandoff.copyStatus", { operationId });
    if (COPY_SETTLED.has(status.state)) return status;
    await sleep(500);
  }
}
async function offerAndScan(source, sourceProjectId, destination, operationId) {
  const offer = await source.rpc.call("machineHandoff.copyOffer", {
    projectId: sourceProjectId,
    operationId,
    mode: "copy-only",
    destinationEnvironmentId: destination.environmentId,
  });
  let scanned = offer.status;
  while (scanned.state === "scanning") {
    await sleep(500);
    scanned = await source.rpc.call("machineHandoff.copySourceStatus", { operationId });
  }
  assert.ok(scanned.summary, `Source scan failed: ${scanned.error}`);
  return { offer, summary: scanned.summary };
}
async function startCopy(destination, offer, targetFolder, selection) {
  await destination.rpc.call("machineHandoff.copyStart", {
    operationId: offer.operationId,
    sourceEnvironmentId: offer.sourceEnvironmentId,
    sourceProjectId: offer.sourceProjectId,
    sourceUrl: offer.sourceUrl,
    sourceMachine: offer.sourceMachine,
    token: offer.token,
    title: offer.title,
    mode: offer.mode,
    targetFolder,
    selection,
  });
  return pollCopy(destination, offer.operationId);
}
async function approveCopy(destination, operationId) {
  await destination.rpc.call("machineHandoff.copyApprove", { operationId });
  return pollCopy(destination, operationId);
}
async function cancelCopy(source, destination, operationId, reason) {
  await destination.rpc
    .call("machineHandoff.copyCancel", { operationId, reason })
    .catch(() => null);
  await source.rpc
    .call("machineHandoff.copySourceCancel", { operationId, reason })
    .catch(() => null);
}

/** The web client's linkCopyAsWorkers: preview both, prepare on kept, accept on joining, commit. */
async function linkAsWorker(kept, keptProjectId, joining, joiningProjectId) {
  const [keptView, joiningView] = await Promise.all([
    kept.rpc.call("projectLink.preview", { projectId: keptProjectId }),
    joining.rpc.call("projectLink.preview", { projectId: joiningProjectId }),
  ]);
  assert.equal(keptView.keepRefusal ?? null, null, `Kept refuses: ${keptView.keepRefusal}`);
  assert.equal(
    joiningView.joinRefusal ?? null,
    null,
    `Joining refuses: ${joiningView.joinRefusal}`,
  );
  const operationId = randomUUID();
  const prepared = await kept.rpc.call("projectLink.prepare", {
    operationId,
    projectId: keptProjectId,
    joining: joiningView.member,
  });
  const accepted = await joining.rpc.call("projectLink.accept", {
    operationId,
    projectId: joiningProjectId,
    kept: prepared.kept,
    logicalProject: prepared.logicalProject,
    coordinatorBinding: prepared.coordinatorBinding,
    keptFingerprint: prepared.fingerprint,
  });
  await kept.rpc.call("projectLink.commit", {
    operationId,
    projectId: keptProjectId,
    joining: accepted.member,
    notes: [],
  });
  return joining.rpc.call("projectLink.preview", { projectId: joiningProjectId });
}

async function createProject(host, title, workspaceRoot) {
  const projectId = randomUUID();
  await http(host, "/api/projects/mutate", {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title,
    workspaceRoot,
  });
  return projectId;
}
async function projectsOf(host) {
  const snapshot = await host.rpc.call("orchestration.getShellSnapshot", {}).catch(() => null);
  return snapshot?.projects ?? null;
}

// ------------------------------------------------------------------ browser
async function launchBrowser() {
  const require = createRequire(import.meta.url);
  let playwright;
  try {
    playwright = require(process.env.STUDIO_TEST_PLAYWRIGHT_MODULE ?? "playwright");
  } catch (error) {
    if (process.env.STUDIO_TEST_PLAYWRIGHT_MODULE) throw error;
    playwright = require(
      join(
        homedir(),
        ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
      ),
    );
  }
  // Prefer the given browser, then the bundled one, then the newest installed headless shell.
  const cache = join(homedir(), "Library/Caches/ms-playwright");
  const shells = existsSync(cache)
    ? readdirSync(cache)
        .filter((name) => name.startsWith("chromium_headless_shell-"))
        .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()))
        .map((name) => join(cache, name, "chrome-headless-shell-mac-arm64/chrome-headless-shell"))
        .filter((path) => existsSync(path))
    : [];
  const candidates = process.env.STUDIO_TEST_CHROMIUM
    ? [process.env.STUDIO_TEST_CHROMIUM]
    : [undefined, ...shells];
  let failure;
  for (const executablePath of candidates) {
    try {
      return await playwright.chromium.launch({
        headless: true,
        ...(executablePath ? { executablePath } : {}),
      });
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
/** A signed-in page on A whose saved connections also hold B, as a paired browser has. */
async function openClient(colorScheme) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    colorScheme: colorScheme === "system" ? "light" : colorScheme,
    reducedMotion: "reduce",
  });
  const pairing = await http(A, "/api/auth/pairing-token", { label: "Add to machine verifier" });
  // "system": each view is captured in light and dark by switching the emulated scheme.
  const signedIn = await context.request.post(`${A.origin}/api/auth/browser-session`, {
    headers: { Origin: A.origin },
    data: { credential: pairing.credential },
  });
  assert.equal(signedIn.status(), 200, "Browser sign-in to A failed");
  const page = await context.newPage();
  await page.route(`${A.origin}/__add-to-machine-proof`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>verifier</title>" }),
  );
  await page.goto(`${A.origin}/__add-to-machine-proof`);
  await page.evaluate(
    async ({ peers, theme }) => {
      localStorage.setItem(
        "studio:client-settings:v1",
        // Classic sidebar: a new thread opens a draft composer with Run on, not the coordinator.
        JSON.stringify({
          onboardingCompletedAt: new Date().toISOString(),
          theme,
          legacySidebarEnabled: true,
        }),
      );
      const document = {
        schemaVersion: 1,
        targets: [],
        profiles: [],
        credentials: [],
        remoteDpopTokens: [],
        disabledEnvironmentIds: [],
      };
      for (const peer of peers) {
        const connectionId = `fixture-${peer.environmentId}`;
        document.targets.push({
          _tag: "BearerConnectionTarget",
          environmentId: peer.environmentId,
          label: peer.label,
          connectionId,
        });
        document.profiles.push({
          _tag: "BearerConnectionProfile",
          environmentId: peer.environmentId,
          label: peer.label,
          connectionId,
          httpBaseUrl: peer.origin,
          wsBaseUrl: peer.origin.replace("http:", "ws:"),
        });
        document.credentials.push({
          connectionId,
          credential: { _tag: "BearerConnectionCredential", token: peer.token },
        });
      }
      const db = await new Promise((done, reject) => {
        const open = indexedDB.open("studio:connection-runtime", 4);
        open.onupgradeneeded = () => {
          for (const store of ["catalog", "shell", "thread", "server-config", "vcs-refs"])
            if (!open.result.objectStoreNames.contains(store)) open.result.createObjectStore(store);
        };
        open.onsuccess = () => done(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise((done, reject) => {
        const tx = db.transaction("catalog", "readwrite");
        tx.objectStore("catalog").put(JSON.stringify(document), "document");
        tx.oncomplete = done;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    {
      peers: [{ label: B.label, environmentId: B.environmentId, origin: B.origin, token: B.token }],
      theme: colorScheme,
    },
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.errors = errors;
  openPages.push(page);
  return page;
}
async function shoot(page, name, locator) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  const file = join(output, name);
  if (locator) await locator.screenshot({ path: file, animations: "disabled" });
  else await page.screenshot({ path: file, animations: "disabled" });
  receipt.screenshots.push(file);
  save();
  return file;
}
async function dump(page, name) {
  writeFileSync(join(output, name), await page.locator("body").innerText());
}

// ---------------------------------------------------------------- scenarios
/** Both themes of the same view: the app follows the system theme here. */
async function shootThemes(page, name, locator) {
  const files = [];
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(300);
    files.push(await shoot(page, `${name}-${scheme}.png`, locator?.()));
  }
  await page.emulateMedia({ colorScheme: "light" });
  return files;
}
const runOnButton = (page) => page.getByRole("button", { name: /^Run on:/ });
const menu = (page) => page.getByRole("menu").last();
const dialog = (page) => page.getByRole("dialog").last();

/** Overview > New session > project > Open native draft: a draft composer with Run on. */
async function openDraft(page, title) {
  await page.goto(`${A.origin}/`);
  await page.getByRole("button", { name: "New session", exact: true }).first().click();
  await page.locator("#studio-project").click();
  const options = page.getByRole("option");
  await options.first().waitFor();
  // Options read "<initials><title><host>"; copies on Minis name Minis as the host.
  const labels = await options.evaluateAll((nodes) =>
    nodes.map((node) => `${node.getAttribute("aria-label") ?? ""}|${node.textContent ?? ""}`),
  );
  const index = labels.findIndex((label) => {
    const text = label.split("|")[1].replace(/^[A-Z]{1,2}/u, "");
    return text.startsWith(title) && !text.endsWith("Minis") && !text.endsWith("Mini Lab");
  });
  assert.ok(index >= 0, `No ${title} on M4 in the new session picker: ${JSON.stringify(labels)}`);
  await options.nth(index).click();
  await page.getByRole("button", { name: /Open native draft/ }).click();
  await runOnButton(page).waitFor({ timeout: 30_000 });
}
async function openAddDialog(page, title) {
  await openDraft(page, title);
  await runOnButton(page).click();
  await menu(page)
    .getByRole("menuitem", { name: /Add to another machine/ })
    .click();
  await menu(page).getByText(`Add ${title} to`).waitFor();
  await menu(page).getByRole("menuitem").filter({ hasText: "Minis" }).click();
  await dialog(page).getByText(`Add ${title} to Minis`).waitFor({ timeout: 30_000 });
}
/** Every clone snapshot B publishes, as the composer's progress strip receives them. */
async function watchClones(host) {
  const events = [];
  const stop = await host.rpc.subscribe("subscribeProjectClones", {}, (list) =>
    events.push(...list.map((snapshot) => ({ ...snapshot, at: Date.now() }))),
  );
  return { events, stop };
}
const headOf = (path, ref = "HEAD") => git(path, "rev-parse", ref);
const refsOf = (path) =>
  git(path, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads")
    .split("\n")
    .filter(Boolean);

/** a + b: the full UI clone, extras copy and link, through the real web client. */
async function scenarioCloneAndLink(page, fixtures) {
  const watch = await watchClones(B);
  await openDraft(page, "demo-app");
  await runOnButton(page).click();
  await menu(page).getByText("Machines with demo-app").waitFor();
  await shootThemes(page, "01-run-on-menu", () => menu(page));
  await menu(page)
    .getByRole("menuitem", { name: /Add to another machine/ })
    .click();
  await menu(page).getByText("Clone it there").waitFor();
  await shootThemes(page, "02-run-on-add-to-machine", () => menu(page));
  await menu(page).getByRole("menuitem").filter({ hasText: "Minis" }).click();
  const box = dialog(page);
  await box.getByText("Add demo-app to Minis").waitFor({ timeout: 30_000 });
  await box.getByText(".env.local").waitFor({ timeout: 60_000 });
  // D-03: outside /Users or /home the default is ~/<name> on the destination.
  const destination = join(B.home, "demo-app");
  await box.getByText(destination).first().waitFor({ timeout: 30_000 });
  await box.getByRole("checkbox", { name: /Copy ignored files/ }).check();
  await shootThemes(page, "03-add-dialog", () => box);
  const dialogText = await box.innerText();
  writeFileSync(join(output, "03-add-dialog.txt"), dialogText);
  const secretsTicked = await box
    .locator("label")
    .filter({ hasText: /^\.env/ })
    .getByRole("checkbox")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-checked") ?? node.checked));
  await box.getByRole("button", { name: "Clone to Minis" }).click();
  const done = await until(
    () =>
      watch.events.find((event) => event.destinationPath === destination && event.phase === "done"),
    "the clone on Minis to finish",
    120_000,
  );
  const projectId = done.projectId;
  const linked = await until(
    async () => {
      const view = await B.rpc.call("projectLink.preview", { projectId }).catch(() => null);
      const members = view?.logicalProject?.members ?? [];
      return members.some((member) => member.projectId === A.demoId) ? view : null;
    },
    "the clone to be linked as a member",
    120_000,
    1000,
  );
  watch.stop();
  const files = {
    readme: existsSync(join(destination, "README.md")),
    ignoredNotes: existsSync(join(destination, "notes/todo.md")),
    env: existsSync(join(destination, ".env")),
    envLocal: existsSync(join(destination, ".env.local")),
    nodeModules: existsSync(join(destination, "node_modules")),
  };
  const sameHead = headOf(destination) === headOf(fixtures.demoRoot);
  const remote = git(destination, "remote", "get-url", "origin");
  // Run on now lists Minis with the project.
  await page.keyboard.press("Escape").catch(() => undefined);
  await runOnButton(page).waitFor();
  const trigger = await runOnButton(page).getAttribute("aria-label");
  await runOnButton(page).click();
  await menu(page).getByText("Machines with demo-app").waitFor();
  await until(
    async () => (await menu(page).innerText()).includes("Minis"),
    "Minis under Machines with demo-app",
    30_000,
  );
  const menuText = await menu(page).innerText();
  await shootThemes(page, "05-run-on-after-clone", () => menu(page));
  await page.keyboard.press("Escape");
  const phases = [...new Set(watch.events.map((event) => event.phase))];
  const stages = [...new Set(watch.events.map((event) => event.stage))];
  const passedA =
    done.phase === "done" &&
    sameHead &&
    remote === fixtures.demo.url &&
    linked.logicalProject.members.length === 2 &&
    menuText.includes("Minis") &&
    !menuText.includes("Clone it there");
  scenario("a. clone to a machine without the project, link, Run on lists it", passedA, {
    destination,
    projectIdOnMinis: projectId,
    cloneEvents: watch.events.length,
    phases,
    stages,
    remote,
    sameHead,
    members: linked.logicalProject.members.map((member) =>
      member.environmentId === A.environmentId ? "M4" : "Minis",
    ),
    runOnTrigger: trigger,
    runOnMenu: menuText.split("\n").filter(Boolean),
  });
  scenario(
    "b. copy ignored files: non-secret ignored copies, .env* does not",
    files.readme &&
      files.ignoredNotes &&
      !files.env &&
      !files.envLocal &&
      !files.nodeModules &&
      secretsTicked.every((value) => value === false || value === "false"),
    {
      files,
      secretCheckboxes: secretsTicked,
      dialogListsSecrets: dialogText.includes(".env.local"),
    },
  );
  return { projectId, destination };
}

/** c: a folder already on Minis, driven through the RPCs the dialog and review use. */
async function consolidate(name, { decide } = {}) {
  const fixture = caseFixtures[name];
  const operationId = randomUUID();
  const remoteUrl = fixture.origin.url;
  const inspected = await B.rpc.call("sourceControl.inspectDestination", {
    path: fixture.bRoot,
    remoteUrl,
  });
  const { offer, summary } = await offerAndScan(A, fixture.projectId, B, operationId);
  let status = await startCopy(B, offer, fixture.bRoot, ["repository", "tracked", "untracked"]);
  const row = () => status.rows.find((entry) => entry.kind === "repository");
  const before = {
    head: headOf(fixture.bRoot),
    row: row() && {
      status: row().status,
      choices: row().choices,
      needsDecision: row().needsDecision,
    },
  };
  const result = { inspected, before, summaryRepos: summary.repositories.length };
  if (decide?.refuseFirst) {
    const refused = await rpcFails(B.rpc.call("machineHandoff.copyApprove", { operationId }));
    status = await pollCopy(B, operationId);
    result.approveWithoutConsent = refused
      ? refused.failure.slice(0, 300)
      : `state ${status.state}`;
    result.refusedWithoutConsent = refused !== null && status.state === "previewed";
  }
  if (decide?.choice) {
    await B.rpc.call("machineHandoff.copyDecide", {
      operationId,
      decisions: { [row().id]: decide.choice },
    });
    status = await pollCopy(B, operationId);
  }
  status = await approveCopy(B, operationId);
  result.state = status.state;
  result.error = status.error;
  result.projectIdOnMinis = status.projectId;
  result.after = { head: headOf(fixture.bRoot), refs: refsOf(fixture.bRoot) };
  if (status.state === "applied" && status.projectId) {
    const view = await linkAsWorker(A, fixture.projectId, B, status.projectId);
    result.members = view.logicalProject?.members?.length ?? 0;
    result.linkedTo = view.logicalProject?.members?.some(
      (member) => member.projectId === fixture.projectId,
    );
  }
  result.operationId = operationId;
  return result;
}

async function scenarioConsolidation(page) {
  const sourceHead = (name) => headOf(caseFixtures[name].aRoot);
  const results = {};
  const same = await consolidate("same");
  results.same = same;
  const behind = await consolidate("behind");
  results.behind = behind;
  const ahead = await consolidate("ahead");
  results.ahead = ahead;
  const diverged = await consolidate("diverged", { decide: { choice: "keep-mine" } });
  results.diverged = diverged;
  const dirty = await consolidate("dirty", { decide: { refuseFirst: true, choice: "keep-mine" } });
  results.dirty = dirty;
  dirty.dirtyFileKept = readFileSync(join(caseFixtures.dirty.bRoot, "README.md"), "utf8").includes(
    "edited on Minis",
  );
  // Undo restores the diverged checkout: the imported branch goes away.
  const undone = await B.rpc.call("machineHandoff.copyUndo", {
    operationId: diverged.operationId,
    preview: false,
    force: false,
  });
  diverged.undo = {
    undone: undone.undone,
    refs: refsOf(caseFixtures.diverged.bRoot),
    problems: undone.problems,
  };
  const afterUndo = await Promise.all([
    A.rpc.call("projectLink.preview", { projectId: caseFixtures.diverged.projectId }),
    B.rpc.call("projectLink.preview", { projectId: diverged.projectIdOnMinis }),
  ]);
  diverged.undo.membersAfterUndo = afterUndo.map(
    (view) => view.logicalProject?.members?.length ?? 0,
  );
  diverged.undo.sameLogicalProject =
    afterUndo[0].logicalProject?.id === afterUndo[1].logicalProject?.id;

  // Named after M4's nickname, not the host label both servers share on this Mac.
  const importRef = (refs) => refs.find((ref) => ref.startsWith("refs/heads/swc/from-M4/main "));
  const ok = {
    same:
      same.before.row?.status === "same" &&
      same.state === "applied" &&
      same.after.head === same.before.head &&
      same.linkedTo === true,
    behind:
      behind.before.row?.status === "fast-forward" &&
      behind.state === "applied" &&
      behind.after.head === sourceHead("behind") &&
      behind.linkedTo === true,
    ahead:
      ahead.before.row?.status === "ahead" &&
      ahead.state === "applied" &&
      ahead.after.head === ahead.before.head &&
      ahead.linkedTo === true,
    diverged:
      diverged.before.row?.status === "diverged" &&
      diverged.before.row.needsDecision &&
      diverged.state === "applied" &&
      diverged.after.head === diverged.before.head &&
      importRef(diverged.after.refs)?.endsWith(sourceHead("diverged")) === true &&
      diverged.undo.undone &&
      !diverged.undo.refs.some((ref) => ref.includes("swc/from-")),
    dirty:
      dirty.before.row?.status === "dirty" &&
      dirty.refusedWithoutConsent === true &&
      dirty.state === "applied" &&
      dirty.after.head === dirty.before.head &&
      dirty.dirtyFileKept,
  };
  scenario("c1. existing folder, same commit: same, linked", ok.same, same);
  scenario("c2. existing folder behind: fast-forward, linked", ok.behind, behind);
  scenario("c3. existing folder ahead: kept, linked", ok.ahead, ahead);
  scenario(
    "c4. existing folder diverged: theirs as swc/from-<machine>/<branch>, undoable",
    ok.diverged,
    diverged,
  );
  scenario(
    "c5. existing folder dirty: refused without consent, keep-mine keeps the edit",
    ok.dirty,
    dirty,
  );

  // Unrelated folders: a different repository and a plain non-empty folder.
  const unrelated = {};
  for (const name of ["other-repo", "plain"]) {
    const fixture = caseFixtures[name];
    unrelated[name] = {
      inspected: await B.rpc.call("sourceControl.inspectDestination", {
        path: fixture.bRoot,
        remoteUrl: fixture.origin.url,
      }),
      clone:
        (
          await rpcFails(
            B.rpc.call("projectClone.start", {
              projectId: randomUUID(),
              title: name,
              createdAt: new Date().toISOString(),
              remoteUrl: fixture.origin.url,
              destinationPath: fixture.bRoot,
            }),
          )
        )?.failure?.slice(0, 300) ?? "started",
      untouched: readdirSync(fixture.bRoot).sort(),
    };
  }
  // The same through the dialog: it refuses and suggests another folder.
  await openAddDialog(page, "plain");
  const box = dialog(page);
  await box
    .getByText("That folder already has files that are not this repository.")
    .waitFor({ timeout: 30_000 });
  await shootThemes(page, "06-add-dialog-refused", () => box);
  unrelated.dialog = (await box.innerText()).split("\n").filter(Boolean);
  unrelated.cloneButtonDisabled = await box
    .getByRole("button", { name: "Clone to Minis" })
    .isDisabled();
  await box.getByRole("button", { name: "Cancel" }).click();
  scenario(
    "c6. unrelated folder (other repository or plain files): refused, suggests another path",
    unrelated["other-repo"].inspected.state === "repository" &&
      unrelated["other-repo"].inspected.sameRepository === false &&
      unrelated.plain.inspected.state === "not-repository" &&
      unrelated["other-repo"].clone !== "started" &&
      unrelated.plain.clone !== "started" &&
      unrelated.cloneButtonDisabled &&
      unrelated.dialog.some((line) => line.includes("plain-2")),
    unrelated,
  );

  // The consolidation review in the real dialog, for the diverged case's twin.
  await openAddDialog(page, "review");
  const review = dialog(page);
  await review.getByRole("button", { name: "Link and consolidate" }).waitFor({ timeout: 30_000 });
  await until(
    () => review.getByRole("button", { name: "Link and consolidate" }).isEnabled(),
    "Link and consolidate to enable",
    60_000,
  );
  await review.getByRole("button", { name: "Link and consolidate" }).click();
  await review.getByText("Link and consolidate on Minis").waitFor({ timeout: 60_000 });
  await review
    .locator('[data-slot="add-consolidate-review"][data-state="previewed"]')
    .waitFor({ timeout: 60_000 });
  await shootThemes(page, "07-consolidation-review", () => review);
  const reviewText = (await review.innerText()).split("\n").filter(Boolean);
  writeFileSync(join(output, "07-consolidation-review.txt"), reviewText.join("\n"));
  const reviewBefore = headOf(caseFixtures.review.bRoot);
  await review.getByText("Keep this machine’s version").first().click();
  await until(
    () => review.getByRole("button", { name: "Apply and link" }).isEnabled(),
    "Apply and link to enable",
    30_000,
  );
  await review.getByRole("button", { name: "Apply and link" }).click();
  await review.getByText(/^Linked: /).waitFor({ timeout: 120_000 });
  await shootThemes(page, "07b-consolidation-linked", () => review);
  const linkedText = (await review.innerText()).split("\n").filter(Boolean);
  const reviewView = await A.rpc.call("projectLink.preview", {
    projectId: caseFixtures.review.projectId,
  });
  const reviewRefs = refsOf(caseFixtures.review.bRoot);
  await page.keyboard.press("Escape");
  const reviewChoices = reviewText.filter((line) => /version|untouched|theirs/i.test(line));
  scenario(
    "c7. consolidation review in the dialog: diverged offers no take theirs; Apply and link",
    reviewText.some((line) => /Both machines have commits/i.test(line)) &&
      !reviewText.some((line) => /take theirs|their version|M4’s version/i.test(line)) &&
      (reviewView.logicalProject?.members?.length ?? 0) === 2 &&
      headOf(caseFixtures.review.bRoot) === reviewBefore &&
      reviewRefs.some((ref) => ref.startsWith("refs/heads/swc/from-M4/main ")),
    {
      review: reviewText,
      choices: reviewChoices,
      linked: linkedText.find((line) => line.startsWith("Linked: ")),
      members: reviewView.logicalProject?.members?.length,
      refs: reviewRefs,
    },
  );
}

/** d: Cancel in the composer's progress strip mid-clone, then restart Minis. */
async function scenarioCancel(page) {
  const watch = await watchClones(B);
  await openAddDialog(page, "big-app");
  const destination = join(B.home, "big-app");
  await dialog(page).getByText(destination).first().waitFor({ timeout: 30_000 });
  await until(
    () => dialog(page).getByRole("button", { name: "Clone to Minis" }).isEnabled(),
    "Clone to Minis to enable",
    60_000,
  );
  await dialog(page).getByRole("button", { name: "Clone to Minis" }).click();
  const strip = page.getByText(/^Cloning big-app/).first();
  await strip.waitFor({ timeout: 30_000 });
  await until(
    () =>
      watch.events.some(
        (event) =>
          event.destinationPath === destination &&
          event.stage === "receiving" &&
          (event.percent ?? 0) > 0,
      ),
    "receiving progress",
    60_000,
    100,
  );
  const stripBox = page
    .locator("[data-slot=composer-banner], [role=status]")
    .filter({ hasText: /Cloning big-app/ })
    .first();
  const stripLocator = (await stripBox.count())
    ? stripBox
    : strip.locator("xpath=ancestor::div[3]");
  await shootThemes(page, "04-progress-strip", () => stripLocator);
  await shootThemes(page, "04b-progress-strip-composer");
  const stripText = await stripLocator.innerText();
  const running = watch.events.filter(
    (event) => event.destinationPath === destination && event.phase === "running",
  );
  const projectId = running[0].projectId;
  await stripLocator.getByRole("button", { name: "Cancel" }).click();
  await until(
    () =>
      watch.events.some((event) => event.projectId === projectId && event.phase === "cancelled") ||
      !existsSync(destination),
    "the clone to stop",
    60_000,
  );
  await until(() => !existsSync(destination), "the partial folder to be removed", 30_000);
  watch.stop();
  const afterCancel = {
    folderExists: existsSync(destination),
    projectOnMinis: await B.rpc.call("projectLink.preview", { projectId }).then(
      () => true,
      () => false,
    ),
  };
  const sourceView = await A.rpc.call("projectLink.preview", { projectId: A.bigId });
  // Restart check: Minis restarts; nothing comes back half-linked, and the page's
  // pending job (if any) does not link anything once it re-checks the folder.
  await stopServer(B);
  await startServer(B);
  await sleep(35_000);
  const sourceAfterRestart = await A.rpc.call("projectLink.preview", { projectId: A.bigId });
  const afterRestart = {
    folderExists: existsSync(destination),
    projectOnMinis: await B.rpc.call("projectLink.preview", { projectId }).then(
      () => true,
      () => false,
    ),
    sourceMembers: sourceAfterRestart.logicalProject?.members?.length ?? 1,
    pendingJobs: await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.includes("add-to-machine")),
    ),
  };
  const percents = running.map((event) => event.percent).filter((value) => value !== null);
  scenario(
    "d. cancel mid-clone: no half-linked member, partial folder removed, restart clean",
    !afterCancel.folderExists &&
      !afterCancel.projectOnMinis &&
      (sourceView.logicalProject?.members?.length ?? 1) <= 1 &&
      !afterRestart.folderExists &&
      !afterRestart.projectOnMinis &&
      afterRestart.sourceMembers <= 1 &&
      afterRestart.pendingJobs.length === 0,
    {
      strip: stripText.split("\n").filter(Boolean),
      runningEvents: running.length,
      percents: [Math.min(...percents), Math.max(...percents)],
      phases: [
        ...new Set(
          watch.events.filter((event) => event.projectId === projectId).map((event) => event.phase),
        ),
      ],
      afterCancel,
      afterRestart,
      restartedMinisPid: B.child.pid,
    },
  );
}

/** e: rename Minis from M4's Run on menu; Minis's own server gets the name. */
async function scenarioNickname(page) {
  await openDraft(page, "demo-app");
  await runOnButton(page).click();
  await menu(page)
    .getByRole("menuitem", { name: /Rename a machine/ })
    .click();
  await menu(page).getByRole("menuitem", { name: "Rename Minis" }).click();
  const box = dialog(page);
  const input = box.getByRole("textbox").first();
  await input.fill("Mini Lab");
  await shootThemes(page, "08-rename-dialog", () => box);
  await box.getByRole("button", { name: /^(Rename|Save)/ }).click();
  const startedAt = Date.now();
  const onB = await until(
    async () => {
      const settings = await B.rpc.call("server.getSettings", {});
      return settings.machineNicknames?.[B.environmentId]?.name === "Mini Lab"
        ? settings.machineNicknames
        : null;
    },
    "the rename to reach Minis",
    90_000,
    500,
  );
  const onA = (await A.rpc.call("server.getSettings", {})).machineNicknames;
  const dialogSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
  // The page writes to every machine it is connected to. A rename stored on M4's
  // server alone reaches Minis over the fleet pairing (MachineNicknameSync).
  const fleetStart = Date.now();
  await A.rpc.call("server.updateSettings", {
    patch: {
      machineNicknames: {
        [A.environmentId]: { name: "M4 Max", updatedAt: new Date().toISOString() },
      },
    },
  });
  const viaFleet = await until(
    async () => {
      const settings = await B.rpc.call("server.getSettings", {});
      return settings.machineNicknames?.[A.environmentId]?.name === "M4 Max"
        ? settings.machineNicknames
        : null;
    },
    "the server-side rename to reach Minis over the fleet",
    90_000,
    500,
  );
  scenario("e. nickname rename on M4 shows on Minis", true, {
    fromRunOnMenu: {
      seconds: dialogSeconds,
      onM4: onA[B.environmentId],
      onMinis: onB[B.environmentId],
    },
    fromM4ServerOnly: {
      seconds: Math.round((Date.now() - fleetStart) / 100) / 10,
      onMinis: viaFleet[A.environmentId],
    },
  });
}

async function runScenarios(fixtures) {
  browser = await launchBrowser();
  const page = await openClient("system");
  const steps = [
    ["ab", () => scenarioCloneAndLink(page, fixtures)],
    ["c", () => scenarioConsolidation(page)],
    ["d", () => scenarioCancel(page)],
    // Last: it renames Minis, which the other scenarios look for by name.
    ["e", () => scenarioNickname(page)],
  ];
  for (const [name, run] of steps) {
    if (process.env.ONLY && !process.env.ONLY.split(",").includes(name)) continue;
    try {
      await run();
    } catch (error) {
      await page.screenshot({ path: join(output, `failure-${name}.png`) }).catch(() => undefined);
      await dump(page, `failure-${name}.txt`).catch(() => undefined);
      scenario(`${name} (stopped)`, false, { error: String(error?.stack ?? error).slice(0, 3000) });
    }
  }
  receipt.pageErrors = page.errors;
}

// ------------------------------------------------------------------- the run
let browser;
const caseFixtures = {};
const openPages = [];
const proxies = [];
const A = await makeHost("M4", "m4.fixture.ts.net");
const B = await makeHost("Minis", "minis.fixture.ts.net");
receipt.hosts = [A, B].map(({ label, environmentId, origin, fleetUrl }) => ({
  label,
  environmentId,
  origin,
  fleetUrl,
}));
let exitCode = 1;
try {
  // Fixtures first: building them blocks this process for a while.
  const demo = makeOrigin("demo-app");
  const big = makeOrigin("big-app", { bigMegabytes: 320 });
  const sourceCheckout = (origin) => {
    const path = join(A.home, "Projects", origin.name);
    mkdirSync(dirname(path), { recursive: true });
    git(scratch, "clone", "-q", origin.url, path);
    return path;
  };
  const demoRoot = sourceCheckout(demo);
  write(join(demoRoot, "notes/todo.md"), "Ignored notes, only on M4.\n");
  write(join(demoRoot, "node_modules/left-pad/index.js"), "module.exports = 1;\n");
  write(join(demoRoot, ".env"), "API_KEY=fixture-not-a-secret\n");
  write(join(demoRoot, ".env.local"), "LOCAL_KEY=fixture\n");
  const bigRoot = sourceCheckout(big);
  // Folders already on Minis, one per consolidation case, each with its own origin.
  const prepare = {
    same: () => undefined,
    behind: (path) => git(path, "reset", "-q", "--hard", "HEAD~1"),
    ahead: (path) => {
      write(join(path, "minis.txt"), "Only on Minis.\n");
      git(path, "add", "minis.txt");
      git(path, "commit", "-qm", "Minis only");
    },
    diverged: (path) => {
      git(path, "reset", "-q", "--hard", "HEAD~1");
      write(join(path, "minis.txt"), "Diverged on Minis.\n");
      git(path, "add", "minis.txt");
      git(path, "commit", "-qm", "Minis diverged");
    },
    dirty: (path) => {
      git(path, "reset", "-q", "--hard", "HEAD~1");
      write(join(path, "README.md"), "edited on Minis, not committed\n");
    },
  };
  prepare.review = prepare.diverged;
  const unrelatedOrigin = makeOrigin("unrelated");
  for (const name of [...Object.keys(prepare), "other-repo", "plain"]) {
    const origin = makeOrigin(name);
    const aRoot = sourceCheckout(origin);
    // Where the dialog's default folder points on Minis (D-03).
    const bRoot = join(B.home, name);
    if (name === "plain") write(join(bRoot, "notes.txt"), "Someone else's files.\n");
    else {
      git(scratch, "clone", "-q", name === "other-repo" ? unrelatedOrigin.url : origin.url, bRoot);
      prepare[name]?.(bRoot);
    }
    caseFixtures[name] = { origin, aRoot, bRoot };
  }
  for (const host of [A, B]) proxies.push(await startProxy(host));
  await Promise.all([startServer(A), startServer(B)]);
  log(`Servers up: A pid ${A.child.pid} ${A.origin}, B pid ${B.child.pid} ${B.origin}`);

  // Pairing, the product's way: invite on one machine, add the line on the other.
  for (const [inviter, adder] of [
    [B, A],
    [A, B],
  ]) {
    const invited = await fleetCli(
      inviter,
      "invite",
      "--label",
      inviter.label,
      "--tailscale-serve-port",
      String(inviter.proxyPort),
    );
    const code = invited
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 40 && !line.includes(" "));
    assert.ok(code, `No invitation line from ${inviter.label}: ${invited}`);
    const added = await fleetCli(adder, "add", code, "--id", inviter.label.toLowerCase());
    log(added.split("\n")[0]);
  }
  const fleetA = JSON.parse(readFileSync(join(A.data, "studio-fleet.json"), "utf8"));
  assert.equal(fleetA.machines[0].environmentId, B.environmentId);
  assert.equal(fleetA.machines[0].url, B.fleetUrl);
  receipt.pairing = "fleet invite on each machine, fleet add of the line on the other";
  save();

  // Each machine's own nickname, the way Settings > Connections stores it.
  const stamp = () => new Date().toISOString();
  await A.rpc.call("server.updateSettings", {
    patch: {
      machineNicknames: {
        [A.environmentId]: { name: "M4", updatedAt: stamp() },
        [B.environmentId]: { name: "Minis", updatedAt: stamp() },
      },
    },
  });

  A.demoId = await createProject(A, "demo-app", demoRoot);
  A.bigId = await createProject(A, "big-app", bigRoot);
  A.projects = { "demo-app": A.demoId, "big-app": A.bigId };
  for (const [name, fixture] of Object.entries(caseFixtures)) {
    fixture.projectId = await createProject(A, name, fixture.aRoot);
    A.projects[name] = fixture.projectId;
  }
  receipt.projects = { demoRoot, bigRoot };
  save();

  await runScenarios({ demo, big, demoRoot, bigRoot });
  exitCode = Object.values(receipt.scenarios).every((entry) => entry.passed) ? 0 : 1;
  receipt.success = exitCode === 0;
} catch (error) {
  receipt.error = String(error?.stack ?? error);
  log(`ERROR ${receipt.error}`);
  for (const [index, page] of openPages.entries()) {
    await page.screenshot({ path: join(output, `failure-${index}.png`) }).catch(() => undefined);
    await dump(page, `failure-${index}.txt`).catch(() => undefined);
  }
} finally {
  save();
  await browser?.close().catch(() => undefined);
  await Promise.all([A, B].map((host) => stopServer(host).catch(() => undefined)));
  for (const proxy of proxies) proxy.close();
  if (process.env.KEEP_SCRATCH !== "1") rmSync(scratch, { recursive: true, force: true });
  receipt.scratchRemoved = !existsSync(scratch);
  save();
}
process.exit(exitCode);
