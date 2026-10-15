import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";

NodeAssert.ok(process.versions.node.startsWith("22."));
process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const root = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const out = NodePath.resolve(process.argv[2] ?? ".artifacts/project-setup-integration");
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
  screenshots: ["new-project-1440.png", "new-project-390.png", "clone-destination.png"],
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
      reject(
        new Error(
          `Private server exited: ${code} ${output.replace(/Token: [^\s]+/g, "Token: [redacted]")}`,
        ),
      );
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.addInitScript(() =>
    localStorage.setItem(
      "studio:client-settings:v1",
      JSON.stringify({ onboardingCompletedAt: "2026-10-14T00:00:00.000Z" }),
    ),
  );
  const auth = await context.request.post(origin + "/api/auth/browser-session", {
    data: { credential },
    headers: { Origin: origin },
  });
  NodeAssert.equal(auth.status(), 200);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const parent = NodePath.join(state, "Projects");
  NodeFS.mkdirSync(parent);
  const cloneSource = NodePath.join(state, "clone-fixture.git");
  NodeChildProcess.execFileSync("/usr/bin/git", ["init", "--bare", cloneSource], {
    stdio: "ignore",
  });
  try {
    await page.goto(origin);
    await page.getByText("1/1", { exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    await page.getByRole("option", { name: /^New project/ }).click();
    const dialog = page.getByTestId("command-palette");
    await page.getByText("Enter a project name at the top.", { exact: true }).waitFor();
    await dialog.getByRole("combobox", { name: "Project name" }).fill("Folder proof");
    NodeAssert.equal(await page.getByText("Project type", { exact: true }).count(), 0);
    NodeAssert.equal(
      await page.getByRole("button", { name: "Create project", exact: true }).isDisabled(),
      true,
    );
    await page.getByRole("textbox", { name: "Parent folder path", exact: true }).fill(parent);
    await page.getByRole("textbox", { name: "Parent folder path", exact: true }).press("Enter");
    await page.getByText(parent, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Use this folder", exact: true }).click();
    // Reselecting the current machine must not discard the confirmed location.
    await page.getByRole("option", { name: /This device/ }).click();
    NodeAssert.equal(
      await page.getByRole("button", { name: "Create project", exact: true }).isEnabled(),
      true,
    );
    const nameBox = dialog.getByRole("combobox", { name: "Project name" });
    // Holding Backspace past an empty name stays in New project.
    await nameBox.fill("");
    for (let press = 0; press < 3; press += 1) await nameBox.press("Backspace");
    await nameBox.fill("Folder proof");
    // Closing and reopening keeps the typed name and the chosen folder.
    await nameBox.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    await page.getByRole("option", { name: /^New project/ }).click();
    NodeAssert.equal(await nameBox.inputValue(), "Folder proof");
    NodeAssert.equal(
      await page.getByRole("button", { name: "Create project", exact: true }).isEnabled(),
      true,
    );
    for (const [width, height] of [
      [1440, 1100],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      const button = page.getByRole("button", { name: "Create project", exact: true });
      const box = await button.boundingBox();
      NodeAssert.ok(
        box && box.y >= 0 && box.y + box.height <= height,
        "Create stays inside viewport",
      );
      NodeAssert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({
        path: NodePath.join(out, `new-project-${width}.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1440, height: 1100 });
    // Returning to the name clears the machine highlight without editing it.
    await dialog.getByRole("combobox", { name: "Project name" }).click();
    await dialog.getByRole("combobox", { name: "Project name" }).press("Enter");
    await dialog.waitFor({ state: "hidden" });
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(parent, "folder-proof", ".git")));
    receipt.checks.push(
      "Name Enter creates; folder Enter only browses; same-machine selection, Backspace and reopening preserve name and parent; primary action fits desktop and mobile",
    );
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    await page.getByRole("option", { name: /^New project/ }).click();
    NodeAssert.equal(
      await dialog.getByRole("combobox", { name: "Project name" }).inputValue(),
      "",
      "A created project's name is not offered again",
    );
    await dialog.getByRole("combobox", { name: "Project name" }).fill("Keyboard button proof");
    // The folder chosen last time on this machine is offered again.
    await page.getByText(parent, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Create project", exact: true }).focus();
    await page.getByRole("button", { name: "Create project", exact: true }).press("Enter");
    await dialog.waitFor({ state: "hidden" });
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(parent, "keyboard-button-proof", ".git")));
    receipt.checks.push(
      "Remembered folder is offered again; persistent Create project button activates from keyboard Enter",
    );
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    const existing = NodePath.join(parent, "Existing project");
    NodeFS.mkdirSync(existing);
    NodeFS.writeFileSync(NodePath.join(existing, "keep.txt"), "preserved");
    await page.getByRole("option", { name: /^Local folder/ }).click();
    await page.getByRole("combobox").fill(existing + "/");
    await page.getByRole("combobox").press("Meta+Enter");
    await dialog.waitFor({ state: "hidden" });
    NodeAssert.equal(NodeFS.readFileSync(NodePath.join(existing, "keep.txt"), "utf8"), "preserved");
    receipt.checks.push("Existing folder opens without changing its contents");
    await page.getByRole("button", { name: "Add project", exact: true }).click();
    NodeAssert.equal(await page.getByText("Setup Required", { exact: true }).count(), 0);
    NodeAssert.equal(await page.getByRole("option", { name: /^Personal assistant/ }).count(), 0);
    await page.getByRole("option", { name: /^Git URL/ }).click();
    await page.getByRole("combobox").fill(cloneSource);
    await page.getByRole("combobox").press("Enter");
    await page.getByRole("region", { name: "Clone destination" }).waitFor();
    NodeAssert.equal(
      await page.getByRole("button", { name: "Clone repository", exact: true }).isDisabled(),
      true,
    );
    await page.getByRole("textbox", { name: "Parent folder path", exact: true }).fill(parent);
    await page.getByRole("button", { name: "Browse", exact: true }).click();
    await page.getByText(parent, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Use this folder", exact: true }).click();
    await page.getByText(`Clone into ${parent}/clone-fixture`, { exact: true }).waitFor();
    NodeAssert.equal(
      await page.getByRole("button", { name: "Clone repository", exact: true }).isEnabled(),
      true,
    );
    await page.screenshot({ path: NodePath.join(out, "clone-destination.png"), fullPage: true });
    receipt.checks.push(
      "Clone flow requires a validated destination before enabling Clone repository",
    );
    await page.getByRole("combobox").focus();
    await page.getByRole("combobox").press("ArrowDown");
    await page.getByRole("combobox").press("Enter");
    await page.getByRole("button", { name: "Browse", exact: true }).waitFor();
    NodeAssert.equal(
      await page.getByRole("button", { name: "Clone repository", exact: true }).isDisabled(),
      true,
    );
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(parent, "clone-fixture")), false);
    receipt.checks.push(
      "Enter on the highlighted machine resets destination without submitting a clone",
    );
    await page.getByRole("textbox", { name: "Parent folder path", exact: true }).fill(parent);
    await page.getByRole("button", { name: "Browse", exact: true }).click();
    await page.getByText(parent, { exact: true }).waitFor();
    await page.getByRole("button", { name: "Use this folder", exact: true }).click();
    await page.getByRole("button", { name: "Clone repository", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    NodeAssert.ok(NodeFS.existsSync(NodePath.join(parent, "clone-fixture", ".git")));
    NodeAssert.equal(
      NodeChildProcess.execFileSync(
        "/usr/bin/git",
        ["-C", NodePath.join(parent, "clone-fixture"), "remote", "get-url", "origin"],
        { encoding: "utf8" },
      ).trim(),
      cloneSource,
    );
    receipt.checks.push(
      "Clone repository performs a real clone of an isolated local bare repository; no external network",
    );
    await page.getByRole("button", { name: /^Personal assistant/ }).click();
    await page.getByRole("button", { name: "Create personal assistant", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: /^Personal assistant/ }).click();
    await page.waitForURL(/projects/);
    NodeAssert.equal(await dialog.count(), 0);
    receipt.checks.push(
      "Personal assistant setup reopens the existing assistant from its global entry",
    );
    NodeAssert.deepEqual(errors, []);
  } catch (error) {
    NodeFS.writeFileSync(
      NodePath.join(out, "failure-page.txt"),
      (await page.locator("body").innerText()).slice(0, 16000),
    );
    await page.screenshot({ path: NodePath.join(out, "failure.png"), fullPage: true });
    throw error;
  }
  await context.close();
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
