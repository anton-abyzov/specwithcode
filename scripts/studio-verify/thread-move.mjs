#!/usr/bin/env node
// Headless end-to-end check of "Move to another project" in the built app.
// Isolated private server, disabled providers, two synthetic projects, no provider turns.
// Usage: node scripts/studio-verify/thread-move.mjs /absolute/owned/report-dir
// Build web and server first. Optional: PLAYWRIGHT_MODULE, STUDIO_TEST_CHROMIUM.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(Number(process.versions.node.split(".")[0]), 22, "Use the project's Node 22 runtime");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(process.argv[2] ?? join(tmpdir(), `thread-move-${randomUUID()}`));
mkdirSync(output, { recursive: true, mode: 0o700 });
const scratch = mkdtempSync(join(tmpdir(), "thread-move-"));
const data = join(scratch, "data");
mkdirSync(join(data, "userdata"), { recursive: true });
const workspaces = { source: join(scratch, "specweave"), target: join(scratch, "easychamp") };
for (const folder of Object.values(workspaces)) {
  mkdirSync(folder);
  writeFileSync(join(folder, "README.md"), "Synthetic move fixture.\n");
}
const drivers = ["codex", "claudeAgent", "cursor", "grok", "pi", "opencode", "antigravity"];
writeFileSync(
  join(data, "userdata/settings.json"),
  JSON.stringify({
    providers: Object.fromEntries(drivers.map((driver) => [driver, { enabled: false }])),
    providerInstances: Object.fromEntries(
      drivers.map((driver) => [driver, { driver, enabled: false, config: {} }]),
    ),
  }),
);

const port = await new Promise((done, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => done(value));
  });
});
const origin = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  [
    // STUDIO_SERVER_ENTRY checks an installed release instead of this checkout's build.
    process.env.STUDIO_SERVER_ENTRY ?? join(root, "apps/server/dist/bin.mjs"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    data,
    "--no-browser",
  ],
  {
    cwd: scratch,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: scratch,
      LANG: "en_US.UTF-8",
      STUDIO_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
      STUDIO_DISABLE_AUTO_UPDATE: "true",
      PWDEBUG: "0",
      PLAYWRIGHT_HTML_OPEN: "never",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

/** One authenticated WebSocket RPC against the private server. */
async function rpc(context, tag, payload) {
  const response = await context.request.post(origin + "/api/auth/websocket-ticket", {
    headers: { Origin: origin },
  });
  assert.equal(response.status(), 200);
  const { ticket } = await response.json();
  const url = new URL(origin);
  url.protocol = "ws:";
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");
  return await new Promise((done, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: origin } });
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`${tag} timed out`));
    }, 20000);
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
        if (item._tag !== "Exit" || String(item.requestId) !== "1") continue;
        clearTimeout(timer);
        ws.close();
        if (item.exit?._tag === "Success") done(item.exit.value);
        else
          reject(
            Object.assign(new Error(`${tag} failed: ${JSON.stringify(item.exit).slice(0, 800)}`), {
              exit: item.exit,
            }),
          );
      }
    });
  });
}

const receipt = { headless: true, providerTurns: 0, steps: [], screenshots: [] };
const step = (name, detail = {}) => receipt.steps.push({ name, ...detail });
let browser;
let pageForFailure;
try {
  const credential = await new Promise((done, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Private server did not become ready")), 45000);
    const observe = (chunk) => {
      buffer = (buffer + chunk).slice(-65536);
      const match = buffer.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("exit", (code) => reject(new Error(`Private server exited: ${code}`)));
  });
  const playwrightPath =
    process.env.PLAYWRIGHT_MODULE ??
    join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    );
  const { chromium } = createRequire(import.meta.url)(playwrightPath);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  await context.addInitScript(() => {
    if (!localStorage.getItem("studio:client-settings:v1"))
      localStorage.setItem(
        "studio:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: "2026-10-09T00:00:00.000Z" }),
      );
  });
  const auth = await context.request.post(origin + "/api/auth/browser-session", {
    data: { credential },
    headers: { Origin: origin },
  });
  assert.equal(auth.status(), 200);

  const projects = { source: randomUUID(), target: randomUUID() };
  const titles = { source: "specweave-fixture", target: "easychamp-fixture" };
  for (const side of ["source", "target"]) {
    const created = await context.request.post(origin + "/api/projects/mutate", {
      data: {
        type: "project.create",
        commandId: randomUUID(),
        projectId: projects[side],
        title: titles[side],
        workspaceRoot: workspaces[side],
      },
      headers: { Origin: origin },
    });
    assert.equal(created.status(), 200, `project.create failed: ${await created.text()}`);
  }
  const sourceThreadId = randomUUID();
  const request = "Audit EasyChamp end to end and list what is broken.";
  await rpc(context, "orchestration.dispatchCommand", {
    type: "thread.create",
    commandId: randomUUID(),
    threadId: sourceThreadId,
    projectId: projects.source,
    title: "Audit EasyChamp",
    modelSelection: { instanceId: "codex", model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  // The provider is disabled, so this turn fails at once: work the user no longer has running.
  await rpc(context, "orchestration.dispatchCommand", {
    type: "message.dispatch",
    commandId: randomUUID(),
    threadId: sourceThreadId,
    messageId: randomUUID(),
    text: request,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  }).catch(() => {});
  // Wait until that turn has failed, so the thread is stopped work when it moves.
  for (let attempt = 0; ; attempt += 1) {
    const projection = await rpc(context, "orchestration.getThreadProjection", {
      threadId: sourceThreadId,
    });
    const live = projection.runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    );
    if (projection.runs.length > 0 && !live) break;
    if (attempt > 60) throw new Error("The fixture turn never settled.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  step("fixture", { projects, sourceThreadId });

  const page = await context.newPage();
  pageForFailure = page;
  const shot = async (name) => {
    const file = join(output, `${name}.png`);
    await page.screenshot({ path: file, animations: "disabled" });
    receipt.screenshots.push(file);
  };
  await page.goto(`${origin}/`, { waitUntil: "load" });
  const config = await rpc(context, "server.getConfig", {});
  const environmentId = config.environment.environmentId;
  assert.equal(config.environment.capabilities.threadProjectMove, true);
  await page.goto(`${origin}/${environmentId}/${sourceThreadId}`, { waitUntil: "load" });
  const row = page.locator("a, button, [role=link], [data-thread-id]", {
    hasText: "Audit EasyChamp",
  });
  await row.first().waitFor({ timeout: 30000 });
  await page
    .getByRole("button", { name: /^Thread actions/ })
    .first()
    .click();
  const menuItem = page.locator("button", { hasText: "Move to another project…" });
  await menuItem.first().waitFor({ timeout: 15000 });
  await menuItem.first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Move to another project").first().waitFor({ timeout: 15000 });
  const textarea = dialog.locator("textarea");
  await page.waitForFunction(
    (expected) => document.querySelector("[role=dialog] textarea")?.value === expected,
    request,
    { timeout: 15000 },
  );
  const startChecked = await dialog.getByRole("checkbox").getAttribute("aria-checked");
  assert.equal(startChecked, "false", "Stopped work must not restart by default");
  step("dialog", { prefilled: await textarea.inputValue(), startByDefault: startChecked });
  await dialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: titles.target }).click();
  await shot("1-dialog");
  await dialog.getByRole("button", { name: `Move to ${titles.target}` }).click();

  await page.waitForURL((url) => !url.pathname.endsWith(sourceThreadId), { timeout: 30000 });
  await page.getByText(`Moved here from ${titles.source}`).first().waitFor({ timeout: 20000 });
  await page.waitForFunction(
    (expected) =>
      [...document.querySelectorAll("textarea, [contenteditable=true]")].some((element) =>
        ("value" in element ? element.value : element.textContent)?.includes(expected),
      ),
    request,
    { timeout: 15000 },
  );
  await shot("2-new-thread");
  const source = await rpc(context, "orchestration.getThreadProjection", {
    threadId: sourceThreadId,
  });
  const targetThreadId = source.thread.movedTo.threadId;
  assert.ok(page.url().endsWith(`/${targetThreadId}`), "The app opened the new thread");
  step("new thread", { targetThreadId, url: page.url() });
  const target = await rpc(context, "orchestration.getThreadProjection", {
    threadId: targetThreadId,
  });
  assert.equal(target.thread.projectId, projects.target);
  assert.equal(target.thread.movedFrom.threadId, sourceThreadId);
  assert.equal(target.runs.length, 0, "Cancelled work must not resume in the new thread");
  assert.equal(target.messages.length, 0, "Nothing of the old conversation carries over");
  assert.equal(source.thread.projectId, projects.source);
  assert.equal(source.thread.movedTo.threadId, targetThreadId);
  assert.notEqual(source.thread.archivedAt, null);
  step("server state", {
    target: { projectId: target.thread.projectId, runs: target.runs.length },
    source: { archivedAt: source.thread.archivedAt, movedTo: source.thread.movedTo },
  });

  const refused = await rpc(context, "orchestration.dispatchCommand", {
    type: "message.dispatch",
    commandId: randomUUID(),
    threadId: sourceThreadId,
    messageId: randomUUID(),
    text: "keep going",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  }).then(
    () => false,
    (error) => JSON.stringify(error.exit ?? {}),
  );
  assert.ok(refused && refused.includes("moved to another project"), `Late send: ${refused}`);
  step("late send refused", { error: refused.slice(0, 300) });

  // The original is archived: its link leads to the archived list.
  await page.getByRole("button", { name: "Find original" }).first().click();
  await page.waitForURL((url) => url.pathname.endsWith("/settings/archived"), { timeout: 20000 });
  await page.getByText("Audit EasyChamp").first().waitFor({ timeout: 20000 });
  await shot("3-archived-original");
  step("original in archived");

  // Restored, it shows where its work went (the banner's own words, not the toast).
  await rpc(context, "orchestration.dispatchCommand", {
    type: "thread.unarchive",
    commandId: randomUUID(),
    threadId: sourceThreadId,
  });
  await page.goto(`${origin}/`, { waitUntil: "load" });
  const restoredRow = page.locator("a, button, [role=link], [data-thread-id]", {
    hasText: "Audit EasyChamp",
  });
  await restoredRow.first().waitFor({ timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelectorAll("a, button, [role=link], [data-thread-id]").length > 0,
  );
  await page.goto(`${origin}/${environmentId}/${sourceThreadId}`, { waitUntil: "load" });
  await page
    .getByText("This thread was stopped and archived.", { exact: false })
    .first()
    .waitFor({ timeout: 30000 });
  await shot("3-original");
  await page.getByRole("button", { name: "Open new thread" }).first().click();
  await page.waitForURL((url) => url.pathname.endsWith(`/${targetThreadId}`), { timeout: 20000 });
  step("original banner");

  // A chat outside every project moves as it is: same thread, same history.
  const scratchProject = await rpc(context, "projects.ensureScratch", {});
  const chatId = randomUUID();
  await rpc(context, "orchestration.dispatchCommand", {
    type: "thread.create",
    commandId: randomUUID(),
    threadId: chatId,
    projectId: scratchProject.projectId,
    title: "Lane C notes",
    modelSelection: { instanceId: "codex", model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  await rpc(context, "orchestration.dispatchCommand", {
    type: "message.dispatch",
    commandId: randomUUID(),
    threadId: chatId,
    messageId: randomUUID(),
    text: "Implement increment 0951 in the machine-grants worktree.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  }).catch(() => {});
  const chatBefore = await rpc(context, "orchestration.getThreadProjection", { threadId: chatId });
  const chatRow = page.locator("a, button, [role=link], [data-thread-id]", {
    hasText: "Lane C notes",
  });
  await chatRow.first().waitFor({ timeout: 30000 });
  await chatRow.first().click();
  await page.waitForURL((url) => url.pathname.endsWith(`/${chatId}`), { timeout: 30000 });
  await page
    .getByRole("button", { name: /^Thread actions/ })
    .first()
    .click();
  await page.locator("button", { hasText: "Move to another project…" }).first().click();
  const adoptDialog = page.getByRole("dialog");
  await adoptDialog.getByText("It moves as it is").first().waitFor({ timeout: 15000 });
  assert.equal(await adoptDialog.locator("textarea").count(), 0, "No restart request to edit");
  await adoptDialog.getByRole("combobox").first().click();
  await page.getByRole("option", { name: titles.source }).click();
  await shot("4-adopt-dialog");
  await adoptDialog.getByRole("button", { name: `Move to ${titles.source}` }).click();
  await page.getByText(`Moved to ${titles.source}`).first().waitFor({ timeout: 20000 });
  const chatAfter = await rpc(context, "orchestration.getThreadProjection", { threadId: chatId });
  assert.equal(chatAfter.thread.projectId, projects.source);
  assert.equal(chatAfter.thread.archivedAt, null);
  assert.equal(chatAfter.thread.worktreePath, chatBefore.thread.worktreePath);
  assert.equal(chatAfter.messages.length, chatBefore.messages.length);
  assert.deepEqual(
    chatAfter.runs.map((run) => run.id),
    chatBefore.runs.map((run) => run.id),
  );
  assert.ok(page.url().endsWith(`/${chatId}`), "The same chat stays open");
  await shot("5-adopted");
  step("no-project chat adopted", {
    chatId,
    from: scratchProject.projectId,
    to: chatAfter.thread.projectId,
    messages: chatAfter.messages.length,
    runs: chatAfter.runs.length,
  });
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = String(error?.stack ?? error);
  if (pageForFailure) {
    await pageForFailure.screenshot({ path: join(output, "failure.png") }).catch(() => {});
    receipt.visibleButtons = await pageForFailure
      .evaluate(() =>
        [...document.querySelectorAll("button,[role=menuitem]")]
          .map((node) => node.textContent?.trim())
          .filter(Boolean)
          .slice(0, 80),
      )
      .catch(() => []);
  }
} finally {
  await browser?.close().catch(() => {});
  child.kill("SIGTERM");
  writeFileSync(join(output, "receipt.json"), JSON.stringify(receipt, null, 2));
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: receipt.passed, output, error: receipt.error }, null, 2));
process.exit(receipt.passed ? 0 : 1);
