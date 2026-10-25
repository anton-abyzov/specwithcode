import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Prepare a real, isolated app for the collaborative headless browser. No database
// access or provider inference. Keep it running until the browser check finishes.
assert.ok(process.versions.node.startsWith("22."), "Use Node 22");
assert.ok(process.argv[2], "Pass an absolute evidence directory");
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true, mode: 0o700 });
const state = mkdtempSync(join(out, "private-state-"));
mkdirSync(join(state, "userdata"));
writeFileSync(
  join(state, "userdata/settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(
      ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"].map((id) => [
        id,
        { enabled: false },
      ]),
    ),
    providerInstances: { codex: { driver: "codex", enabled: false, config: {} } },
  }),
  { mode: 0o600 },
);
const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => done(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const child = spawn(
  process.execPath,
  [
    join(root, "apps/server/dist/bin.mjs"),
    "serve",
    "--no-browser",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    state,
  ],
  {
    cwd: state,
    env: {
      ...process.env,
      STUDIO_DISABLE_AUTO_UPDATE: "true",
      PWDEBUG: "0",
      PLAYWRIGHT_HTML_OPEN: "never",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const stop = () => {
  if (child.exitCode === null) child.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.once("exit", stop);

try {
  const credential = await new Promise((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Candidate startup timed out")), 60000);
    const observe = (chunk) => {
      output += chunk.toString();
      const match = output.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Candidate exited ${code}`));
    });
  });
  const response = await fetch(`${origin}/api/auth/browser-session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  let sequence = 0;
  async function rpc(tag, payload) {
    const response = await fetch(`${origin}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie },
    });
    assert.equal(response.status, 200);
    const { ticket } = await response.json();
    const url = new URL("/ws", origin);
    url.protocol = "ws:";
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("orchestrationProtocol", "2");
    return new Promise((done, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`RPC timed out: ${tag}`));
      }, 30000);
      socket.onopen = () =>
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag,
            payload,
            headers: [],
          }),
        );
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`RPC transport failed: ${tag}`));
      };
      socket.onmessage = ({ data }) => {
        const values = JSON.parse(data);
        for (const item of Array.isArray(values) ? values : [values]) {
          if (item._tag !== "Exit" || String(item.requestId) !== "1") continue;
          clearTimeout(timer);
          socket.close();
          if (item.exit?._tag === "Success") done(item.exit.value);
          else reject(new Error(`RPC failed: ${tag} ${JSON.stringify(item.exit)}`));
        }
      };
    });
  }
  const projects = [];
  for (const [projectId, kind, title, prompt] of [
    ["aide-separation", "personal", "Aide", "AIDE_ONLY: Help me plan my afternoon."],
    [
      "code-separation",
      "code",
      "Project separation proof",
      "PROJECT_ONLY: Review the release checklist.",
    ],
  ]) {
    const workspaceRoot = join(state, projectId);
    mkdirSync(workspaceRoot);
    const commandId = () => `separation-${++sequence}`;
    await rpc("projects.mutate", {
      type: "project.create",
      commandId: commandId(),
      projectId,
      title,
      kind,
      origin: "automated",
      workspaceRoot,
      defaultModelSelection: { instanceId: "codex", model: "gpt-6" },
    });
    const workspace = await rpc("projects.workspaceRead", { projectId });
    await rpc("projects.mutate", {
      type: "project.update",
      commandId: commandId(),
      projectId,
      workspaceSettings: {
        expectedRevision: workspace.settings.revision,
        coordinatorModelSelection: { instanceId: "codex", model: "gpt-6" },
      },
    });
    await rpc("orchestration.dispatchCommand", {
      type: "thread.create",
      commandId: commandId(),
      threadId: `project-coordinator:${projectId}`,
      projectId,
      title: `${title} coordinator`,
      modelSelection: { instanceId: "codex", model: "gpt-6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const coordinator = await rpc("projects.coordinatorStart", {
      projectId,
      commandId: commandId(),
    });
    // Prepare the message without releasing a provider run.
    await rpc("orchestration.dispatchCommand", {
      type: "message.dispatch",
      commandId: commandId(),
      threadId: coordinator.threadId,
      messageId: `fixture-message:${projectId}`,
      text: prompt,
      attachments: [],
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
    projects.push({ projectId, threadId: coordinator.threadId, prompt });
  }
  writeFileSync(
    join(out, "fixture.json"),
    JSON.stringify(
      {
        origin,
        state,
        pid: child.pid,
        projects,
        providersDisabled: true,
      },
      null,
      2,
    ),
  );
  // The startup token was consumed by fixture setup. Mint a separate one for the browser.
  const pairing = JSON.parse(
    execFileSync(
      process.execPath,
      [join(root, "apps/server/dist/bin.mjs"), "pair", "--base-dir", state, "--json"],
      { encoding: "utf8" },
    ),
  );
  writeFileSync(join(out, "pairing-url.txt"), `${pairing.pairingUrl}\n`, {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({ ready: true, origin, pid: child.pid, fixture: join(out, "fixture.json") }),
  );
} catch (error) {
  stop();
  throw error;
}
