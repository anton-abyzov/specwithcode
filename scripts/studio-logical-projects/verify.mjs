#!/usr/bin/env node
// Three isolated real servers, synthetic history, disabled providers, headless browser.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { openLiveDatabaseReadOnly } from "../lib/live-database.mjs";

assert.equal(Number(process.versions.node.split(".")[0]), 22, "Use the project's Node 22 runtime");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? join(tmpdir(), `logical-project-proof-${randomUUID()}`));
mkdirSync(output, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(tmpdir(), "logical-project-servers-"));
const entrypoint = join(root, "apps/server/dist/bin.mjs");
const hosts = [];
const receipt = {
  source: execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  evidenceKind: "three-real-isolated-servers-with-synthetic-history",
  builtEntrypointSha256: createHash("sha256").update(readFileSync(entrypoint)).digest("hex"),
  browser: { headless: true, PWDEBUG: "0", PLAYWRIGHT_HTML_OPEN: "never", reporterOpen: "never" },
  providerTurns: 0,
  checks: [],
  screenshots: [],
  success: false,
};
const save = () =>
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
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
        ...host.extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  host.child = child;
  return new Promise((done, reject) => {
    let buffer = "",
      settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      buffer = "";
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error("Isolated server startup timeout")),
      45000,
    );
    const inspect = (chunk) => {
      if (settled) return;
      buffer = (buffer + chunk).slice(-65536);
      const token = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (token) finish(done, token[1]);
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", () => finish(reject, new Error("Isolated server exited during startup")));
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
  assert.equal(response.status, 200, `Isolated request failed: ${path}`);
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
      reject(new Error(`Isolated RPC timeout: ${tag}`));
    }, 20000);
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Isolated RPC transport failed"));
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
          value.exit?._tag === "Success"
            ? done(value.exit.value)
            : reject(new Error(`Isolated RPC rejected: ${tag}`));
        }
    });
  });
}
async function mintWorkerGrant(worker, coordinator) {
  // The same loopback OAuth steps a coordinator's Allow workers drives on a machine.
  const clientName = `SpecWithCode workers · ${coordinator.environmentId}`;
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
  assert.ok([200, 201].includes(registered.status), "Worker client registration failed");
  const clientId = (await registered.json()).client_id;
  const verifier = randomBytes(48).toString("base64url");
  const decision = await fetch(worker.origin + "/oauth/mcp/decision", {
    method: "POST",
    headers: json,
    body: JSON.stringify({
      authorization: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: randomUUID(),
        resource,
      },
      decision: { _tag: "pairing-code", access: "full-access", code: pairing.credential },
    }),
  });
  assert.equal(decision.status, 200, "Worker grant approval failed");
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
  assert.equal(token.status, 200, "Worker grant token exchange failed");
  return (await token.json()).access_token;
}
/** One MCP tool call with a worker grant, as a coordinator's machine makes it. */
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
      clientInfo: { name: "work-grant-verifier", version: "1" },
    },
  });
  if (initialized.status !== 200) return { status: initialized.status, body: null };
  const session = initialized.headers.get("mcp-session-id");
  await read(initialized);
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
  const called = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    session,
  );
  return { status: called.status, body: await read(called) };
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
      client_label: "Owned logical project verifier",
    }),
  });
  assert.equal(response.status, 200, "Owned token exchange failed");
  host.token = (await response.json()).access_token;
}
/**
 * 0951: work another machine starts here stays inside the grant this machine
 * gave it. M1 is the worker; M4 the coordinator; M3 an earlier hop.
 */
async function verifyWorkGrants() {
  const [m4, m1, m3] = hosts;
  const worker = await mintWorkerGrant(m1, m4);
  const grants = () => request(m1, "/api/studio/fleet/work-grants", undefined, "GET");
  const grantOf = async () =>
    (await grants()).grants.find((grant) => grant.coordinatorEnvironmentId === m4.environmentId);
  const change = (action, input = {}) =>
    request(m1, `/api/studio/fleet/work-grants/${action}`, {
      coordinatorEnvironmentId: m4.environmentId,
      ...input,
    });
  let grant = await grantOf();
  assert.deepEqual(
    {
      projects: grant.projects,
      accounts: grant.accounts,
      owner: grant.owner,
      hopLimit: grant.hopLimit,
      legacy: grant.legacy,
      status: grant.status,
    },
    {
      projects: { kind: "linked" },
      accounts: { kind: "all" },
      owner: "self",
      hopLimit: 2,
      legacy: false,
      status: "active",
    },
    "A new grant from the owner's own machine covers linked projects and all sign-ins",
  );
  receipt.checks.push("New worker grant: linked projects, all sign-ins, two hops, not legacy");
  const launch = (projectId, delegation, instanceId = "codex") =>
    mcpCall(m1, worker, "studio_thread_launch", {
      projectId,
      title: "Synthetic remote launch",
      message: "Synthetic verification only.",
      modelSelection: { instanceId, model: "synthetic-unavailable" },
      ...(delegation ? { delegation } : {}),
    });
  const refused = (result, code, what) => {
    assert.equal(result.status, 200, `${what}: MCP call failed`);
    assert.ok(JSON.stringify(result.body).includes(code), `${what}: expected ${code}`);
  };
  // M1 started work on M4, which now tries to start work back on M1.
  refused(
    await launch(m1.projectId, { path: [m1.environmentId, m4.environmentId], hops: 2 }),
    "delegation_cycle",
    "A to B to A",
  );
  receipt.checks.push("A to B to A launch refused on the worker as delegation_cycle");
  const unlinked = randomUUID();
  const unlinkedRoot = join(m1.dir, "unlinked");
  mkdirSync(unlinkedRoot);
  await request(m1, "/api/projects/mutate", {
    type: "project.create",
    commandId: randomUUID(),
    projectId: unlinked,
    title: "Unlinked private project",
    workspaceRoot: unlinkedRoot,
  });
  refused(await launch(unlinked), "outside_grant_scope", "Unlinked project");
  const listed = await mcpCall(m1, worker, "studio_project_list", {});
  assert.ok(!JSON.stringify(listed.body).includes(unlinked), "Unlinked project stays hidden");
  receipt.checks.push("Launch into a project not linked to the coordinator refused and hidden");
  await change("update", { accounts: { kind: "listed", instanceIds: ["claudeAgent"] } });
  refused(await launch(m1.projectId), "account_not_allowed", "Sign-in outside the grant");
  receipt.checks.push("Launch with a sign-in outside the account policy refused");
  await change("update", { owner: "other" });
  grant = await grantOf();
  assert.equal(grant.hopLimit, 1);
  refused(
    await launch(m1.projectId, { path: [m3.environmentId, m4.environmentId], hops: 2 }),
    "delegation_limit",
    "Two hops from another person's machine",
  );
  receipt.checks.push("Another person's machine: hop limit 1, two-hop launch refused");
  await change("update", {
    owner: "self",
    accounts: { kind: "listed", instanceIds: ["claudeAgent", "codex"] },
  });
  // The worker's own Settings > Connections, headless.
  const workerBrowser = await browser.newContext({
    viewport: { width: 1400, height: 1400 },
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  // Reading and changing grants needs access:read and access:write.
  const pairing = await request(m1, "/api/auth/pairing-token", {
    label: "Owned verifier browser",
    scopes: ["orchestration:read", "settings:write", "access:read", "access:write"],
  });
  const signedIn = await workerBrowser.request.post(m1.origin + "/api/auth/browser-session", {
    headers: { Origin: m1.origin },
    data: { credential: pairing.credential },
  });
  assert.equal(signedIn.status(), 200, "Worker browser authentication failed");
  const settings = await workerBrowser.newPage();
  // The innermost section under that heading.
  const workGrantsSection = () =>
    settings
      .locator("section")
      .filter({
        has: settings.getByRole("heading", { name: "Who can run work on this Mac", exact: true }),
      })
      .last();
  const shoot = async (file) => {
    const section = workGrantsSection();
    await section.scrollIntoViewIfNeeded();
    await section.screenshot({ path: join(output, file), animations: "disabled" });
    writeFileSync(join(output, file.replace(".png", ".txt")), await section.innerText());
    receipt.screenshots.push(file);
  };
  await settings.goto(`${m1.origin}/settings/machines`);
  try {
    await workGrantsSection().getByText(m4.environmentId).first().waitFor({ timeout: 45000 });
  } catch (error) {
    await settings.screenshot({
      path: join(output, "failure-worker-settings.png"),
      fullPage: true,
    });
    writeFileSync(
      join(output, "failure-worker-settings.txt"),
      await settings.locator("body").innerText(),
    );
    throw error;
  }
  await shoot("03-who-can-run-work.png");
  receipt.checks.push("Who can run work on this Mac lists the coordinator, scope and sign-ins");
  const revokedAt = Date.now();
  await change("revoke");
  grant = await grantOf();
  assert.equal(grant.status, "revoked");
  assert.equal(Date.parse(grant.interruptAt) - Date.parse(grant.revokedAt), 120000);
  assert.ok(Date.parse(grant.revokedAt) >= revokedAt - 1000);
  assert.equal((await mcpCall(m1, worker, "studio_project_list", {})).status, 401);
  receipt.checks.push(
    "Revoke refuses the worker grant at once; running work stops after 2 minutes",
  );
  await settings.reload();
  await workGrantsSection()
    .getByRole("button", { name: "Allow again" })
    .waitFor({ timeout: 45000 });
  await shoot("04-revoked.png");
  await change("restore");
  assert.equal((await mcpCall(m1, worker, "studio_project_list", {})).status, 401);
  const renewed = await mintWorkerGrant(m1, m4);
  assert.equal((await mcpCall(m1, renewed, "studio_project_list", {})).status, 200);
  receipt.checks.push(
    "Restore needs a fresh grant from the coordinator; the revoked one stays dead",
  );
  await workerBrowser.close();
}
/**
 * 0951 AC-05/AC-06: M3's copy keeps a replica of M1's coordinator notes; with M1 stopped,
 * Take over coordinator here makes M3 the coordinator from that replica, and the restarted
 * M1 gives way and lists the coordinator turn it ran meanwhile.
 */
async function verifyTakeover() {
  const [primary, owner, member] = hosts;
  const until = async (check, what, timeout = 120000) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      if (await check()) return;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((done) => setTimeout(done, 1000));
    }
  };
  for (const host of [owner, member]) {
    host.takeoverFolder = join(host.dir, "takeover-fixture");
    mkdirSync(host.takeoverFolder);
    writeFileSync(join(host.takeoverFolder, "README.md"), "Synthetic takeover fixture.\n");
    const git = (...args) =>
      execFileSync("/usr/bin/git", args, {
        cwd: host.takeoverFolder,
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "https://github.com/example/takeover-fixture.git");
    host.takeoverProjectId = randomUUID();
    await request(host, "/api/projects/mutate", {
      type: "project.create",
      commandId: randomUUID(),
      projectId: host.takeoverProjectId,
      title: "Takeover fixture",
      workspaceRoot: host.takeoverFolder,
    });
    await rpc(host, "projects.memoryWrite", {
      projectId: host.takeoverProjectId,
      name: "plan.md",
      content: host === owner ? "M1 coordinator plan" : "M3 own plan",
      expectedRevision: null,
    });
  }
  const preview = (host) => rpc(host, "projectLink.preview", { projectId: host.takeoverProjectId });
  const [ownerView, memberView] = await Promise.all([preview(owner), preview(member)]);
  // The coordinator thread exists so a turn it runs while cut off can be listed.
  await rpc(owner, "orchestration.dispatchCommand", {
    type: "thread.create",
    commandId: randomUUID(),
    threadId: ownerView.member.coordinatorThreadId,
    projectId: owner.takeoverProjectId,
    title: "Takeover fixture coordinator",
    modelSelection: { instanceId: "codex", model: "synthetic-unavailable" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const linkId = randomUUID();
  const prepared = await rpc(owner, "projectLink.prepare", {
    operationId: linkId,
    projectId: owner.takeoverProjectId,
    joining: memberView.member,
  });
  const accepted = await rpc(member, "projectLink.accept", {
    operationId: linkId,
    projectId: member.takeoverProjectId,
    kept: prepared.kept,
    logicalProject: prepared.logicalProject,
    coordinatorBinding: prepared.coordinatorBinding,
    keptFingerprint: prepared.fingerprint,
  });
  await rpc(owner, "projectLink.commit", {
    operationId: linkId,
    projectId: owner.takeoverProjectId,
    joining: accepted.member,
    notes: [],
  });
  const logicalId = prepared.logicalProject.id;
  const digest = (host) => rpc(host, "projectLink.digest", { projectId: host.takeoverProjectId });
  const replicated = async () =>
    (await digest(member)).replica?.digest === (await digest(owner)).digest;
  // The open page keeps the replica: at once after the link, then on its 60 s pass.
  await until(replicated, "the first replica on M3");
  await rpc(owner, "projects.memoryWrite", {
    projectId: owner.takeoverProjectId,
    name: "plan.md",
    content: "M1 coordinator plan, revised",
    expectedRevision: ownerView.notes.find((note) => note.name === "plan.md")?.revision ?? 1,
  });
  await until(replicated, "the replica to follow M1's note change", 150000);
  receipt.checks.push(
    "The open app keeps a member replica of the coordinator's notes, goal and instructions: on link and after a coordinator note change (digests match)",
  );

  await stop(owner);
  const settingsUrl = `${primary.origin}/settings/projects?project=${encodeURIComponent(`logical-project:${logicalId}`)}`;
  await page.goto(settingsUrl);
  await page
    .getByText(/is unreachable\. This copy can take over the coordinator in \d+ min/)
    .waitFor({ timeout: 60000 });
  const takeOverButton = page.getByRole("button", {
    name: "Take over coordinator here",
    exact: true,
  });
  assert.equal(await takeOverButton.isDisabled(), true, "No takeover before 10 minutes");
  await page.screenshot({ path: join(output, "08-takeover-wait.png"), animations: "disabled" });
  receipt.screenshots.push("08-takeover-wait.png");
  // Ten minutes pass: this device last saw M1 eleven minutes ago.
  await page.evaluate((environmentId) => {
    const key = "specwithcode:machine-last-seen";
    const seen = JSON.parse(localStorage.getItem(key) ?? "{}");
    seen[environmentId] = Date.now() - 11 * 60000;
    localStorage.setItem(key, JSON.stringify(seen));
  }, owner.environmentId);
  await page.reload();
  await page.getByText(/has been unreachable for 10 minutes or more/).waitFor({ timeout: 60000 });
  await takeOverButton.click();
  const confirm = page.getByRole("dialog");
  await confirm.getByText(`Take over the coordinator on ${member.label}?`).waitFor();
  // Let the dialog finish opening before the screenshot.
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(output, "09-takeover-confirm.png"), animations: "disabled" });
  receipt.screenshots.push("09-takeover-confirm.png");
  await confirm.getByRole("button", { name: "Take over", exact: true }).click();
  await page.getByText(`${member.label} now coordinates this project.`).waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(output, "10-taken-over.png"), animations: "disabled" });
  receipt.screenshots.push("10-taken-over.png");
  const took = await preview(member);
  assert.equal(took.coordinatorBinding.state, "active");
  assert.equal(took.coordinatorBinding.epoch, 1);
  assert.deepEqual(took.coordinatorBinding.predecessor, ownerView.member);
  assert.ok(took.coordinatorBinding.takenOverAt, "The takeover is stamped");
  assert.deepEqual(
    took.notes.map((note) => [note.name, note.content]),
    [
      ["plan-before-takeover.md", "M3 own plan"],
      ["plan.md", "M1 coordinator plan, revised"],
    ],
  );
  receipt.checks.push(
    "With M1 stopped, Take over coordinator here stays off until 10 minutes, then one confirmation makes M3 active at epoch+1 with M1 as predecessor, starting from the replicated notes (its own differing note kept as plan-before-takeover.md)",
  );

  // While cut off, M1 still ran one coordinator turn (synthetic, no provider).
  const at = new Date().toISOString();
  const threadId = ownerView.member.coordinatorThreadId;
  const runId = randomUUID();
  const messageId = randomUUID();
  const db = new DatabaseSync(join(owner.data, "userdata/statev2.sqlite"));
  db.prepare(
    "INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,completed_at,payload_json) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    runId,
    threadId,
    1,
    "codex",
    "codex",
    "completed",
    at,
    at,
    JSON.stringify({
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "fixture-recorded-model" },
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
    }),
  );
  db.prepare(
    "INSERT INTO orchestration_v2_projection_messages (message_id,thread_id,run_id,role,streaming,created_at,updated_at,payload_json) VALUES (?,?,?,?,?,?,?,?)",
  ).run(
    messageId,
    threadId,
    runId,
    "user",
    0,
    at,
    at,
    JSON.stringify({
      id: messageId,
      threadId,
      runId,
      nodeId: null,
      role: "user",
      text: "Cut-off coordinator request on M1",
      attachments: [],
      streaming: false,
      createdBy: "user",
      creationSource: "web",
      createdAt: at,
      updatedAt: at,
    }),
  );
  db.close();
  // The page keeps M1's earlier bearer session, which the restart reads from M1's store.
  await exchange(owner, await start(owner));
  await until(async () => {
    const view = await preview(owner);
    return view.coordinatorBinding.state === "transferred";
  }, "M1 to give way once the app reaches it again");
  const gaveWay = await preview(owner);
  assert.equal(gaveWay.coordinatorBinding.epoch, 1);
  assert.deepEqual(gaveWay.coordinatorBinding.successor, took.member);
  assert.deepEqual(
    gaveWay.ranWhileDisconnected?.map((turn) => turn.request),
    ["Cut-off coordinator request on M1"],
  );
  const reviewButton = page.getByRole("button", { name: "Review turns", exact: true });
  await reviewButton.waitFor({ timeout: 60000 });
  await reviewButton.click();
  await page
    .getByRole("dialog")
    .getByText("Cut-off coordinator request on M1")
    .waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(output, "11-review-turns.png"), animations: "disabled" });
  receipt.screenshots.push("11-review-turns.png");
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  receipt.checks.push(
    "Restarted M1 is demoted by the app to a relinquished member at the new epoch with M3 as successor, and Review turns lists the coordinator turn it ran while cut off",
  );
}
let browser, page, fleetProxy;
// AC-04: M4 reaches the joined M3 copy the way a fleet does, over HTTPS at a
// Tailscale name. The name resolves to a local TLS proxy in front of M3, only
// inside M4's server process, which trusts the proxy's throwaway certificate.
const fleetName = "m3-link.fixture.ts.net";
const fleetPort = await port();
const fleetDir = join(scratch, "fleet-tls");
mkdirSync(fleetDir);
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
    join(fleetDir, "key.pem"),
    "-out",
    join(fleetDir, "cert.pem"),
    "-subj",
    `/CN=${fleetName}`,
    "-addext",
    `subjectAltName=DNS:${fleetName}`,
  ],
  { stdio: "ignore" },
);
writeFileSync(
  join(fleetDir, "resolve.mjs"),
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
const launchArguments = join(fleetDir, "launch-arguments.json");
const launchResult = join(fleetDir, "launch-result.json");
try {
  // Two projects for one repository, on M4 and M3, created independently. M4's identity is
  // removed while offline below, so it is a legacy project the link must adopt one for (AC-01);
  // M3 keeps the standalone identity a new project gets.
  const createLinkFixture = async (host, index) => {
    host.linkFolder = join(host.dir, "link-fixture");
    mkdirSync(host.linkFolder);
    writeFileSync(join(host.linkFolder, "README.md"), "Synthetic link fixture.\n");
    const git = (...args) =>
      execFileSync("/usr/bin/git", args, {
        cwd: host.linkFolder,
        stdio: "ignore",
        env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    git("init", "-q", "-b", "main");
    git("remote", "add", "origin", "https://github.com/example/link-fixture.git");
    host.linkProjectId = randomUUID();
    await request(host, "/api/projects/mutate", {
      type: "project.create",
      commandId: randomUUID(),
      projectId: host.linkProjectId,
      title: "Link fixture",
      workspaceRoot: host.linkFolder,
    });
    await rpc(host, "projects.memoryWrite", {
      projectId: host.linkProjectId,
      name: "plan.md",
      content: `${host.label} plan`,
      expectedRevision: null,
    });
    await rpc(host, "projects.memoryWrite", {
      projectId: host.linkProjectId,
      name: index === 0 ? "kept-only.md" : "m3-only.md",
      content: `Only on ${host.label}`,
      expectedRevision: null,
    });
  };
  for (const label of ["M4 fixture", "M1 fixture", "M3 fixture"]) {
    const dir = join(scratch, label.replaceAll(" ", "-"));
    mkdirSync(dir);
    const data = join(dir, "data");
    mkdirSync(join(data, "userdata"), { recursive: true });
    const drivers = [
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
    writeFileSync(
      join(data, "userdata/settings.json"),
      JSON.stringify({
        providers: Object.fromEntries(drivers.map((driver) => [driver, { enabled: false }])),
        providerInstances: Object.fromEntries(
          drivers.map((driver) => [driver, { driver, enabled: false, config: {} }]),
        ),
        cursorKeychainUsageEnabled: false,
      }),
    );
    if (label !== "M1 fixture") {
      // A model-free local ACP agent whose only act is studio_thread_launch. M3 offers the
      // same model, so the worker M4 starts there inherits one it can run; it is never prompted.
      const settingsFile = join(data, "userdata/settings.json");
      const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
      settings.providerInstances.linkLaunch = {
        driver: "acpRegistry",
        displayName: "Link launch agent",
        enabled: true,
        config: {
          source: "local",
          commandPath: process.execPath,
          commandArgs: [
            join(root, "scripts/studio-logical-projects/link-launch-agent.mjs"),
            ...(label === "M4 fixture"
              ? [launchArguments, launchResult]
              : ["--echo", join(fleetDir, `worker-run-${label.split(" ")[0]}.json`)]),
          ],
          customModels: ["link-launch"],
        },
      };
      writeFileSync(settingsFile, JSON.stringify(settings));
    }
    const workspace = join(dir, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "README.md"), "Synthetic logical project verification only.\n");
    const host = {
      label,
      dir,
      data,
      workspace,
      port: await port(),
      environmentId: randomUUID(),
      projectId: randomUUID(),
      extraEnv:
        label === "M4 fixture"
          ? {
              NODE_EXTRA_CA_CERTS: join(fleetDir, "cert.pem"),
              NODE_OPTIONS: `--import=${pathToFileURL(join(fleetDir, "resolve.mjs")).href}`,
            }
          : {},
    };
    host.origin = `http://127.0.0.1:${host.port}`;
    writeFileSync(join(data, "userdata/environment-id"), host.environmentId);
    hosts.push(host);
    await exchange(host, await start(host));
    const config = await rpc(host, "server.getConfig", {});
    assert.ok(
      config.providers.every(
        (provider) => provider.enabled === false || provider.instanceId === "linkLaunch",
      ),
      "Only the model-free link launch agent is enabled",
    );
    await request(host, "/api/projects/mutate", {
      type: "project.create",
      commandId: randomUUID(),
      projectId: host.projectId,
      title: `sw-easychamp product handoff ${label}`,
      workspaceRoot: workspace,
    });
    for (const [threadId, title] of [
      ["shared-worker-id", `${label} worker`],
      ...(hosts.length === 2 ? [["fixture-archive", "M1 archived worker"]] : []),
      [`project-coordinator:${host.projectId}`, `${label} coordinator`],
    ]) {
      await rpc(host, "orchestration.dispatchCommand", {
        type: "thread.create",
        commandId: randomUUID(),
        threadId,
        projectId: host.projectId,
        title,
        modelSelection: { instanceId: "codex", model: "synthetic-unavailable" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    }
    if (hosts.length === 2)
      await rpc(host, "orchestration.dispatchCommand", {
        type: "thread.archive",
        commandId: randomUUID(),
        threadId: "fixture-archive",
      });
    if (hosts.length !== 2) await createLinkFixture(host, hosts.length === 1 ? 0 : 1);
    await stop(host);
  }
  const members = hosts.map((host) => ({
    environmentId: host.environmentId,
    projectId: host.projectId,
    coordinatorThreadId: `project-coordinator:${host.projectId}`,
  }));
  const logicalProject = {
    id: "logical-project-fixture",
    title: "EasyChamp",
    coordinatorId: "logical-coordinator-fixture",
    members,
  };
  for (const [index, host] of hosts.entries()) {
    const db = new DatabaseSync(join(host.data, "userdata/statev2.sqlite"));
    const row = db
      .prepare("SELECT workspace_settings_json FROM projection_projects WHERE project_id=?")
      .get(host.projectId);
    const settings = {
      ...JSON.parse(row.workspace_settings_json),
      logicalProject,
      coordinatorThreadId: members[index].coordinatorThreadId,
      coordinatorBinding:
        index === 0
          ? { epoch: 2, state: "active", predecessor: members[2] }
          : {
              epoch: index - 1,
              state: "transferred",
              successor: index === 1 ? members[2] : members[0],
              operationId: randomUUID(),
            },
    };
    db.prepare("UPDATE projection_projects SET workspace_settings_json=? WHERE project_id=?").run(
      JSON.stringify(settings),
      host.projectId,
    );
    if (index === 0) {
      const linkRow = db
        .prepare("SELECT workspace_settings_json FROM projection_projects WHERE project_id=?")
        .get(host.linkProjectId);
      const {
        logicalProject: _identity,
        coordinatorBinding: _binding,
        ...legacy
      } = JSON.parse(linkRow.workspace_settings_json);
      db.prepare("UPDATE projection_projects SET workspace_settings_json=? WHERE project_id=?").run(
        JSON.stringify(legacy),
        host.linkProjectId,
      );
    }
    // Completed synthetic records prove historical attribution without starting a provider.
    for (const threadId of ["shared-worker-id", members[index].coordinatorThreadId]) {
      const at = "2026-10-13T12:00:00.000Z";
      const runId = randomUUID();
      const messageId = randomUUID();
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "fixture-recorded-model" },
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
        text: `${host.label} historical request`,
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at,
        updatedAt: at,
      };
      db.prepare(
        "INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,completed_at,payload_json) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(runId, threadId, 1, "codex", "codex", "completed", at, at, JSON.stringify(run));
      db.prepare(
        "INSERT INTO orchestration_v2_projection_messages (message_id,thread_id,run_id,role,streaming,created_at,updated_at,payload_json) VALUES (?,?,?,?,?,?,?,?)",
      ).run(messageId, threadId, runId, "user", 0, at, at, JSON.stringify(message));
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
        title: "Synthetic historical request",
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "user_message",
        messageId,
        inputIntent: "turn_start",
        text: message.text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      };
      db.prepare(
        "INSERT INTO orchestration_v2_projection_turn_items (turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json) VALUES (?,?,?,?,?,?,?,?)",
      ).run(item.id, threadId, runId, 1, "user_message", "completed", at, JSON.stringify(item));
    }
    db.close();
    await exchange(host, await start(host));
  }
  receipt.checks.push(
    "Three isolated servers; providers disabled; distinct host IDs and colliding worker IDs seeded",
  );
  const linkHosts = [hosts[0], hosts[2]];
  const [legacyPreview, standalonePreview] = await Promise.all(
    linkHosts.map((host) => rpc(host, "projectLink.preview", { projectId: host.linkProjectId })),
  );
  for (const preview of [legacyPreview, standalonePreview])
    assert.equal(preview.fingerprint.repositories[0]?.originKey, "github.com/example/link-fixture");
  assert.equal(legacyPreview.logicalProject, null, "The M4 Link fixture is a legacy project");
  assert.deepEqual(
    standalonePreview.logicalProject.members.map((member) => member.projectId),
    [linkHosts[1].linkProjectId],
    "The M3 Link fixture has only its own standalone identity",
  );
  receipt.checks.push(
    "Two Link fixture projects with one origin and differing notes: M4 legacy (no identity), M3 standalone",
  );
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
  const { chromium } = playwright;
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
  const primary = hosts[0];
  const pairing = await request(primary, "/api/auth/pairing-token", {
    label: "Owned verifier browser",
  });
  const authenticated = await context.request.post(primary.origin + "/api/auth/browser-session", {
    headers: { Origin: primary.origin },
    data: { credential: pairing.credential },
  });
  assert.equal(authenticated.status(), 200, "Owned browser authentication failed");
  // The browser uses the same freshly minted bearer credentials through its normal saved catalog.
  // A minimal static page initializes IndexedDB before the app's connection runtime starts.
  page = await context.newPage();
  await page.route(`${primary.origin}/__logical-proof`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Owned verifier</title>",
    }),
  );
  await page.goto(`${primary.origin}/__logical-proof`);
  await page.evaluate(
    async ({ hosts }) => {
      localStorage.setItem(
        "studio:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: new Date().toISOString() }),
      );
      const document = {
        schemaVersion: 1,
        targets: [],
        profiles: [],
        credentials: [],
        remoteDpopTokens: [],
        disabledEnvironmentIds: [],
      };
      for (const host of hosts) {
        const connectionId = `fixture-${host.environmentId}`;
        document.targets.push({
          _tag: "BearerConnectionTarget",
          environmentId: host.environmentId,
          label: host.label,
          connectionId,
        });
        document.profiles.push({
          _tag: "BearerConnectionProfile",
          environmentId: host.environmentId,
          label: host.label,
          connectionId,
          httpBaseUrl: host.origin,
          wsBaseUrl: host.origin.replace("http:", "ws:"),
        });
        document.credentials.push({
          connectionId,
          credential: { _tag: "BearerConnectionCredential", token: host.token },
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
      hosts: hosts.slice(1).map(({ label, environmentId, origin, token }) => ({
        label,
        environmentId,
        origin,
        token,
      })),
    },
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `${primary.origin}/projects/${encodeURIComponent("logical-project:logical-project-fixture")}`,
  );
  await page
    .getByRole("region", { name: "Project coordinator", exact: true })
    .waitFor({ timeout: 45000 });
  await page
    .locator("[data-request-execution], [data-request-execution-origin]")
    .filter({ hasText: /fixture.recorded.model/i })
    .first()
    .waitFor();
  await page.screenshot({
    path: join(output, "01-unified-project.png"),
    fullPage: true,
    animations: "disabled",
  });
  receipt.screenshots.push("01-unified-project.png");
  writeFileSync(join(output, "01-page.txt"), await page.locator("body").innerText());
  assert.equal(
    await page.locator('a[href*="/projects/"]').filter({ hasText: "EasyChamp" }).count(),
    1,
    "One sidebar entry",
  );
  assert.equal(await page.locator(".project-workspace-identity h1").innerText(), "EasyChamp");
  await page
    .getByRole("button", { name: "Continue this project on another machine", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByText(/Move EasyChamp forward from/)
    .waitFor();
  await page.keyboard.press("Escape");
  receipt.checks.push(
    "EasyChamp stays canonical in sidebar, coordinator header and handoff review despite legacy checkout labels",
  );
  for (const host of hosts)
    await page
      .locator(`[data-thread-environment="${host.environmentId}"]`)
      .getByText(`${host.label} worker`, { exact: true })
      .waitFor();
  receipt.checks.push("One project sidebar entry and workers from all three execution hosts");
  receipt.checks.push("Coordinator request retains recorded run model instead of current picker");
  for (const host of hosts.slice(1)) {
    await page
      .locator(`[data-thread-environment="${host.environmentId}"]`)
      .getByText(`${host.label} worker`, { exact: true })
      .click();
    await page.getByText(`${host.label} historical request`, { exact: true }).waitFor();
    const provenance = page.locator(
      `[data-request-execution-origin][data-environment-id="${host.environmentId}"]`,
    );
    await provenance.filter({ hasText: /fixture.recorded.model/i }).waitFor();
    assert.ok((await provenance.innerText()).includes(host.label));
    await provenance.scrollIntoViewIfNeeded();
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    writeFileSync(
      join(output, `${host.label.slice(0, 2)}-worker-page.txt`),
      await page.locator("body").innerText(),
    );
    await page.screenshot({
      path: join(output, `${host.label.slice(0, 2)}-scoped-worker.png`),
      fullPage: true,
      animations: "disabled",
    });
    receipt.screenshots.push(`${host.label.slice(0, 2)}-scoped-worker.png`);
    await page.getByRole("button", { name: "Back to project threads", exact: true }).click();
  }
  receipt.checks.push(
    "Identical worker IDs on different hosts open the correct transcript and recorded origin",
  );
  const resolvedGroup = page.locator('[data-group="Resolved"]');
  await resolvedGroup.getByRole("button", { name: /^Resolved/ }).click();
  const archivedRow = resolvedGroup.locator("article").filter({ hasText: "M1 archived worker" });
  await archivedRow.getByText("M1 archived worker", { exact: true }).waitFor();
  await archivedRow.getByRole("button", { name: "Reopen", exact: true }).waitFor();
  receipt.checks.push(
    "Remote archived threads remain visible in Resolved with their Reopen action",
  );
  // Since #482 only the copy the coordinator came from shows its history; earlier builds show each.
  const previous = page
    .locator("summary")
    .filter({ hasText: /^Previous coordinator on / })
    .first();
  await previous.waitFor();
  const previousHost = (await previous.innerText()).match(
    /Previous coordinator on (M\d fixture)/,
  )[1];
  await previous.click();
  await page
    .getByLabel(`Retained coordinator messages on ${previousHost}`, { exact: true })
    .getByText(`${previousHost} historical request`, { exact: true })
    .waitFor();
  receipt.checks.push("Previous coordinator conversation remains readable in the same project");

  // Link the two legacy copies through the settings UI, against the real servers.
  const [linkKept, linkJoining] = linkHosts;
  // The kept copy is local to the page's server, which labels itself with the real host name.
  const linkHref = await page
    .locator(`a[href*="/projects/"][href*="${linkKept.linkProjectId}"]`)
    .first()
    .getAttribute("href");
  const linkKey = decodeURIComponent(linkHref.split("/projects/")[1].split("?")[0]);
  await page.goto(`${primary.origin}/settings/projects?project=${encodeURIComponent(linkKey)}`);
  await page.getByText("Link with a project on another machine", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Link…", exact: true }).click();
  const linkDialog = page.getByRole("dialog");
  const candidate = linkDialog
    .locator('[data-slot="link-candidate"]')
    .filter({ hasText: `Link fixture on ${linkJoining.label}` });
  await candidate.filter({ hasText: "Same root repository" }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(output, "03-link-candidates.png"), animations: "disabled" });
  receipt.screenshots.push("03-link-candidates.png");
  await candidate.getByRole("radio").click();
  await linkDialog.getByRole("button", { name: "Review link", exact: true }).click();
  await linkDialog.getByText("Coordinator stays on", { exact: true }).waitFor();
  // Both coordinators are idle; keep M4's explicitly.
  await linkDialog
    .getByRole("radiogroup", { name: "Coordinator stays on" })
    .locator("label")
    .filter({ hasNotText: linkJoining.label })
    .getByRole("radio")
    .click();
  const conflict = linkDialog.locator('[data-slot="note-conflict"]').filter({ hasText: "plan.md" });
  await conflict.waitFor();
  await linkDialog
    .getByText(/^Copied to /)
    .first()
    .waitFor();
  await conflict.getByText("Keep both", { exact: true }).click();
  await linkDialog.getByRole("checkbox").click();
  await page.screenshot({ path: join(output, "04-link-review.png"), animations: "disabled" });
  receipt.screenshots.push("04-link-review.png");
  await linkDialog.getByRole("button", { name: /^Link, keep coordinator on / }).click();
  await linkDialog.getByText("Projects linked", { exact: true }).waitFor({ timeout: 30000 });
  await page.screenshot({ path: join(output, "05-linked.png"), animations: "disabled" });
  receipt.screenshots.push("05-linked.png");
  await linkDialog.getByRole("button", { name: "Done", exact: true }).click();

  const [keptView, joinedView] = await Promise.all(
    linkHosts.map((host) => rpc(host, "projectLink.preview", { projectId: host.linkProjectId })),
  );
  assert.match(keptView.logicalProject.id, /^logical:/, "The kept copy adopted a logical identity");
  assert.equal(joinedView.logicalProject.id, keptView.logicalProject.id);
  assert.deepEqual(keptView.coordinatorBinding, { epoch: 0, state: "active" });
  assert.equal(joinedView.coordinatorBinding.state, "transferred");
  assert.equal(joinedView.coordinatorBinding.epoch, 0);
  assert.deepEqual(joinedView.coordinatorBinding.successor, keptView.member);
  for (const view of [keptView, joinedView])
    assert.deepEqual(
      view.logicalProject.members.map((member) => member.projectId).sort(),
      [linkKept.linkProjectId, linkJoining.linkProjectId].sort(),
    );
  assert.deepEqual(
    keptView.notes.map((note) => [note.name, note.content]),
    [
      ["kept-only.md", "Only on M4 fixture"],
      ["m3-only.md", "Only on M3 fixture"],
      ["plan-m3-fixture.md", "M3 fixture plan"],
      ["plan.md", "M4 fixture plan"],
    ],
  );
  receipt.checks.push(
    "UI link adopts logical:<uuid> on the kept copy; kept binding unchanged (epoch 0 active); joined copy relinquished at the kept epoch; both list both members; notes merged with keep-both",
  );
  // A retry of the same link replays every step without a second change.
  const retryId = randomUUID();
  const prepared = await rpc(linkKept, "projectLink.prepare", {
    operationId: retryId,
    projectId: linkKept.linkProjectId,
    joining: joinedView.member,
  });
  assert.equal(prepared.adopted, false);
  const accepted = await rpc(linkJoining, "projectLink.accept", {
    operationId: retryId,
    projectId: linkJoining.linkProjectId,
    kept: prepared.kept,
    logicalProject: prepared.logicalProject,
    coordinatorBinding: prepared.coordinatorBinding,
    keptFingerprint: prepared.fingerprint,
  });
  assert.equal(accepted.replayed, true);
  const committed = await rpc(linkKept, "projectLink.commit", {
    operationId: retryId,
    projectId: linkKept.linkProjectId,
    joining: accepted.member,
    notes: [],
  });
  assert.equal(committed.replayed, true);
  receipt.checks.push("Retrying the link against the real servers replays without changes");

  // The remote worker path resolves the joined copy by reciprocal membership only.
  const matching = await import(
    pathToFileURL(join(root, "apps/server/src/fleet/remoteWorkerMatching.ts")).href
  );
  const asProject = (view) => ({
    id: view.member.projectId,
    deletedAt: null,
    title: view.title,
    workspaceSettings: { logicalProject: view.logicalProject },
  });
  const resolved = matching.matchLogicalRemoteProject({
    logical: keptView.logicalProject,
    environmentId: linkJoining.environmentId,
    remote: [asProject(joinedView)],
  });
  assert.equal(resolved.match, "configured");
  assert.equal(resolved.projectId, linkJoining.linkProjectId);
  assert.ok(
    matching.isLogicalProjectBinding(
      asProject(keptView),
      joinedView.logicalProject,
      keptView.member,
    ),
    "The binding holds from the joined copy's side too",
  );
  const stranger = { ...asProject(joinedView), workspaceSettings: {} };
  assert.equal(
    matching.matchLogicalRemoteProject({
      logical: keptView.logicalProject,
      environmentId: linkJoining.environmentId,
      remote: [stranger],
    }).match,
    "none",
    "A same-repository project without the identity is never used",
  );
  receipt.checks.push(
    "Remote worker project resolution (matchLogicalRemoteProject, isLogicalProjectBinding) selects the joined copy in both directions from real server state; a same-repository stranger is refused",
  );

  // AC-04 live: the kept coordinator's machine starts a real worker on M3 for the linked
  // project, through its fleet connection and worker grant, from an agent turn in a thread.
  fleetProxy = createHttpsServer(
    {
      key: readFileSync(join(fleetDir, "key.pem")),
      cert: readFileSync(join(fleetDir, "cert.pem")),
    },
    (incoming, outgoing) => {
      const forwarded = httpRequest(
        `${linkJoining.origin}${incoming.url}`,
        // Tailscale Serve terminates TLS and says so, which the server's OAuth origin follows.
        { method: incoming.method, headers: { ...incoming.headers, "x-forwarded-proto": "https" } },
        (response) => {
          outgoing.writeHead(response.statusCode, response.headers);
          response.pipe(outgoing);
        },
      );
      forwarded.on("error", () => outgoing.destroy());
      incoming.pipe(forwarded);
    },
  );
  await new Promise((done) => fleetProxy.listen(fleetPort, "127.0.0.1", done));
  const fleetFile = join(linkKept.data, "studio-fleet.json");
  writeFileSync(
    fleetFile,
    JSON.stringify({
      version: 1,
      machines: [
        {
          id: "m3-link",
          label: linkJoining.label,
          environmentId: linkJoining.environmentId,
          url: `https://${fleetName}:${fleetPort}/`,
        },
      ],
    }),
    { mode: 0o600 },
  );
  chmodSync(fleetFile, 0o600);
  const fleetPairing = await request(linkJoining, "/api/auth/pairing-token", {
    label: `SpecWithCode workers · ${linkKept.environmentId}`,
    scopes: ["orchestration:read", "orchestration:operate"],
  });
  const allowed = await request(linkKept, "/api/studio/fleet/workers/allow", {
    id: "m3-link",
    access: "full-access",
    pairingCode: fleetPairing.credential,
  });
  assert.equal(allowed.id, "m3-link");
  assert.ok(
    ["allowed", "expiring"].includes(allowed.workers?.status) && !allowed.workers?.problem,
    `M4 holds a worker grant on M3: ${JSON.stringify(allowed)}`,
  );
  const workerTitle = "Linked copy worker from M4";
  writeFileSync(
    launchArguments,
    JSON.stringify({
      machine: "m3-link",
      projectId: linkKept.linkProjectId,
      title: workerTitle,
      message: "Report the folder this worker runs in.",
    }),
  );
  const launcherThreadId = `link-launcher-${randomUUID()}`;
  await rpc(linkKept, "orchestration.dispatchCommand", {
    type: "thread.create",
    commandId: randomUUID(),
    threadId: launcherThreadId,
    projectId: linkKept.linkProjectId,
    title: "Start a worker on the linked copy",
    modelSelection: { instanceId: "linkLaunch", model: "link-launch" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  await rpc(linkKept, "orchestration.dispatchCommand", {
    type: "message.dispatch",
    commandId: randomUUID(),
    threadId: launcherThreadId,
    messageId: randomUUID(),
    text: `Start a worker on ${linkJoining.label} for this project.`,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "start_immediately" },
  });
  let launch;
  for (let attempt = 0; attempt < 120 && launch === undefined; attempt += 1) {
    try {
      launch = JSON.parse(readFileSync(launchResult, "utf8"));
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  assert.ok(launch, "The coordinator machine's agent turn ran studio_thread_launch");
  writeFileSync(
    join(output, "08-linked-worker-launch.json"),
    JSON.stringify(launch, null, 2) + "\n",
  );
  const launchContent =
    launch.body?.result?.structuredContent ??
    JSON.parse(launch.body?.result?.content?.[0]?.text ?? "null");
  assert.equal(launch.body?.result?.isError ?? false, false, JSON.stringify(launch).slice(0, 2000));
  const remoteThreadId = launchContent?.threadId ?? launchContent?.thread?.threadId;
  assert.ok(
    remoteThreadId,
    `The launch returned the worker thread: ${JSON.stringify(launchContent)}`,
  );
  assert.ok(
    launchContent.runId,
    `The launch started a run on M3: ${JSON.stringify(launchContent)}`,
  );
  let remoteThread;
  let remoteRun;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    remoteThread = await rpc(linkJoining, "orchestration.getThreadProjection", {
      threadId: remoteThreadId,
    });
    remoteRun = (remoteThread.runs ?? []).find((run) => run.id === launchContent.runId);
    if (["completed", "failed", "interrupted", "cancelled"].includes(remoteRun?.status)) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  assert.equal(
    remoteRun?.status,
    "completed",
    `M3 ran the worker's first turn to completion: ${JSON.stringify(remoteRun)}`,
  );
  const workerEcho = JSON.parse(readFileSync(join(fleetDir, "worker-run-M3.json"), "utf8"));
  const joinedRoot = realpathSync(linkJoining.linkFolder);
  const sessionCwds = [
    ...(remoteThread.providerSessions ?? []),
    ...(remoteThread.checkpointScopes ?? []),
  ]
    .map((entry) => entry.cwd)
    .filter(Boolean);
  assert.ok(sessionCwds.length > 0, "M3 recorded the run's working directory");
  for (const cwd of [workerEcho.cwd, ...sessionCwds])
    assert.equal(realpathSync(cwd), joinedRoot, "The run works in M3's joined copy");
  assert.equal(workerEcho.text.includes("Report the folder this worker runs in."), true);
  receipt.linkedWorker = {
    launch: launchContent,
    remoteThreadId,
    runId: launchContent.runId,
    runStatus: remoteRun.status,
    cwd: workerEcho.cwd,
    serverCwds: sessionCwds,
    joinedWorkspaceRoot: linkJoining.linkFolder,
  };
  writeFileSync(
    join(output, "08-linked-worker-run.json"),
    JSON.stringify(workerEcho, null, 2) + "\n",
  );
  let reportBack;
  for (let attempt = 0; attempt < 120 && reportBack === undefined; attempt += 1) {
    try {
      reportBack = JSON.parse(readFileSync(`${launchResult}.later`, "utf8"));
    } catch {
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  assert.ok(reportBack, "The worker's result reached M4's coordinator thread");
  assert.match(
    reportBack.text,
    new RegExp(`on ${linkJoining.label} finished: completed`),
    "M4's coordinator hears that the M3 worker completed",
  );
  assert.ok(
    reportBack.text.includes(encodeURIComponent(remoteThreadId)),
    "The report names the M3 worker thread",
  );
  writeFileSync(
    join(output, "08-linked-worker-report-back.json"),
    JSON.stringify(reportBack, null, 2) + "\n",
  );
  const launcherRuns = async () =>
    (await rpc(linkKept, "orchestration.getThreadProjection", { threadId: launcherThreadId }))
      .runs ?? [];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const runs = await launcherRuns();
    if (runs.length >= 2 && runs.every((run) => run.status === "completed")) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  assert.deepEqual(
    (await launcherRuns()).map((run) => run.status),
    ["completed", "completed"],
    "M4's coordinator thread ran the launch and then received the worker's report",
  );
  writeFileSync(
    join(output, "08-linked-worker-thread.json"),
    JSON.stringify(remoteThread, null, 2) + "\n",
  );
  assert.equal(
    remoteThread.thread?.projectId ?? remoteThread.projectId,
    linkJoining.linkProjectId,
    "The worker runs in M3's joined Link fixture copy",
  );
  const settingsUrl = page.url();
  await page.goto(`${primary.origin}${linkHref}`);
  const workerRow = page
    .locator(`[data-thread-environment="${linkJoining.environmentId}"]`)
    .getByText(workerTitle, { exact: true })
    .first();
  await workerRow.waitFor({ timeout: 30000 });
  await workerRow.click();
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  writeFileSync(join(output, "08-linked-worker-page.txt"), await page.locator("body").innerText());
  await page.screenshot({ path: join(output, "08-linked-worker.png"), animations: "disabled" });
  receipt.screenshots.push("08-linked-worker.png");
  receipt.checks.push(
    "Live remote worker: an agent turn in M4's kept Link fixture thread (local model-free ACP agent) calls studio_thread_launch on the fleet machine; M4 reaches M3 over HTTPS with its worker grant and M3 creates the worker in its joined Link fixture copy, which the linked project lists under M3",
  );
  await request(linkKept, "/api/studio/fleet/workers/stop", { id: "m3-link" });
  await new Promise((done) => fleetProxy.close(done));
  fleetProxy.closeAllConnections?.();
  fleetProxy = undefined;
  await page.goto(settingsUrl);

  // Sidebar shows the linked project once, with each copy's role.
  const linkedRow = page.locator(".sws-project-row").filter({ hasText: "Link fixture" });
  await linkedRow
    .filter({ hasText: `${linkJoining.label}: runs workers` })
    .filter({ hasText: /: coordinator/ })
    .waitFor({ timeout: 30000 });
  assert.equal(await linkedRow.count(), 1, "One sidebar entry for the linked project");
  await page
    .locator("[data-project-copy]")
    .filter({ hasText: "Runs workers" })
    .waitFor({ timeout: 30000 });
  await page
    .getByText("Link with a project on another machine", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "06-machines.png"), animations: "disabled" });
  receipt.screenshots.push("06-machines.png");
  receipt.checks.push(
    "Sidebar lists the linked project once with each machine's role; Machines shows both copies",
  );

  // Unlink the joined copy from the kept copy's settings.
  await page
    .getByRole("button", { name: `Unlink the copy on ${linkJoining.label}`, exact: true })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: "Unlink", exact: true }).click();
  await page
    .getByText(`${linkJoining.label} has its own coordinator again`)
    .waitFor({ timeout: 30000 });
  await page
    .getByText("Link with a project on another machine", { exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "07-unlinked.png"), animations: "disabled" });
  receipt.screenshots.push("07-unlinked.png");
  const [keptAfter, leftAfter] = await Promise.all(
    linkHosts.map((host) => rpc(host, "projectLink.preview", { projectId: host.linkProjectId })),
  );
  assert.deepEqual(keptAfter.logicalProject.members, [keptView.member]);
  assert.match(leftAfter.logicalProject.id, /^logical:/);
  assert.notEqual(leftAfter.logicalProject.id, keptView.logicalProject.id);
  assert.deepEqual(leftAfter.logicalProject.members, [leftAfter.member]);
  assert.equal(leftAfter.coordinatorBinding.state, "active");
  assert.equal(leftAfter.coordinatorBinding.epoch, 0);
  assert.ok(leftAfter.notes.some((note) => note.name === "kept-only.md"));
  assert.equal(
    leftAfter.notes.find((note) => note.name === "plan.md")?.content,
    "M3 fixture plan",
    "The unlinked copy keeps its own notes",
  );
  receipt.checks.push(
    "UI unlink gives the member a fresh identity and active epoch-0 coordinator with the kept notes, and removes it from the kept members",
  );
  await verifyWorkGrants();
  await verifyTakeover();
  await page.goto(
    `${primary.origin}/projects/${encodeURIComponent("logical-project:logical-project-fixture")}`,
  );
  await page
    .getByRole("region", { name: "Project coordinator", exact: true })
    .waitFor({ timeout: 45000 });
  await stop(hosts[2]);
  await page
    .locator(`[data-unavailable-thread-host="${hosts[2].environmentId}"]`)
    .waitFor({ timeout: 45000 });
  assert.ok(
    (
      await page.locator(`[data-unavailable-thread-host="${hosts[2].environmentId}"]`).innerText()
    ).includes("thread list may be incomplete"),
  );
  await page.screenshot({
    path: join(output, "02-host-unavailable.png"),
    fullPage: true,
    animations: "disabled",
  });
  writeFileSync(join(output, "02-page.txt"), await page.locator("body").innerText());
  receipt.screenshots.push("02-host-unavailable.png");
  receipt.checks.push(
    "Disconnected host is explicitly incomplete without replacing the coordinator",
  );
  assert.equal(errors.length, 0, "No browser exceptions");
  receipt.providerTurns = hosts.reduce((count, host) => {
    const db = openLiveDatabaseReadOnly(join(host.data, "userdata/statev2.sqlite"));
    const total = db
      .prepare("SELECT COUNT(*) AS total FROM orchestration_v2_projection_provider_turns")
      .get().total;
    db.close();
    return count + total;
  }, 0);
  // M4's launch turn, the M3 worker's turn and M4's report-back turn, all run by the
  // local model-free agent.
  assert.equal(receipt.providerTurns, 3, "Only the three model-free linked-launch turns ran");
  receipt.success = true;
} catch (error) {
  receipt.failure = { name: error.name, message: error.message };
  if (page) {
    await page
      .screenshot({ path: join(output, "failure.png"), fullPage: true, animations: "disabled" })
      .catch(() => {});
    writeFileSync(
      join(output, "failure-page.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => "Unavailable"),
    );
  }
  throw error;
} finally {
  fleetProxy?.closeAllConnections?.();
  fleetProxy?.close();
  if (browser) await browser.close();
  await Promise.all(hosts.map(stop));
  receipt.ownedProcessesStopped = hosts.every(
    (host) => host.child?.exitCode !== null || host.child?.signalCode !== null,
  );
  save();
  if (receipt.ownedProcessesStopped) rmSync(scratch, { recursive: true, force: true });
}
