import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import { serverRpc } from "../studio-verify/native-proof.mjs";

NodeAssert.ok(process.versions.node.startsWith("22."));
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const out = NodePath.resolve(process.argv[2] ?? ".studio-build-evidence/workspaces");
NodeFS.mkdirSync(out, { recursive: true });
const state = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-workspaces-"));
NodeFS.mkdirSync(NodePath.join(state, "userdata"), { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(state, "userdata/settings.json"),
  JSON.stringify({ providerInstances: {} }),
);
const port = await new Promise((done, reject) => {
  const socket = NodeNet.createServer();
  socket.on("error", reject);
  socket.listen(0, "127.0.0.1", () => {
    const port = socket.address().port;
    socket.close(() => done(port));
  });
});
const origin = `http://127.0.0.1:${port}`;
const child = NodeChildProcess.spawn(
  process.execPath,
  [
    NodePath.join(root, "apps/server/dist/bin.mjs"),
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
      PATH: `${NodePath.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: state,
      CODEX_HOME: NodePath.join(state, "codex"),
      CLAUDE_CONFIG_DIR: NodePath.join(state, "claude"),
      XDG_CONFIG_HOME: NodePath.join(state, "config"),
      XDG_CACHE_HOME: NodePath.join(state, "cache"),
      LANG: "en_US.UTF-8",
      PWDEBUG: "0",
      PLAYWRIGHT_HTML_OPEN: "never",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let browser;
const receipt = {
  headless: true,
  realBuiltServer: true,
  privateHome: state,
  pid: child.pid,
  nativeTurns: 0,
  checks: [],
  screenshots: [],
};
try {
  const credential = await new Promise((done, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Private server did not become ready")), 45000);
    const observe = (chunk) => {
      output += chunk;
      const match = output.match(/(?:^|\n)Token: ([^\s]+)/);
      if (match) {
        clearTimeout(timer);
        done(match[1]);
      }
    };
    child.stdout.on("data", observe);
    child.stderr.on("data", observe);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Private server exited: ${code}`));
    });
  });
  const { chromium } = NodeModule.createRequire(import.meta.url)(
    NodePath.join(
      NodeOS.homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
    ),
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_TEST_CHROMIUM
      ? { executablePath: process.env.STUDIO_TEST_CHROMIUM }
      : {}),
  });
  let authenticatedState;
  for (const [width, theme] of [
    [1440, "dark"],
    [390, "light"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      colorScheme: theme,
      reducedMotion: "reduce",
      storageState: authenticatedState,
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem("studio:client-settings:v1"))
        localStorage.setItem(
          "studio:client-settings:v1",
          JSON.stringify({ onboardingCompletedAt: "2026-10-09T00:00:00.000Z" }),
        );
    });
    if (!authenticatedState) {
      const auth = await context.request.post(origin + "/api/auth/browser-session", {
        data: { credential },
        headers: { Origin: origin },
      });
      NodeAssert.equal(auth.status(), 200);
    }
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/settings/general");
    const workspace = page.getByRole("combobox", { name: "Default workspace", exact: true });
    await workspace.waitFor({ timeout: 15000 }).catch(async (error) => {
      NodeFS.writeFileSync(
        NodePath.join(out, "failure-page.txt"),
        (await page.locator("body").innerText()).slice(0, 12000),
      );
      await page.screenshot({
        path: NodePath.join(out, "failure.png"),
        fullPage: true,
        animations: "disabled",
      });
      throw error;
    });
    await workspace.click();
    await page.getByRole("option", { name: "Current checkout", exact: true }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Default workspace"]')
        ?.textContent?.includes("Current checkout"),
    );
    let settings;
    for (let attempt = 0; attempt < 20; attempt++) {
      settings = await serverRpc(context, origin, "server.getSettings");
      if (settings.defaultThreadEnvMode === "local") break;
      await new Promise((done) => setTimeout(done, 100));
    }
    NodeAssert.equal(settings.defaultThreadEnvMode, "local");
    await page.reload();
    await workspace.waitFor();
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="Default workspace"]')
        ?.textContent?.includes("Current checkout"),
    );
    const screenshot = NodePath.join(out, `workspaces-${width}-${theme}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: "disabled" });
    receipt.screenshots.push(screenshot);
    await page.goto(origin + "/settings/source-control");
    const refresh = page.getByRole("switch", { name: "Refresh upstreams at startup", exact: true });
    await refresh.waitFor();
    settings = await serverRpc(context, origin, "server.getSettings");
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('[aria-label="Refresh upstreams at startup"]')
          ?.getAttribute("aria-checked") === String(expected),
      settings.defaultAutoPull,
    );
    if (!settings.defaultAutoPull) await refresh.click();
    for (let attempt = 0; attempt < 20; attempt++) {
      settings = await serverRpc(context, origin, "server.getSettings");
      if (settings.defaultAutoPull === true) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    NodeAssert.equal(settings.defaultAutoPull, true);
    await page.waitForFunction(
      () =>
        document
          .querySelector('[aria-label="Refresh upstreams at startup"]')
          ?.getAttribute("aria-checked") === "true",
    );
    NodeAssert.ok(await page.getByText("Use Pull to update checkouts.", { exact: false }).count());
    NodeAssert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    NodeAssert.deepEqual(errors, []);
    const sourceControlScreenshot = NodePath.join(out, `source-control-${width}-${theme}.png`);
    await page.screenshot({
      path: sourceControlScreenshot,
      fullPage: true,
      animations: "disabled",
    });
    receipt.screenshots.push(sourceControlScreenshot);
    receipt.checks.push({
      width,
      theme,
      localChoicePersisted: true,
      truthfulRefreshCopy: true,
      refreshPreferencePersisted: true,
      pageErrors: errors,
    });
    authenticatedState = await context.storageState();
    await context.close();
  }
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  receipt.serverStopped = child.exitCode !== null || child.signalCode !== null;
  if (receipt.serverStopped) {
    NodeFS.rmSync(state, { recursive: true, force: true });
    receipt.privateHomeRemoved = true;
  }
}
NodeFS.writeFileSync(
  NodePath.join(out, "browser-receipt.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);
console.log(JSON.stringify(receipt));
