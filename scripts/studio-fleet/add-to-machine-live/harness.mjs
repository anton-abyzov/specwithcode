// Shared harness for the two-server Run on > Add to another machine check:
// git fixtures, the fixture Tailscale name and TLS proxy, the two server
// processes, the WebSocket RPC client, folder-copy helpers and the headless page.
// The entry script is scripts/studio-fleet/add-to-machine-live.mjs.
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

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const output = resolve(process.argv[2] ?? join(root, "artifacts/0966-live"));
mkdirSync(output, { recursive: true, mode: 0o700 });
for (const name of readdirSync(output))
  if (/^server-.*\.log$/u.test(name)) rmSync(join(output, name));
export const scratch = realpathSync(mkdtempSync(join(tmpdir(), "swc-0966-live-")));
export const entrypoint = join(root, "apps/server/dist/bin.mjs");
export const GIT = "/usr/bin/git";

/**
 * The commit the run used. Uncommitted changes outside the report folder are
 * listed: a run with any is not evidence for that commit, and fails.
 */
function sourceOf() {
  const run = (...args) => execFileSync(GIT, args, { cwd: root, encoding: "utf8" }).trim();
  const reportPrefix = output.startsWith(`${root}/`) ? output.slice(root.length + 1) : null;
  const dirty = execFileSync(GIT, ["status", "--porcelain", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3))
    .filter(
      (path) => !path.startsWith("artifacts/") && !(reportPrefix && path.startsWith(reportPrefix)),
    );
  // The builds hold apps/ and packages/; a later commit to scripts/ alone needs no rebuild.
  const committedAt = run("log", "-1", "--format=%cI", "--", "apps", "packages");
  const serverBuilt = NodeFS.statSync(entrypoint).mtime;
  const webBuilt = NodeFS.statSync(join(root, "apps/server/dist/client/index.html")).mtime;
  return {
    commit: run("rev-parse", "HEAD"),
    buildInputsCommittedAt: committedAt,
    // A build older than the last commit to its inputs cannot contain it.
    builtAfterCommit: serverBuilt >= new Date(committedAt) && webBuilt >= new Date(committedAt),
    branch: run("rev-parse", "--abbrev-ref", "HEAD"),
    subject: run("log", "-1", "--format=%s"),
    uncommittedPaths: dirty,
    builtAt: {
      server: serverBuilt.toISOString(),
      // The server serves the web build it copied into dist/client.
      web: webBuilt.toISOString(),
    },
    builtSha256: {
      server: createHash("sha256").update(readFileSync(entrypoint)).digest("hex"),
      webIndex: createHash("sha256")
        .update(readFileSync(join(root, "apps/server/dist/client/index.html")))
        .digest("hex"),
    },
  };
}

export const receipt = {
  source: sourceOf(),
  evidenceKind: "two-real-isolated-servers-local-bare-origins",
  browser: { headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
  providerTurns: 0,
  scenarios: {},
  screenshots: [],
  pids: [],
  success: false,
};
export const save = () =>
  writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
export const scenario = (name, passed, evidence) => {
  receipt.scenarios[name] = { passed, evidence };
  save();
  process.stdout.write(`${passed ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(evidence)}\n`);
};
export const log = (line) => process.stdout.write(`${line}\n`);
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export async function until(check, what, timeout = 60_000, every = 250) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}
export const freePort = () =>
  new Promise((done, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => done(value));
    });
  });

/** The two hosts, the browser and the per-case fixtures, set up by the entry script. */
export const state = { A: null, B: null, browser: null, openPages: [], caseFixtures: {} };

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
export const git = (cwd, ...args) =>
  execFileSync(GIT, args, { cwd, env: gitEnv, encoding: "utf8", stdio: "pipe" }).trim();
export const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};
const GITIGNORE = "notes/\nnode_modules/\n.env*\n";

/** A bare origin with two commits, and the URL a checkout records for it. */
export function makeOrigin(name, { bigMegabytes = 0 } = {}) {
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
export function startProxy(host) {
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
export async function makeHost(label, tsName) {
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
export const hostEnv = (host) => ({
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

export async function startServer(host) {
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
export async function stopServer(host) {
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
export async function exchange(host, credential) {
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
export async function http(host, path, data, method = "POST") {
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
export class RpcClient {
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
export class RpcError extends Error {
  constructor(tag, exit) {
    const failure = JSON.stringify(exit?.cause ?? exit).slice(0, 2000);
    super(`RPC ${tag} failed: ${failure}`);
    this.exit = exit;
    this.failure = failure;
  }
}
export const rpcFails = async (promise) => {
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

export async function fleetCli(host, ...args) {
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
export async function pollCopy(host, operationId) {
  for (;;) {
    const status = await host.rpc.call("machineHandoff.copyStatus", { operationId });
    if (COPY_SETTLED.has(status.state)) return status;
    await sleep(500);
  }
}
export async function offerAndScan(source, sourceProjectId, destination, operationId) {
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
export async function startCopy(destination, offer, targetFolder, selection) {
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
export async function approveCopy(destination, operationId) {
  await destination.rpc.call("machineHandoff.copyApprove", { operationId });
  return pollCopy(destination, operationId);
}
export async function cancelCopy(source, destination, operationId, reason) {
  await destination.rpc
    .call("machineHandoff.copyCancel", { operationId, reason })
    .catch(() => null);
  await source.rpc
    .call("machineHandoff.copySourceCancel", { operationId, reason })
    .catch(() => null);
}

/** The web client's linkCopyAsWorkers: preview both, prepare on kept, accept on joining, commit. */
export async function linkAsWorker(kept, keptProjectId, joining, joiningProjectId) {
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

export async function createProject(host, title, workspaceRoot) {
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
export async function projectsOf(host) {
  // The shell stream opens with a snapshot of every project on the machine.
  let first;
  const snapshot = new Promise((done) => (first = done));
  const stop = await host.rpc.subscribe("orchestration.subscribeShell", {}, (value) => {
    if (value?.kind === "snapshot") first(value.snapshot.projects);
  });
  const projects = await Promise.race([snapshot, sleep(15_000).then(() => null)]);
  stop();
  if (!projects) throw new Error(`${host.label} sent no shell snapshot`);
  return projects;
}

// ------------------------------------------------------------------ browser
export async function launchBrowser() {
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
export async function openClient(colorScheme) {
  const { A, B } = state;
  const context = await state.browser.newContext({
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
  state.openPages.push(page);
  return page;
}
export async function shoot(page, name, locator) {
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
export async function dump(page, name) {
  writeFileSync(join(output, name), await page.locator("body").innerText());
}

// ---------------------------------------------------------------- scenarios
/** Both themes of the same view: the app follows the system theme here. */
export async function shootThemes(page, name, locator) {
  const files = [];
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(300);
    files.push(await shoot(page, `${name}-${scheme}.png`, locator?.()));
  }
  await page.emulateMedia({ colorScheme: "light" });
  return files;
}
export const runOnButton = (page) => page.getByRole("button", { name: /^Run on:/ });
export const menu = (page) => page.getByRole("menu").last();
export const dialog = (page) => page.getByRole("dialog").last();

/** Overview > New session > project > Open native draft: a draft composer with Run on. */
export async function openDraft(page, title) {
  await page.goto(`${state.A.origin}/`);
  await page.getByRole("button", { name: "New session", exact: true }).first().click();
  const options = page.getByRole("option");
  // Options read "<initials><title><host>"; copies on Minis name Minis as the host.
  // Each machine's projects arrive on their own connection, so wait for M4's.
  let labels = [];
  const index = await until(
    async () => {
      if ((await options.count()) === 0) await page.locator("#studio-project").click();
      await options.first().waitFor();
      labels = await options.evaluateAll((nodes) =>
        nodes.map((node) => `${node.getAttribute("aria-label") ?? ""}|${node.textContent ?? ""}`),
      );
      const found = labels.findIndex((label) => {
        const text = label.split("|")[1].replace(/^[A-Z]{1,2}/u, "");
        return text.startsWith(title) && !text.endsWith("Minis") && !text.endsWith("Mini Lab");
      });
      if (found >= 0) return found + 1;
      await page.keyboard.press("Escape");
      return null;
    },
    `${title} on M4 in the new session picker`,
    30_000,
    500,
  ).catch((error) => {
    throw new Error(`${error.message}: ${JSON.stringify(labels)}`);
  });
  await options.nth(index - 1).click();
  await page.getByRole("button", { name: /Open native draft/ }).click();
  await runOnButton(page).waitFor({ timeout: 30_000 });
}
export async function openAddDialog(page, title) {
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
export async function watchClones(host) {
  const events = [];
  const stop = await host.rpc.subscribe("subscribeProjectClones", {}, (list) =>
    events.push(...list.map((snapshot) => ({ ...snapshot, at: Date.now() }))),
  );
  return { events, stop };
}
export const headOf = (path, ref = "HEAD") => git(path, "rev-parse", ref);
export const refsOf = (path) =>
  git(path, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads")
    .split("\n")
    .filter(Boolean);
