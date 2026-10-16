#!/usr/bin/env node
// Three isolated real servers, synthetic history, disabled providers, headless browser.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
let browser, page;
try {
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
    };
    host.origin = `http://127.0.0.1:${host.port}`;
    writeFileSync(join(data, "userdata/environment-id"), host.environmentId);
    hosts.push(host);
    await exchange(host, await start(host));
    const config = await rpc(host, "server.getConfig", {});
    assert.ok(config.providers.every((provider) => provider.enabled === false));
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
    .locator("[data-request-execution]")
    .filter({ hasText: "fixture-recorded-model" })
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
    await provenance.filter({ hasText: "fixture-recorded-model" }).waitFor();
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
  await page.locator("summary").filter({ hasText: "Previous coordinator on M1 fixture" }).click();
  await page
    .getByLabel("Retained coordinator messages on M1 fixture", { exact: true })
    .getByText("M1 fixture historical request", { exact: true })
    .waitFor();
  receipt.checks.push("Previous coordinator conversation remains readable in the same project");
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
  assert.equal(receipt.providerTurns, 0, "Synthetic verification must not start provider turns");
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
  if (browser) await browser.close();
  await Promise.all(hosts.map(stop));
  receipt.ownedProcessesStopped = hosts.every(
    (host) => host.child?.exitCode !== null || host.child?.signalCode !== null,
  );
  save();
  if (receipt.ownedProcessesStopped) rmSync(scratch, { recursive: true, force: true });
}
