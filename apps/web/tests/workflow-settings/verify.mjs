import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.ok(process.versions.node.startsWith("22."), "Use Node 22");
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const out = resolve(process.argv[2] ?? join(root, ".studio-build-evidence/workflow-settings"));
mkdirSync(out, { recursive: true });
const state = mkdtempSync(join(tmpdir(), "studio-workflow-settings-"));
const fixture = join(state, "fixture");
mkdirSync(fixture);
mkdirSync(join(state, "userdata"));
writeFileSync(
  join(state, "userdata/settings.json"),
  JSON.stringify({
    providerInstances: {},
    agentInstructions: "ENV_UI_RULE",
    claudeWorkflowMode: "on-request",
  }),
);
const port = await new Promise((done, reject) => {
  const socket = createServer();
  socket.on("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const port = socket.address().port;
    socket.close(() => done(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  [
    join(root, "apps/server/dist/bin.mjs"),
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--base-dir",
    state,
    "--no-browser",
  ],
  {
    cwd: state,
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: state,
      CODEX_HOME: join(state, "codex"),
      CLAUDE_CONFIG_DIR: join(state, "claude"),
      XDG_CONFIG_HOME: join(state, "config"),
      XDG_CACHE_HOME: join(state, "cache"),
      LANG: "en_US.UTF-8",
      PWDEBUG: "0",
      PLAYWRIGHT_HTML_OPEN: "never",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const receipt = {
  headless: true,
  privateHome: state,
  pid: child.pid,
  nativeTurns: 0,
  checks: [],
  screenshots: [],
};
let browser;
let page;
async function rpc(context, tag, payload = {}) {
  assert.ok(["server.getSettings", "projects.mutate"].includes(tag));
  if (tag === "projects.mutate") {
    assert.equal(payload.type, "project.create");
    assert.equal(payload.workspaceRoot, fixture);
  }
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
  return new Promise((done, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("Fixture RPC timeout"));
    }, 15000);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] })),
    );
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Fixture RPC failed"));
    });
    ws.addEventListener("message", (event) => {
      let value;
      try {
        value = JSON.parse(event.data);
      } catch {
        return;
      }
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item._tag !== "Exit" || String(item.requestId) !== "1") continue;
        clearTimeout(timer);
        ws.close();
        item.exit?._tag === "Success"
          ? done(item.exit.value)
          : reject(new Error(`Fixture RPC rejected ${tag}`));
      }
    });
  });
}
async function waitSettings(context, predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const settings = await rpc(context, "server.getSettings");
    if (predicate(settings)) return settings;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Settings did not persist");
}
try {
  const credential = await new Promise((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Private server did not start")), 45000);
    const observe = (chunk) => {
      output += chunk;
      const match = output.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
        output = "";
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Private server exited"));
    });
  });
  // The repo pins playwright-core in apps/server; STUDIO_TEST_PLAYWRIGHT may name another install.
  const { chromium } = process.env.STUDIO_TEST_PLAYWRIGHT
    ? createRequire(import.meta.url)(process.env.STUDIO_TEST_PLAYWRIGHT)
    : createRequire(join(root, "apps/server/package.json"))("playwright-core");
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
  await context.addInitScript(() =>
    localStorage.setItem(
      "studio:client-settings:v1",
      JSON.stringify({ onboardingCompletedAt: "2026-10-09T00:00:00Z" }),
    ),
  );
  const auth = await context.request.post(origin + "/api/auth/browser-session", {
    data: { credential },
    headers: { Origin: origin },
  });
  assert.equal(auth.status(), 200);
  const projectId = randomUUID();
  await rpc(context, "projects.mutate", {
    type: "project.create",
    commandId: randomUUID(),
    projectId,
    title: "Workflow fixture",
    workspaceRoot: fixture,
    defaultModelSelection: null,
  });
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin + "/settings/agents");
  const globalEditor = page.getByRole("textbox", { name: "Global instructions", exact: true });
  await globalEditor.waitFor();
  await globalEditor.fill("ENV_UI_RULE_SAVED");
  await globalEditor.blur();
  await waitSettings(context, (settings) => settings.agentInstructions === "ENV_UI_RULE_SAVED");
  const mode = page.getByRole("combobox", { name: "Claude workflow mode", exact: true });
  await mode.click();
  await page.getByRole("option", { name: "Automatic", exact: true }).click();
  await waitSettings(context, (settings) => settings.claudeWorkflowMode === "automatic");
  receipt.checks.push("global instructions and independent workflow policy persist");
  const style = page.getByRole("combobox", { name: "Response style", exact: true });
  assert.equal((await rpc(context, "server.getSettings")).responseStyle, "concise");
  assert.match(await style.innerText(), /Concise/);
  await style.click();
  await page.getByRole("option", { name: "Detailed", exact: true }).click();
  await waitSettings(context, (settings) => settings.responseStyle === "detailed");
  receipt.checks.push("response style defaults to concise and a global detailed choice persists");
  await page.getByRole("button", { name: "Project scope: All projects", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Workflow fixture", exact: true }).click();
  const projectEditor = page.getByRole("textbox", { name: "Project instructions", exact: true });
  await projectEditor.waitFor();
  assert.equal(await projectEditor.inputValue(), "");
  await projectEditor.fill("PROJECT_UI_RULE");
  await projectEditor.blur();
  let settings = await waitSettings(
    context,
    (settings) =>
      settings.projectSettingsOverrides[projectId]?.agentInstructions === "PROJECT_UI_RULE",
  );
  assert.equal(settings.agentInstructions, "ENV_UI_RULE_SAVED");
  await mode.click();
  await page.getByRole("option", { name: "Disabled", exact: true }).click();
  settings = await waitSettings(
    context,
    (settings) => settings.projectSettingsOverrides[projectId]?.claudeWorkflowMode === "disabled",
  );
  assert.equal(settings.claudeWorkflowMode, "automatic");
  await style.click();
  await page.getByRole("option", { name: "Concise", exact: true }).click();
  settings = await waitSettings(
    context,
    (settings) => settings.projectSettingsOverrides[projectId]?.responseStyle === "concise",
  );
  assert.equal(settings.responseStyle, "detailed");
  receipt.checks.push("a project response style overrides the global one without changing it");
  await page.getByText("Effective instructions preview", { exact: true }).click();
  const preview = page.locator("pre");
  assert.match(await preview.innerText(), /ENV_UI_RULE_SAVED/);
  assert.match(await preview.innerText(), /PROJECT_UI_RULE/);
  receipt.checks.push(
    "project additions preserve global context and workflow overrides preserve defaults",
  );
  await page.reload();
  await projectEditor.waitFor();
  assert.equal(await projectEditor.inputValue(), "PROJECT_UI_RULE");
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByText("Effective instructions preview", { exact: true }).click();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const screenshot = join(out, `agents-${width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    receipt.screenshots.push(screenshot);
    if (width === 1440)
      await page.getByText("Effective instructions preview", { exact: true }).click();
  }
  assert.deepEqual(errors, []);
  receipt.checks.push(
    "saved context survives reload at desktop and phone widths without page errors or horizontal overflow",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole("button", { name: "Reset Project instructions to default", exact: true })
    .click();
  settings = await waitSettings(
    context,
    (settings) => settings.projectSettingsOverrides[projectId]?.agentInstructions === undefined,
  );
  assert.equal(settings.agentInstructions, "ENV_UI_RULE_SAVED");
  await page
    .getByRole("button", { name: "Reset Claude workflow mode to default", exact: true })
    .click();
  settings = await waitSettings(
    context,
    (settings) => settings.projectSettingsOverrides[projectId]?.claudeWorkflowMode === undefined,
  );
  assert.equal(settings.claudeWorkflowMode, "automatic");
  await page.getByRole("button", { name: "Reset Response style to default", exact: true }).click();
  settings = await waitSettings(
    context,
    (settings) => settings.projectSettingsOverrides[projectId]?.responseStyle === undefined,
  );
  assert.equal(settings.responseStyle, "detailed");
  await page.getByRole("combobox", { name: "Search settings", exact: true }).fill("ultracode");
  await page.locator("#settings-search-result-claude-workflow-mode").click();
  await mode.waitFor();
  assert.equal(await projectEditor.inputValue(), "");
  await page.getByRole("combobox", { name: "Search settings", exact: true }).fill("worker reports");
  await page.locator("#settings-search-result-response-style").click();
  await style.waitFor();
  assert.deepEqual(errors, []);
  receipt.checks.push(
    "reset removes only project additions, workflow and response style overrides; settings search opens both scoped controls",
  );
} catch (error) {
  receipt.failure = error.message;
  if (page) {
    writeFileSync(
      join(out, "failure-page.txt"),
      (await page.locator("body").innerText()).slice(0, 16000),
    );
    await page.screenshot({
      path: join(out, "failure.png"),
      fullPage: true,
      animations: "disabled",
    });
  }
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([
    new Promise((done) => child.once("exit", done)),
    new Promise((done) => setTimeout(done, 3000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  writeFileSync(join(out, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
    mode: 0o600,
  });
}
console.log(JSON.stringify({ checksPassed: receipt.checks.length, headless: true, out }));
