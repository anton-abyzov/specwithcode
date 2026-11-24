/**
 * One scratch SpecWithCode server for the chaos rigs (1465): a private home,
 * natives disabled, chaos-agent instances only, started from source or from a
 * built entry point. Nothing here reads a live home or a credential folder.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

export const ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);
export const AGENT = NodePath.join(ROOT, "scripts/studio-chaos/chaos-agent.mjs");
export const MODEL = "chaos";
const NATIVES = [
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

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export const freePort = () =>
  new Promise((done, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address().port;
      server.close(() => done(value));
    });
  });

/** Waits for `read` to return something truthy; null when the time runs out. */
export async function until(read, timeoutMs, everyMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await sleep(everyMs);
  }
  return null;
}

/**
 * Lays out a home under `dir`: settings with one chaos-agent instance per
 * name in `instances` (serving `models[name]`, else MODEL), a control file
 * and one turn log per instance.
 */
export function makeHome(dir, { instances, models = {}, settings = {} }) {
  const data = NodePath.join(dir, "data");
  const bin = NodePath.join(dir, "bin");
  const project = NodePath.join(dir, "project");
  for (const folder of [NodePath.join(data, "userdata"), bin, project, NodePath.join(dir, "tmp")])
    NodeFS.mkdirSync(folder, { recursive: true, mode: 0o700 });
  // The server names its machine from macOS's ComputerName; this answers "Chaos rig" instead,
  // so prompts and logs never carry the real machine's name.
  NodeFS.writeFileSync(
    NodePath.join(bin, "scutil"),
    `#!/bin/sh\ncase "$*" in\n  "--get ComputerName"|"--get LocalHostName") echo "Chaos rig" ;;\n  *) exec /usr/sbin/scutil "$@" ;;\nesac\n`,
    { mode: 0o755 },
  );
  // The server reads PATH through the login shell; this one runs the command with no profile,
  // so no host dotfile can point the scratch server at live credentials.
  NodeFS.writeFileSync(
    NodePath.join(bin, "login-shell"),
    `#!/bin/sh\nexport PATH="${bin}:$PATH"\nshift\nexec /bin/sh -c "$1"\n`,
    { mode: 0o755 },
  );
  const control = NodePath.join(dir, "control.json");
  NodeFS.writeFileSync(control, JSON.stringify({ instances: {} }));
  const logs = Object.fromEntries(
    instances.map((name) => [name, NodePath.join(dir, `turns-${name}.jsonl`)]),
  );
  const instance = (name) => ({
    driver: "acpRegistry",
    displayName: `Chaos ${name}`,
    enabled: true,
    config: {
      source: "local",
      commandPath: process.execPath,
      commandArgs: [
        AGENT,
        "--instance",
        name,
        "--control",
        control,
        "--log",
        logs[name],
        "--model",
        models[name] ?? MODEL,
      ],
      customModels: [models[name] ?? MODEL],
    },
  });
  NodeFS.writeFileSync(
    NodePath.join(data, "userdata/settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(NATIVES.map((driver) => [driver, { enabled: false }])),
      providerInstances: {
        ...Object.fromEntries(
          NATIVES.map((driver) => [driver, { driver, enabled: false, config: {} }]),
        ),
        ...Object.fromEntries(instances.map((name) => [name, instance(name)])),
      },
      cursorKeychainUsageEnabled: false,
      ...settings,
    }),
    { mode: 0o600 },
  );
  NodeFS.writeFileSync(NodePath.join(project, "README.md"), "Chaos rig fixture project.\n");
  const git = (...args) =>
    NodeChildProcess.execFileSync(
      "/usr/bin/git",
      ["-c", "user.name=Chaos", "-c", "user.email=chaos@example.invalid", ...args],
      {
        cwd: project,
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      },
    );
  git("init", "-q", "-b", "main");
  git("add", "README.md");
  git("commit", "-q", "-m", "Chaos fixture base");
  return { dir, data, bin, project, control, logs, instances };
}

/** Writes the whole control document at once (rename), so the agent never reads half of it. */
export function writeControl(home, instances) {
  const temp = `${home.control}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temp, JSON.stringify({ instances }));
  NodeFS.renameSync(temp, home.control);
}

export function readTurns(home) {
  const turns = [];
  for (const file of Object.values(home.logs)) {
    if (!NodeFS.existsSync(file)) continue;
    for (const line of NodeFS.readFileSync(file, "utf8").split("\n"))
      if (line.trim()) turns.push(JSON.parse(line));
  }
  return turns.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Starts the server on the home and signs in. `entry` is the built
 * `apps/server/dist/bin.mjs` when present, else the source `bin.ts`.
 */
export async function startServer(home, { env = {}, logFile, entry } = {}) {
  const built = NodePath.join(ROOT, "apps/server/dist/bin.mjs");
  const script =
    entry ?? (NodeFS.existsSync(built) ? built : NodePath.join(ROOT, "apps/server/src/bin.ts"));
  const port = home.port ?? (home.port = await freePort());
  const origin = `http://127.0.0.1:${port}`;
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      script,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      home.data,
      "--no-browser",
    ],
    {
      cwd: home.dir,
      env: {
        HOME: home.dir,
        TMPDIR: NodePath.join(home.dir, "tmp"),
        PATH: `${home.bin}:${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        LANG: "en_US.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        STUDIO_DISABLE_AUTO_UPDATE: "true",
        SHELL: NodePath.join(home.bin, "login-shell"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so stopServer can end the server and its agents together.
      detached: true,
    },
  );
  if (logFile) NodeFS.writeFileSync(logFile, "", { flag: "a" });
  try {
    return await signInBootstrap(home, child, origin, logFile);
  } catch (error) {
    // Nobody else holds this PID yet: stop it here rather than leak it.
    await stopServer({ child }, { kill: true });
    throw error;
  }
}

async function signInBootstrap(home, child, origin, logFile) {
  const credential = await new Promise((done, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("server startup timed out")), 120_000);
    const inspect = (chunk) => {
      if (logFile)
        NodeFS.appendFileSync(logFile, String(chunk).replace(/Token: \S+/g, "Token: <redacted>"));
      if (settled) return;
      buffer = (buffer + chunk).slice(-65536);
      const token = buffer.match(/(?:^|\n)Token: (\S+)/);
      if (token) finish(done, token[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) =>
      finish(reject, new Error(`server exited during startup (${code})`)),
    );
  });
  const response = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:specweave-studio:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Chaos rig",
    }),
  });
  if (response.status !== 200) throw new Error(`token exchange failed (${response.status})`);
  const server = { home, origin, child, token: (await response.json()).access_token };
  return server;
}

/**
 * Stops the server this rig started. It runs as the leader of its own process
 * group (spawned detached), so its agents share that group: the group is
 * killed whole, even after the server itself exited, and no PID outside it is
 * ever signalled.
 */
export async function stopServer(server, { kill = false } = {}) {
  const child = server?.child;
  if (!child?.pid) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill(kill ? "SIGKILL" : "SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(timer);
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group is already empty.
  }
}

export async function request(server, path, data) {
  const response = await fetch(server.origin + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: server.origin,
      Authorization: `Bearer ${server.token}`,
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  if (response.status !== 200) throw new Error(`request failed: ${path} (${response.status})`);
  return response.json();
}

export async function rpc(server, tag, payload = {}) {
  const { ticket } = await request(server, "/api/auth/websocket-ticket");
  const url = new URL(server.origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return new Promise((done, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`RPC timeout: ${tag}`));
    }, 60_000);
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`RPC transport failed: ${tag}`));
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
            reject(new Error(`RPC rejected: ${tag} ${JSON.stringify(value.exit).slice(0, 2000)}`));
        }
    });
  });
}

export const command = (server, payload) =>
  rpc(server, "orchestration.dispatchCommand", { commandId: NodeCrypto.randomUUID(), ...payload });

export const projection = (server, threadId) =>
  rpc(server, "orchestration.getThreadProjection", { threadId });

export async function providersReady(server, names, timeoutMs = 90_000) {
  let last = [];
  const ready = await until(
    async () => {
      const config = await rpc(server, "server.getConfig", {});
      last = config.providers
        .filter((p) => names.includes(p.instanceId))
        .map((p) => `${p.instanceId}:${p.status}`);
      return last.length === names.length && last.every((row) => row.endsWith(":ready"));
    },
    timeoutMs,
    1000,
  );
  if (!ready) throw new Error(`providers never became ready: ${last.join(", ")}`);
}

/**
 * Signs each instance in as a person would from Settings > Providers: the
 * limit fallback only moves a thread to a source whose sign-in is confirmed.
 */
export async function signIn(server, names, timeoutMs = 60_000) {
  for (const instanceId of names)
    await rpc(server, "provider.auth.start", { instanceId, methodId: "chaos-sign-in" });
  let last = [];
  const done = await until(
    async () => {
      const config = await rpc(server, "server.getConfig", {});
      last = config.providers
        .filter((p) => names.includes(p.instanceId))
        .map((p) => `${p.instanceId}:${p.auth?.status}`);
      return last.length === names.length && last.every((row) => row.endsWith(":authenticated"));
    },
    timeoutMs,
    1000,
  );
  if (!done) throw new Error(`providers never signed in: ${last.join(", ")}`);
}

/** Seeded PRNG (mulberry32): the same seed gives the same fault schedule. */
export function prng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
  };
}
