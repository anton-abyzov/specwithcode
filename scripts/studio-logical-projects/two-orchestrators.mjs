#!/usr/bin/env node
// Two real servers, one linked project, a coordinator on each machine, headless browser.
// Proves viewing is not moving, honest offline parity, refusal while offline, reconnect,
// a stale plan claim after a partition, memory conflicts, and pull requests from both.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

assert.equal(Number(process.versions.node.split(".")[0]), 22, "Use the project's Node 22 runtime");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(
  process.argv[2] ?? join(tmpdir(), `two-orchestrators-proof-${randomUUID()}`),
);
mkdirSync(output, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(tmpdir(), "two-orchestrators-servers-"));
const entrypoint = join(root, "apps/server/dist/bin.mjs");
const agent = join(root, "scripts/studio-logical-projects/link-launch-agent.mjs");
const receipt = {
  source: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  evidenceKind: "two-real-isolated-servers-one-linked-project",
  builtEntrypointSha256: createHash("sha256").update(readFileSync(entrypoint)).digest("hex"),
  browser: { headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never" },
  checks: [],
  screenshots: [],
  success: false,
};
const save = () =>
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
const check = (text) => {
  receipt.checks.push(text);
  console.log(`ok - ${text}`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const port = () =>
  new Promise((done, reject) => {
    const server = createServer();
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
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 5000);
  await exited;
  clearTimeout(timer);
}
async function start(host) {
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
    {
      cwd: host.dir,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
        LANG: "en_US.UTF-8",
        STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
        STUDIO_DISABLE_AUTO_UPDATE: "true",
        PWDEBUG: "0",
        PLAYWRIGHT_HTML_OPEN: "never",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  host.child = child;
  const credential = await new Promise((done, reject) => {
    let buffer = "",
      settled = false;
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
      buffer = (buffer + chunk).slice(-65536);
      const token = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (token) finish(done, token[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", () => finish(reject, new Error(`${host.label} exited during startup`)));
  });
  const response = await fetch(host.origin + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: credential,
      subject_token_type: "urn:specweave-studio:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "Two orchestrators verifier",
    }),
  });
  assert.equal(response.status, 200, `${host.label} token exchange failed`);
  host.token = (await response.json()).access_token;
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
  assert.equal(response.status, 200, `${host.label} request failed: ${path}`);
  return response.json();
}
/** One RPC; resolves to the Exit so a refusal's typed error can be asserted. */
async function rpcExit(host, tag, payload) {
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
    }, 20000);
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${host.label} RPC transport failed: ${tag}`));
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
          done(value.exit);
        }
    });
  });
}
async function rpc(host, tag, payload) {
  const exit = await rpcExit(host, tag, payload);
  if (exit?._tag !== "Success")
    throw new Error(`${host.label} RPC rejected: ${tag} ${JSON.stringify(exit).slice(0, 1500)}`);
  return exit.value;
}
const dispatch = (host, command) =>
  rpc(host, "orchestration.dispatchCommand", { commandId: randomUUID(), ...command });
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
async function until(what, probe, timeout = 60000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(250);
  }
}

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
const ECHO = { instanceId: "fixtureEcho", model: "link-launch" };
const LOGICAL_ID = "logical-project-two-orchestrators";
const hosts = [];
let browser;
let page;
let stopped = false;

/** A real server with every provider off except a model-free echo agent. */
async function createHost(label) {
  const dir = join(scratch, label.replaceAll(" ", "-"));
  const data = join(dir, "data");
  const workspace = join(dir, "easychamp");
  mkdirSync(join(data, "userdata"), { recursive: true });
  mkdirSync(workspace);
  writeFileSync(join(workspace, "README.md"), "Synthetic two-orchestrator verification only.\n");
  const echoFile = join(dir, "echo.json");
  writeFileSync(
    join(data, "userdata/settings.json"),
    JSON.stringify({
      providers: Object.fromEntries(DRIVERS.map((driver) => [driver, { enabled: false }])),
      providerInstances: {
        ...Object.fromEntries(
          DRIVERS.map((driver) => [driver, { driver, enabled: false, config: {} }]),
        ),
        fixtureEcho: {
          driver: "acpRegistry",
          displayName: "Echo agent",
          enabled: true,
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: [agent, "--echo", echoFile],
            customModels: ["link-launch"],
          },
        },
      },
      cursorKeychainUsageEnabled: false,
    }),
  );
  const host = {
    label,
    short: label.split(" ")[0],
    dir,
    data,
    workspace,
    echoFile,
    port: await port(),
    environmentId: randomUUID(),
    projectId: randomUUID(),
  };
  host.origin = `http://127.0.0.1:${host.port}`;
  host.coordinatorThreadId = `project-coordinator:${host.projectId}`;
  host.workerThreadId = `${host.short.toLowerCase()}-worker`;
  writeFileSync(join(data, "userdata/environment-id"), host.environmentId);
  hosts.push(host);
  await start(host);
  // A machine names itself from its OS (ComputerName); remote machines use their saved label.
  host.selfLabel = (
    await (await fetch(host.origin + "/.well-known/studio/environment")).json()
  ).label;
  const config = await rpc(host, "server.getConfig", {});
  assert.ok(
    config.providers.every(
      (provider) => provider.enabled === false || provider.instanceId === "fixtureEcho",
    ),
    "Only the model-free echo agent is enabled",
  );
  await request(host, "/api/projects/mutate", {
    type: "project.create",
    commandId: randomUUID(),
    projectId: host.projectId,
    title: "EasyChamp",
    workspaceRoot: workspace,
  });
  for (const [threadId, title] of [
    [host.coordinatorThreadId, `${label} coordinator`],
    [host.workerThreadId, `${label} worker`],
  ])
    await dispatch(host, {
      type: "thread.create",
      threadId,
      projectId: host.projectId,
      title,
      modelSelection: ECHO,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  return host;
}

/** Synthetic completed history, so each coordinator has a conversation to show. */
function seedHistory(db, threadId, text) {
  const at = "2026-10-20T12:00:00.000Z";
  const runId = randomUUID();
  const messageId = randomUUID();
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: ECHO.instanceId,
    modelSelection: ECHO,
    providerThreadId: null,
    userMessageId: messageId,
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    checkpointId: null,
    contextHandoffId: null,
  };
  const message = {
    id: messageId,
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdBy: "user",
    creationSource: "web",
    createdAt: at,
    updatedAt: at,
  };
  const item = {
    id: randomUUID(),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "Synthetic history",
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "user_message",
    messageId,
    inputIntent: "turn_start",
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  };
  db.prepare(
    "INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,completed_at,payload_json) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    runId,
    threadId,
    1,
    "acpRegistry",
    ECHO.instanceId,
    "completed",
    at,
    at,
    JSON.stringify(run),
  );
  db.prepare(
    "INSERT INTO orchestration_v2_projection_messages (message_id,thread_id,run_id,role,streaming,created_at,updated_at,payload_json) VALUES (?,?,?,?,?,?,?,?)",
  ).run(messageId, threadId, runId, "user", 0, at, at, JSON.stringify(message));
  db.prepare(
    "INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES (?,?,?,?,?,?,?,?)",
  ).run(item.id, threadId, runId, 1, "user_message", "completed", at, JSON.stringify(item));
}

/** What each fixture database holds, read only after its server stopped. */
function readState(host) {
  const db = new DatabaseSync(join(host.data, "userdata/statev2.sqlite"), { readOnly: true });
  try {
    const settings = JSON.parse(
      db
        .prepare("SELECT workspace_settings_json FROM projection_projects WHERE project_id=?")
        .get(host.projectId).workspace_settings_json,
    );
    const threads = db
      .prepare("SELECT thread_id FROM orchestration_v2_projection_threads WHERE project_id=?")
      .all(host.projectId)
      .map((row) => row.thread_id)
      .sort();
    const userTexts = db
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? AND role='user'",
      )
      .all(host.coordinatorThreadId)
      .map((row) => JSON.parse(row.payload_json).text);
    return { settings, threads, userTexts };
  } finally {
    db.close();
  }
}

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require(process.env.STUDIO_TEST_PLAYWRIGHT_MODULE ?? "playwright");
  } catch (error) {
    if (process.env.STUDIO_TEST_PLAYWRIGHT_MODULE) throw error;
    return require(
      join(
        homedir(),
        ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
      ),
    );
  }
}

async function shot(name) {
  const path = join(output, name);
  await page.screenshot({ path });
  receipt.screenshots.push(path);
}

async function main() {
  const m4 = await createHost("M4 fixture");
  const minis = await createHost("Minis fixture");
  // Both machines are linked, and each runs its own active coordinator. A third
  // member was never synced to this browser: viewing it must say Unknown.
  const ghost = { environmentId: randomUUID(), projectId: randomUUID() };
  const members = [
    ...[m4, minis].map((host) => ({
      environmentId: host.environmentId,
      projectId: host.projectId,
      coordinatorThreadId: host.coordinatorThreadId,
    })),
    { ...ghost, coordinatorThreadId: `project-coordinator:${ghost.projectId}` },
  ];
  const logicalProject = {
    id: LOGICAL_ID,
    title: "EasyChamp",
    coordinatorId: "logical-coordinator-two",
    members,
  };
  for (const host of [m4, minis]) await stop(host);
  for (const host of [m4, minis]) {
    const db = new DatabaseSync(join(host.data, "userdata/statev2.sqlite"));
    const row = db
      .prepare("SELECT workspace_settings_json FROM projection_projects WHERE project_id=?")
      .get(host.projectId);
    const settings = {
      ...JSON.parse(row.workspace_settings_json),
      logicalProject,
      coordinatorThreadId: host.coordinatorThreadId,
      coordinatorBinding: { epoch: 0, state: "active" },
    };
    db.prepare("UPDATE projection_projects SET workspace_settings_json=? WHERE project_id=?").run(
      JSON.stringify(settings),
      host.projectId,
    );
    seedHistory(db, host.coordinatorThreadId, `${host.label} coordinator history`);
    db.close();
    await start(host);
  }
  const before = {};
  check(
    "Two isolated servers; one linked project; an active coordinator on each machine; providers off",
  );

  // Each machine's own thread links a pull request on the shared remote.
  for (const [host, number] of [
    [m4, 11],
    [minis, 12],
  ])
    await dispatch(host, {
      type: "thread.pull-request.link",
      threadId: host.workerThreadId,
      host: "github.com",
      repository: "example/easychamp",
      number,
      url: `https://github.com/example/easychamp/pull/${number}`,
      source: "manual",
    });

  // Plan: a Minis thread claims a task; the claim replicates to M4 before the partition.
  const minisPlan = await rpc(minis, "projects.planRead", { projectId: minis.projectId });
  const replaced = await rpc(minis, "projects.planReplace", {
    projectId: minis.projectId,
    expectedRevision: minisPlan.revision,
    actor: { kind: "user" },
    definition: {
      spec: "Two orchestrators fixture plan.",
      criteria: [{ id: "AC-1", text: "Claims bind on every machine." }],
      tasks: [{ id: "T-1", title: "Shared task", criterionIds: ["AC-1"], verification: null }],
    },
  });
  // Threads claim through their own MCP credential; the WebSocket plan RPCs always act as the user.
  const claimCall = {
    name: "studio_project_plan_claim",
    arguments: { expectedRevision: replaced.revision, taskId: "T-1" },
  };
  await dispatch(minis, {
    type: "message.dispatch",
    threadId: minis.workerThreadId,
    messageId: randomUUID(),
    text: `Claim the shared task.\nMCP-CALL ${JSON.stringify(claimCall)}`,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "start_immediately" },
  });
  const claimed = await until("the Minis worker's MCP claim", () => readJson(minis.echoFile)?.mcp);
  assert.equal(claimed.status, 200, JSON.stringify(claimed));
  assert.ok(!JSON.stringify(claimed.body).includes('"isError":true'), JSON.stringify(claimed.body));
  const planExport = await rpc(minis, "projectLink.planExport", { projectId: minis.projectId });
  await rpc(m4, "projectLink.planMerge", {
    projectId: m4.projectId,
    peer: { environmentId: minis.environmentId, projectId: minis.projectId, label: minis.label },
    export: planExport,
  });
  const m4Plan = await rpc(m4, "projects.planRead", { projectId: m4.projectId });
  const replicatedOwner = m4Plan.native?.tasks?.find((task) => task.id === "T-1")?.owner;
  assert.equal(replicatedOwner?.threadId, minis.workerThreadId, JSON.stringify(m4Plan.native));
  check("A Minis thread's plan claim replicated to M4 with its machine");

  // Memory: one note edited on both machines keeps both versions after the exchange.
  for (const host of [m4, minis])
    await rpc(host, "projects.memoryWrite", {
      projectId: host.projectId,
      name: "notes.md",
      content: `${host.label} notes`,
      expectedRevision: null,
    });
  const [m4Memory, minisMemory] = await Promise.all(
    [m4, minis].map((host) => rpc(host, "projectLink.memoryExport", { projectId: host.projectId })),
  );
  const merges = [];
  for (const [host, peer, exported] of [
    [m4, minis, minisMemory],
    [minis, m4, m4Memory],
  ])
    merges.push({
      host,
      result: await rpc(host, "projectLink.memoryMerge", {
        projectId: host.projectId,
        peer: { environmentId: peer.environmentId, projectId: peer.projectId, label: peer.label },
        export: exported,
      }),
    });
  const conflicted = merges.filter((merge) => merge.result.conflicts.length > 0);
  assert.equal(
    conflicted.length,
    1,
    `One side records the concurrent edit: ${JSON.stringify(merges.map((m) => m.result))}`,
  );
  const { host: copyHost, result } = conflicted[0];
  const contents = await Promise.all(
    ["notes.md", result.conflicts[0].copy].map(
      async (name) =>
        (await rpc(copyHost, "projects.memoryRead", { projectId: copyHost.projectId, name }))
          .content,
    ),
  );
  assert.deepEqual(contents.toSorted(), ["M4 fixture notes", "Minis fixture notes"]);
  check(
    `Concurrent memory edits keep both versions (${copyHost.short} holds ${result.conflicts[0].copy})`,
  );

  // ── Browser: M4's page, with Minis in this device's saved machines ──
  const { chromium } = loadPlaywright();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1050 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  const pairing = await request(m4, "/api/auth/pairing-token", {
    label: "Two orchestrators browser",
  });
  const authenticated = await context.request.post(m4.origin + "/api/auth/browser-session", {
    headers: { Origin: m4.origin },
    data: { credential: pairing.credential },
  });
  assert.equal(authenticated.status(), 200, "Browser authentication failed");
  page = await context.newPage();
  await page.route(`${m4.origin}/__two-orchestrators`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Verifier</title>" }),
  );
  await page.goto(`${m4.origin}/__two-orchestrators`);
  await page.evaluate(
    async ({ remote }) => {
      localStorage.setItem(
        "studio:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: new Date().toISOString() }),
      );
      const connectionId = `fixture-${remote.environmentId}`;
      const document = {
        schemaVersion: 1,
        targets: [
          {
            _tag: "BearerConnectionTarget",
            environmentId: remote.environmentId,
            label: remote.label,
            connectionId,
          },
        ],
        profiles: [
          {
            _tag: "BearerConnectionProfile",
            environmentId: remote.environmentId,
            label: remote.label,
            connectionId,
            httpBaseUrl: remote.origin,
            wsBaseUrl: remote.origin.replace("http:", "ws:"),
          },
        ],
        credentials: [
          { connectionId, credential: { _tag: "BearerConnectionCredential", token: remote.token } },
        ],
        remoteDpopTokens: [],
        disabledEnvironmentIds: [],
      };
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
      remote: {
        label: minis.label,
        environmentId: minis.environmentId,
        origin: minis.origin,
        token: minis.token,
      },
    },
  );
  const browserToken = minis.token;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${m4.origin}/projects/${encodeURIComponent(`logical-project:${LOGICAL_ID}`)}`);
  const region = page.getByRole("region", { name: "Project coordinator", exact: true });
  await region.waitFor({ timeout: 45000 });
  await region.getByText("M4 fixture coordinator history").waitFor({ timeout: 45000 });
  // Pages left for another view stay mounted under a hidden Activity; role locators skip them.
  const prompt = () => page.getByRole("textbox", { name: "Message the project" });
  const switcher = page.getByRole("button", { name: /Choose a machine to view/ });
  const view = async (key) => {
    await switcher.click();
    await page.locator(`[data-orchestrator-view="${key}"]`).click();
    await page.getByRole("menu").waitFor({ state: "hidden", timeout: 10000 });
  };
  const minisKey = `${minis.environmentId}:${minis.projectId}`;
  const m4Key = `${m4.environmentId}:${m4.projectId}`;
  await switcher.click();
  const menu = page.getByRole("menu");
  for (const text of [
    `View ${m4.selfLabel}'s orchestrator`,
    "View Minis fixture's orchestrator",
    "Move coordinator to Minis fixture…",
    "Migrate threads… (needs thread handoff)",
  ])
    await menu.getByText(text, { exact: false }).first().waitFor({ timeout: 15000 });
  await shot("01-switcher-three-actions.png");
  await page.keyboard.press("Escape");
  check("The switcher offers View, Move coordinator and Migrate threads as separate actions");

  // ── AC-10 / AC-11 online: viewing Minis reads Minis's server live ──
  await view(minisKey);
  await region.getByText("Minis fixture coordinator history").waitFor({ timeout: 45000 });
  assert.equal(await region.getByText("M4 fixture coordinator history").count(), 0);
  const liveText = `Live message typed on M4 for Minis ${randomUUID().slice(0, 8)}`;
  await prompt().fill(liveText);
  await page.getByRole("button", { name: "Send to coordinator" }).click();
  const echo = await until("Minis's coordinator to run the message", () => {
    const value = readJson(minis.echoFile);
    return value?.text?.includes(liveText) ? value : null;
  });
  assert.equal(readJson(m4.echoFile), null, "M4's coordinator ran nothing");
  await region.getByText(`Echo worker ran in ${echo.cwd}`).waitFor({ timeout: 45000 });
  assert.ok(echo.cwd?.startsWith(minis.dir), `The turn ran in Minis's checkout: ${echo.cwd}`);
  writeFileSync(join(output, "02-minis-echo.json"), JSON.stringify(echo, null, 2) + "\n");
  await shot("02-view-minis-live.png");
  check("Viewing Minis shows Minis's conversation; a message typed there ran on Minis, not M4");

  // ── AC-14: pull requests from both machines ──
  await page.getByRole("tab", { name: /^PRs/ }).click();
  const prs = page.getByRole("tabpanel").filter({ visible: true });
  await prs.locator("[data-prs-across-machines]").waitFor({ timeout: 30000 });
  for (const number of [11, 12])
    await prs
      .getByText(`example/easychamp #${number}`, { exact: false })
      .first()
      .waitFor({ timeout: 30000 });
  await shot("03-pull-requests-both-machines.png");
  check("The PRs tab lists pull requests from both machines");

  // ── AC-11 / AC-15 offline: Minis goes down while viewed ──
  const m4RunsBefore = (
    await rpc(m4, "orchestration.getThreadProjection", { threadId: m4.coordinatorThreadId })
  ).runs.length;
  const lastSeen = Date.now();
  await stop(minis);
  const status = page.locator("[data-orchestrator-status]").filter({ visible: true });
  await status
    .filter({ hasText: "Minis fixture unreachable · last synced" })
    .waitFor({ timeout: 60000 });
  const statusText = (await status.textContent()) ?? "";
  assert.match(statusText, /last synced (just now|\d+ min ago) · read-only/, statusText);
  assert.ok(
    (await page
      .locator('.sws-host .sws-dot[data-tone="failed"]')
      .filter({ visible: true })
      .count()) > 0,
  );
  await region.getByText("Minis fixture coordinator history").waitFor({ timeout: 15000 });
  await region.getByText(liveText).first().waitFor({ timeout: 15000 });
  assert.equal(
    await region.getByText("M4 fixture coordinator history").count(),
    0,
    "No silent stand-in",
  );
  await page
    .getByText(
      "Minis fixture is unreachable, so its coordinator cannot take messages. Nothing is sent to another machine.",
      {
        exact: false,
      },
    )
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 30000 });
  const offlineText = `Offline message must not move ${randomUUID().slice(0, 8)}`;
  await prompt().fill(offlineText);
  assert.equal(await page.getByRole("button", { name: "Send to coordinator" }).isDisabled(), true);
  await prompt().press("Enter");
  await sleep(1500);
  await shot("04-minis-offline-last-synced.png");
  const m4Coordinator = await rpc(m4, "orchestration.getThreadProjection", {
    threadId: m4.coordinatorThreadId,
  });
  assert.equal(
    m4Coordinator.runs.length,
    m4RunsBefore,
    "Nothing typed for Minis started a run on M4",
  );
  receipt.offline = {
    statusText: statusText.trim(),
    lastSeenBefore: new Date(lastSeen).toISOString(),
  };
  check("Offline Minis shows its last synced conversation read-only, and refuses sends by name");

  // ── AC-15 stale claim after the partition, from M4's own orchestrator ──
  await view(m4Key);
  await region.getByText("M4 fixture coordinator history").waitFor({ timeout: 45000 });
  await page.getByRole("button", { name: "More project actions" }).click();
  await page.getByRole("menuitem", { name: "Plan" }).click();
  await page
    .getByText("Stale · Minis fixture unreachable · only you can release it", { exact: false })
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 30000 });
  await shot("05-stale-claim-after-partition.png");
  const m4Revision = (await rpc(m4, "projects.planRead", { projectId: m4.projectId })).revision;
  const refused = await rpcExit(m4, "projects.planClaim", {
    projectId: m4.projectId,
    expectedRevision: m4Revision,
    actor: { kind: "thread", threadId: m4.workerThreadId, environmentId: m4.environmentId },
    taskId: "T-1",
  });
  const refusal = JSON.stringify(refused);
  assert.notEqual(refused?._tag, "Success", "An M4 thread cannot take a Minis claim");
  assert.ok(refusal.includes('"claimed"') && refusal.includes("Minis fixture"), refusal);
  await rpc(m4, "projects.planRelease", {
    projectId: m4.projectId,
    expectedRevision: m4Revision,
    actor: { kind: "user" },
    taskId: "T-1",
    expectedOwner: replicatedOwner,
  });
  await page.keyboard.press("Escape");
  check(
    "A Minis claim shows Stale while Minis is down; M4 threads are refused; only the user releases it",
  );

  // ── AC-11 Unknown: a linked machine this device never synced ──
  await view(`${ghost.environmentId}:${ghost.projectId}`);
  const unknownPage = page.locator("[data-orchestrator-unknown]").filter({ visible: true });
  await unknownPage.waitFor({ timeout: 30000 });
  await unknownPage.getByText("orchestrator: Unknown", { exact: false }).first().waitFor();
  await shot("06-never-synced-unknown.png");
  await page.getByRole("button", { name: `View ${m4.selfLabel}'s orchestrator` }).click();
  await region.getByText("M4 fixture coordinator history").waitFor({ timeout: 45000 });
  check("A linked machine never synced reads Unknown, never an empty list or a stand-in");

  // ── AC-15 reconnect: Minis returns on the same port and data ──
  await start(minis);
  const ticket = await fetch(minis.origin + "/api/auth/websocket-ticket", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: minis.origin,
      Authorization: `Bearer ${browserToken}`,
    },
  });
  receipt.browserTokenAfterRestart = ticket.status;
  await view(minisKey);
  await page
    .locator('.sws-host .sws-dot[data-tone="resolved"]')
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 90000 });
  await until("the offline status to clear", async () => (await status.count()) === 0, 60000);
  await region.getByText(`Echo worker ran in ${echo.cwd}`).waitFor({ timeout: 45000 });
  const composerOpen = await until(
    "the composer to accept messages again",
    async () => {
      await prompt().fill("ready check");
      return !(await page.getByRole("button", { name: "Send to coordinator" }).isDisabled());
    },
    60000,
  );
  assert.ok(composerOpen);
  await prompt().fill("");
  await shot("07-minis-reconnected-live.png");
  check("Minis reconnects to a live view; the composer accepts messages again");

  assert.deepEqual(errors, [], `Page errors: ${errors.join("\n")}`);
  await browser.close();
  browser = undefined;
  for (const host of [m4, minis]) await stop(host);

  // ── Nothing moved: bindings, thread ownership and coordinator transcripts ──
  const [m4State, minisState] = [m4, minis].map(readState);
  for (const [host, state] of [
    [m4, m4State],
    [minis, minisState],
  ]) {
    assert.deepEqual(
      state.settings.coordinatorBinding,
      { epoch: 0, state: "active" },
      `${host.label} binding`,
    );
    assert.equal(state.settings.coordinatorThreadId, host.coordinatorThreadId);
    assert.deepEqual(
      state.settings.logicalProject.members.map((member) => member.environmentId),
      members.map((member) => member.environmentId),
    );
    assert.deepEqual(
      state.threads,
      [host.coordinatorThreadId, host.workerThreadId].sort(),
      `${host.label} threads`,
    );
    assert.ok(
      !state.userTexts.includes(offlineText),
      `${host.label} never got the offline message`,
    );
  }
  assert.deepEqual(m4State.userTexts, ["M4 fixture coordinator history"]);
  assert.ok(minisState.userTexts.includes(liveText), "Minis's coordinator holds the message");
  check("Viewing moved nothing: both bindings active at epoch 0, threads stayed on their machines");
  Object.assign(before, {
    m4: m4State.settings.coordinatorBinding,
    minis: minisState.settings.coordinatorBinding,
  });
  receipt.bindings = before;
  stopped = true;
  receipt.success = true;
}

try {
  await main();
} catch (error) {
  receipt.error = String(error?.stack ?? error).slice(0, 4000);
  if (page) await shot("failure.png").catch(() => undefined);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  for (const host of hosts) await stop(host).catch(() => undefined);
  stopped = hosts.every(
    (host) => !host.child || host.child.exitCode !== null || host.child.signalCode !== null,
  );
  save();
  if (stopped && existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
  console.log(receipt.success ? `PASS ${join(output, "receipt.json")}` : `FAIL ${receipt.error}`);
}
