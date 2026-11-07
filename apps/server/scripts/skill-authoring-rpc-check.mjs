// Built-server regression: independent WebSocket clients share authoring revision locks.
// Uses a new private fixture home, disabled providers and local RPC only.
// Never opens the database, publishes a skill or starts a provider turn.
// Run with Node 22 after building the server. STUDIO_SERVER_ENTRYPOINT can override the build.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as NodeURL from "node:url";

const HERE = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const ENTRYPOINT = NodePath.resolve(
  process.env.STUDIO_SERVER_ENTRYPOINT || NodePath.join(HERE, "../dist/bin.mjs"),
);
const PROVIDERS = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const server = NodeNet.createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  await new Promise((done) => server.close(done));
  return port;
}

function environmentFor(home) {
  const user = NodePath.join(home, "user-home");
  NodeFS.mkdirSync(user, { recursive: true });
  return {
    HOME: user,
    USER: process.env.USER ?? "fixture",
    LANG: "en_US.UTF-8",
    PATH: "/usr/bin:/bin",
    STUDIO_HOME: home,
    STUDIO_LOG_LEVEL: "Debug",
    STUDIO_ENABLE_HOSTED_SERVICES: "false",
    STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
  };
}

async function start(home) {
  NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true });
  const settings = NodePath.join(home, "userdata/settings.json");
  try {
    NodeFS.readFileSync(settings);
  } catch {
    NodeFS.writeFileSync(
      settings,
      JSON.stringify({
        providers: Object.fromEntries(PROVIDERS.map((driver) => [driver, { enabled: false }])),
      }),
      { mode: 0o600 },
    );
  }
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = environmentFor(home);
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      ENTRYPOINT,
      "start",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      home,
      "--mode",
      "web",
      "--no-browser",
    ],
    { cwd: home, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  for (let attempt = 0; attempt < 1200; attempt += 1) {
    if (child.exitCode !== null)
      throw new Error(`server exited during startup (${child.exitCode}): ${stderr}`);
    // Ready once the local CLI session it publishes at startup is accepted (the web root
    // answers 503 without a built web app).
    try {
      const token = NodeFS.readFileSync(
        NodePath.join(home, "userdata/secrets/local-cli-credential.bin"),
        "utf8",
      ).trim();
      const answer = await fetch(origin + "/api/auth/websocket-ticket", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
        signal: AbortSignal.timeout(1000),
      });
      if (answer.status === 200) return { home, origin, env, child, token, stderr: () => stderr };
    } catch {}
    await delay(100);
  }
  child.kill("SIGTERM");
  throw new Error("server did not become ready in 120 s");
}

async function stop(server) {
  if (server.child.exitCode !== null) return;
  const exited = new Promise((done) => server.child.once("exit", done));
  server.child.kill("SIGTERM");
  const timer = setTimeout(() => server.child.kill("SIGKILL"), 30_000);
  await exited;
  clearTimeout(timer);
}

/** One RPC over the server's WebSocket with the local CLI session: {ok, value} or {ok: false, error}. */
async function rpc(server, tag, payload) {
  const issued = await fetch(server.origin + "/api/auth/websocket-ticket", {
    method: "POST",
    headers: { authorization: "Bearer " + server.token },
  });
  if (issued.status !== 200) throw new Error(`websocket ticket refused: HTTP ${issued.status}`);
  const { ticket } = await issued.json();
  const url = new URL(server.origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  const ws = new WebSocket(url);
  try {
    return await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`${tag} timed out`)), 30_000);
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`${tag} transport failed`));
      });
      ws.addEventListener("open", () =>
        ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
      );
      ws.addEventListener("message", (event) => {
        let items;
        try {
          const value = JSON.parse(event.data);
          items = Array.isArray(value) ? value : [value];
        } catch {
          return;
        }
        for (const item of items) {
          if (item._tag !== "Exit" || item.requestId !== "1") continue;
          clearTimeout(timer);
          if (item.exit._tag === "Success") done({ ok: true, value: item.exit.value });
          else {
            const cause = (item.exit.cause ?? []).find((part) => part._tag === "Fail");
            done({ ok: false, error: cause?.error ?? { _tag: "Defect" } });
          }
        }
      });
    });
  } finally {
    ws.close();
  }
}

async function must(server, tag, payload) {
  const answer = await rpc(server, tag, payload);
  if (!answer.ok) throw new Error(`${tag} failed: ${JSON.stringify(answer.error)}`);
  return answer.value;
}

const home = NodeFS.mkdtempSync("/tmp/1209-rpc-lifetime-");
const server = await start(home);
try {
  console.log("google", JSON.stringify(await rpc(server, "googleAccount.status", {})));
  const folder = NodePath.join(home, "project");
  NodeFS.mkdirSync(folder);
  const added = NodeChildProcess.spawnSync(
    process.execPath,
    [ENTRYPOINT, "project", "add", folder, "--base-dir", home],
    { env: server.env, encoding: "utf8", timeout: 60000 },
  );
  if (added.status !== 0) throw new Error("fixture project add failed");
  const projectId = /Added project (\S+)/.exec(added.stdout)?.[1];
  if (!projectId) throw new Error("missing fixture project id");
  const target = { projectId, cwd: folder };
  const draft = {
    name: "fixture",
    description: "test",
    instructions: "original",
    version: "1.0.0",
    prompt: "test",
  };
  const first = await must(server, "projects.skillAuthoring", {
    ...target,
    operation: "save",
    draft,
  });
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      rpc(server, "projects.skillAuthoring", {
        ...target,
        operation: "save",
        revision: first.draft.revision,
        draft: { ...draft, instructions: `writer ${i}` },
      }),
    ),
  );
  const wins = results.filter((r) => r.ok);
  const stale = results.filter((r) => !r.ok && r.error?.reason === "stale");
  if (wins.length !== 1 || stale.length !== 19)
    throw new Error(JSON.stringify({ wins: wins.length, stale: stale.length, results }));
  const read = await must(server, "projects.skillAuthoring", { ...target, operation: "read" });
  if (read.draft.instructions !== wins[0].value.draft.instructions)
    throw new Error("winning edit lost");
  console.log(
    JSON.stringify({
      separateConnections: 20,
      winners: wins.length,
      stale: stale.length,
      revision: read.draft.revision,
    }),
  );
} finally {
  await stop(server);
}
